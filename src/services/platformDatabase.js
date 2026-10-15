// Moving the platform database to another engine or server (provider console → Databases): every table is created on
// the target from the schema catalog, every row is copied, the migration history comes along, and the server switches
// to the new database without a restart. The old database is left untouched (a fallback), and its connection is kept
// in data/config.json as previousDatabase. While the copy runs, the workspaces answer "maintenance" (no writes get lost).
import { readConfig, writeConfig } from "../config/store.js";
import { createKnex, getPlatformDb, initDb, readVersion, testConnection } from "../db/connection.js";
import { describeDatabase, familyOf } from "../db/dialects.js";
import { createMigrationTables, creationOrder, existingTables, getCatalog, syncTables } from "../db/schemaCatalog.js";
import { closeAllTenantPools, loadRegistry, syncAllTenantDatabases } from "./tenantDatabases.js";

let switching = null;

/** Set while the platform database is being copied: the API pauses workspaces (middleware/errors.js requireSetup). */
export const platformSwitchInProgress = () => switching;

const BATCH = 500;

/** Rows of one table from the source, in primary-key order, a batch at a time. */
async function* readRows(source, table) {
  const key = table.columns.some(column => column.kind === "increments") ? ["id"] : table.primary.length ? table.primary : [table.columns[0].name];
  let offset = 0;
  for (;;) {
    const query = source(table.name).select(table.columns.map(column => column.name));
    for (const column of key) query.orderBy(column);
    const rows = await query.limit(BATCH).offset(offset);
    if (!rows.length) return;
    yield rows;
    offset += rows.length;
    if (rows.length < BATCH) return;
  }
}

async function dropCopiedTables(target) {
  const catalog = await getCatalog();
  const family = familyOf(target);
  if (family === "mysql") await target.raw("SET FOREIGN_KEY_CHECKS = 0");
  if (family === "sqlite") await target.raw("PRAGMA foreign_keys = OFF");
  for (const name of [...creationOrder(catalog, [...catalog.keys()]).reverse(), "knex_migrations", "knex_migrations_lock"]) {
    if (family === "postgres") await target.raw("drop table if exists ?? cascade", [name]);
    else await target.schema.dropTableIfExists(name);
  }
  if (family === "mysql") await target.raw("SET FOREIGN_KEY_CHECKS = 1");
}

/** Values as the target engine takes them (booleans as booleans, numbers stay numbers). */
function normalize(table, row) {
  const out = {};
  for (const column of table.columns) {
    let value = row[column.name];
    if (value === undefined) value = null;
    if (column.kind === "boolean" && value !== null) value = value === true || value === 1 || value === "1" || value === "t" || value === "true";
    out[column.name] = value;
  }
  return out;
}

/**
 * Copies the platform database to `config` and switches to it. Refuses a target that already holds TaskFlow tables.
 * @returns {Promise<{ version: string, tables: number, rows: number, from: string, to: string }>}
 */
export async function switchPlatformDatabase(config, { createDatabase = true, actor = "console" } = {}) {
  if (switching) throw Object.assign(new Error("A database switch is already running."), { code: "SWITCH_RUNNING" });
  const current = readConfig();
  if (JSON.stringify(current.database) === JSON.stringify(config)) throw Object.assign(new Error("That is the database in use now."), { code: "SAME_DATABASE" });
  switching = { startedAt: new Date().toISOString(), to: describeDatabase(config) };
  const source = getPlatformDb();
  let target;
  try {
    const probe = await testConnection(config, { createDatabase });
    target = createKnex(config, { pool: { min: 1, max: 1 } });
    const catalog = await getCatalog();
    const present = await existingTables(target);
    const clash = [...present].filter(name => catalog.has(name) || name === "knex_migrations");
    if (clash.length) throw Object.assign(new Error(`The target database already has TaskFlow tables (${clash.slice(0, 4).join(", ")}${clash.length > 4 ? ", …" : ""}). Use an empty database.`), { code: "NOT_EMPTY" });

    const names = [...catalog.keys()];
    await syncTables(target, names);
    const family = familyOf(target);
    let rows = 0;
    // One connection (pool max 1): foreign-key checks can be relaxed for the copy where the engine allows it.
    if (family === "mysql") await target.raw("SET FOREIGN_KEY_CHECKS = 0");
    if (family === "sqlite") await target.raw("PRAGMA foreign_keys = OFF");
    try {
      for (const name of creationOrder(catalog, names)) {
        const table = catalog.get(name);
        const chunk = Math.max(1, Math.floor(800 / table.columns.length));
        for await (const batch of readRows(source, table)) {
          const values = batch.map(row => normalize(table, row));
          for (let start = 0; start < values.length; start += chunk) await target(name).insert(values.slice(start, start + chunk));
          rows += batch.length;
        }
      }
    } finally {
      if (family === "mysql") await target.raw("SET FOREIGN_KEY_CHECKS = 1");
      if (family === "sqlite") await target.raw("PRAGMA foreign_keys = ON");
    }

    // Ids continue after the copied rows (PostgreSQL sequences; MySQL and SQLite follow the highest id by themselves).
    if (family === "postgres") {
      for (const table of catalog.values()) {
        if (!table.columns.some(column => column.kind === "increments")) continue;
        await target.raw(`select setval(pg_get_serial_sequence(?, 'id'), coalesce((select max(id) from ??), 0) + 1, false)`, [table.name, table.name]);
      }
    }

    // The migration history, so the new database counts as up to date.
    await createMigrationTables(target);
    const history = await source("knex_migrations").select("name", "batch", "migration_time").orderBy("id");
    for (const entry of history) {
      const time = entry.migration_time ? new Date(typeof entry.migration_time === "number" ? entry.migration_time : String(entry.migration_time)) : new Date();
      await target("knex_migrations").insert({ name: entry.name, batch: entry.batch, migration_time: Number.isNaN(time.getTime()) ? new Date() : time });
    }

    // Every table arrived complete.
    for (const name of names) {
      const [a] = await source(name).count({ count: "*" });
      const [b] = await target(name).count({ count: "*" });
      if (Number(a.count) !== Number(b.count)) throw Object.assign(new Error(`Copy check failed for ${name}: ${a.count} rows here, ${b.count} there.`), { code: "COPY_MISMATCH" });
    }
    await target.destroy();
    target = null;

    // Switch: the new connection is saved and opened; the old one is kept in config as a fallback.
    writeConfig({ ...current, database: config, previousDatabase: current.database, databaseSwitchedAt: new Date().toISOString(), databaseSwitchedBy: actor });
    await closeAllTenantPools();
    const db = await initDb(config);
    await loadRegistry(db);
    await syncAllTenantDatabases();
    return { version: probe.version || (await readVersion(db, config.client)), tables: names.length, rows, from: describeDatabase(current.database), to: describeDatabase(config) };
  } catch (error) {
    // Leave the target as it was found: drop what this attempt created (best effort; the platform keeps running as before).
    if (target && error.code !== "NOT_EMPTY") await dropCopiedTables(target).catch(problem => console.error("[platform-db] cleanup failed:", problem.message));
    throw error;
  } finally {
    if (target) await target.destroy().catch(() => {});
    switching = null;
  }
}
