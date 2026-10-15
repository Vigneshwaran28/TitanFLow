// A portable dump of one tenant's rows (for the standalone app export) and its import into a fresh database.
// The schema is read from the database itself (tables, columns, foreign keys), so tables added by later migrations
// are included without changes here: a table belongs to a tenant through its tenant_id column, or through a foreign
// key to a table that does (lists -> users -> tenants). Rows keep their ids, so links between them stay intact.
import { familyOf } from "../db/dialects.js";
import { migrationSource } from "../db/migrations.js";
import { existingTables, getCatalog } from "../db/schemaCatalog.js";

export const EXPORT_FORMAT = "taskflow-tenant-export";
export const EXPORT_FORMAT_VERSION = 1;

/** Provider-level tables and secrets that never leave the platform. */
const EXCLUDED = new Map([
  ["knex_migrations", "migration bookkeeping"],
  ["knex_migrations_lock", "migration bookkeeping"],
  ["admin_audit", "provider console log"],
  ["platform_settings", "platform maintenance"],
  ["provider_broadcasts", "provider announcements"],
  ["provider_broadcast_targets", "provider announcements"],
  ["provider_broadcast_reads", "provider announcements"],
  ["subscription_notices", "provider subscription notices"],
  ["password_resets", "one-time password links"],
]);
/** Sign-in sessions, one-time codes, and tokens (for tables later modules may add). */
const SECRET_TABLE = /(^|_)(sessions?|otps?|password_resets?|login_codes?|magic_links?|tokens?)$/i;

const quote = name => `"${String(name).replace(/"/g, '""')}"`;

/** The latest migration this code knows: the export's schema version. */
export async function latestMigration() {
  const names = await migrationSource.getMigrations();
  return names[names.length - 1];
}

/**
 * Tables, their columns, primary key, and foreign keys, read from the database.
 * @returns {Promise<Map<string, { name: string, columns: string[], primaryKey: string[], serialId: boolean, fks: { column: string, table: string, refColumn: string, notNull: boolean }[] }>>}
 */
export async function describeSchema(db) {
  const tables = new Map();
  // MySQL / MariaDB: the schema catalog (the same tables and keys the migrations make), for the tables this database has.
  if (familyOf(db) === "mysql") {
    const [catalog, present] = await Promise.all([getCatalog(), existingTables(db)]);
    for (const table of catalog.values()) {
      if (!present.has(table.name)) continue;
      const serial = table.columns.some(column => column.kind === "increments");
      const notNull = new Set(table.columns.filter(column => !column.nullable).map(column => column.name));
      tables.set(table.name, {
        name: table.name,
        columns: table.columns.map(column => column.name),
        primaryKey: serial ? ["id"] : table.primary,
        serialId: serial,
        fks: table.foreignKeys.map(fk => ({ column: fk.columns[0], table: fk.table, refColumn: fk.references[0] ?? "id", notNull: notNull.has(fk.columns[0]) })),
      });
    }
    return tables;
  }
  if (db.client.dialect === "sqlite3") {
    const names = (await db.raw("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")).map(row => row.name);
    for (const name of names) {
      const info = await db.raw(`pragma table_info(${quote(name)})`);
      const fkRows = await db.raw(`pragma foreign_key_list(${quote(name)})`);
      const notNull = new Set(info.filter(column => column.notnull).map(column => column.name));
      const primaryKey = info.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
      tables.set(name, {
        name,
        columns: info.map(column => column.name),
        primaryKey,
        serialId: primaryKey.length === 1 && primaryKey[0] === "id",
        fks: fkRows.map(fk => ({ column: fk.from, table: fk.table, refColumn: fk.to ?? "id", notNull: notNull.has(fk.from) })),
      });
    }
    return tables;
  }

  const columnRows = (
    await db.raw(
      `select table_name, column_name, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name in (select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE')
       order by table_name, ordinal_position`
    )
  ).rows;
  const constraintRows = (
    await db.raw(
      `select tc.table_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position, ccu.table_name as ref_table, ccu.column_name as ref_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       left join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema and tc.constraint_type = 'FOREIGN KEY'
       where tc.table_schema = current_schema() and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')
       order by tc.table_name, kcu.ordinal_position`
    )
  ).rows;
  for (const row of columnRows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, { name: row.table_name, columns: [], primaryKey: [], serialId: false, fks: [], notNull: new Set() });
    const table = tables.get(row.table_name);
    table.columns.push(row.column_name);
    if (row.is_nullable === "NO") table.notNull.add(row.column_name);
    if (row.column_name === "id" && String(row.column_default ?? "").startsWith("nextval(")) table.serialId = true;
  }
  for (const row of constraintRows) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    if (row.constraint_type === "PRIMARY KEY") table.primaryKey.push(row.column_name);
    else table.fks.push({ column: row.column_name, table: row.ref_table, refColumn: row.ref_column ?? "id", notNull: table.notNull.has(row.column_name) });
  }
  for (const table of tables.values()) delete table.notNull;
  return tables;
}

/**
 * How each table's rows belong to a tenant. Returns { scoped: Map<name, scope>, skipped: [{ name, reason }] } where
 * scope is { column } (a tenant id column) or { links: [{ column, table, refColumn }] } (any non-null link into a
 * tenant-owned parent row).
 */
export function tenantScopes(schema) {
  const scoped = new Map();
  const skipped = [];
  const resolving = new Set();

  const resolve = name => {
    if (scoped.has(name)) return scoped.get(name);
    if (resolving.has(name)) return null; // cycle
    const table = schema.get(name);
    if (!table || EXCLUDED.has(name) || SECRET_TABLE.test(name)) return null;
    let scope = null;
    if (name === "tenants") scope = { column: "id" };
    else if (table.columns.includes("tenant_id")) scope = { column: "tenant_id" };
    else {
      resolving.add(name);
      const links = table.fks.filter(fk => fk.table !== name && fk.table !== "tenants" && resolve(fk.table));
      resolving.delete(name);
      // A required link decides alone; otherwise any of the optional ones.
      const required = links.find(fk => fk.notNull);
      if (required) scope = { links: [required] };
      else if (links.length) scope = { links };
    }
    if (scope) scoped.set(name, scope);
    return scope;
  };

  for (const name of [...schema.keys()].sort()) {
    if (resolve(name)) continue;
    const reason = EXCLUDED.get(name) ?? (SECRET_TABLE.test(name) ? "sign-in secrets" : "not linked to a tenant");
    skipped.push({ name, reason });
  }
  return { scoped, skipped };
}

/** Adds the tenant filter of `name` to a query (subqueries follow the links up to the tenant). */
function applyScope(db, query, name, scopes, tenantId, alias = name) {
  const scope = scopes.get(name);
  if (scope.column) return query.where(`${alias}.${scope.column}`, tenantId);
  return query.where(inner => {
    for (const link of scope.links) {
      inner.orWhereIn(`${alias}.${link.column}`, sub => applyScope(db, sub.select(`${link.table}.${link.refColumn}`).from(link.table), link.table, scopes, tenantId));
    }
  });
}

/** Tables in an order where every parent comes before its children (self-references are handled separately). */
function insertOrder(schema, names) {
  const set = new Set(names);
  const deps = new Map(names.map(name => [name, new Set(schema.get(name).fks.map(fk => fk.table).filter(table => table !== name && set.has(table)))]));
  const order = [];
  const done = new Set();
  while (order.length < names.length) {
    const ready = names.filter(name => !done.has(name) && [...deps.get(name)].every(dep => done.has(dep)));
    // A cycle between tables (none today): keep going; those links are filled in after every insert.
    const next = ready.length ? ready : [names.find(name => !done.has(name))];
    for (const name of next) {
      done.add(name);
      order.push(name);
    }
  }
  return order;
}

/** JSON-safe cell values (binary as base64, big integers as numbers or strings). */
function toJsonValue(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return { $base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return value.toISOString();
  return value;
}
const fromJsonValue = value => (value && typeof value === "object" && typeof value.$base64 === "string" ? Buffer.from(value.$base64, "base64") : value);

/**
 * Every row of one tenant, table by table in insert order.
 * @returns {Promise<Object>} the export document (data/tenant-export.json)
 */
export async function exportTenantData(db, tenantId, { sourceVersion = "unknown" } = {}) {
  const schema = await describeSchema(db);
  const { scoped, skipped } = tenantScopes(schema);
  const order = insertOrder(schema, [...scoped.keys()]);
  const tables = [];
  for (const name of order) {
    const { columns, primaryKey } = schema.get(name);
    const query = applyScope(db, db(name).select(columns.map(column => `${name}.${column}`)), name, scoped, tenantId);
    for (const key of primaryKey.length ? primaryKey : columns.slice(0, 1)) query.orderBy(`${name}.${key}`);
    const rows = await query;
    tables.push({ name, columns, rows: rows.map(row => columns.map(column => toJsonValue(row[column]))) });
  }
  const tenant = await db("tenants").where({ id: tenantId }).first("id", "slug", "name");
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: await latestMigration(),
    exportedAt: new Date().toISOString(),
    sourceVersion,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    counts: Object.fromEntries(tables.map(table => [table.name, table.rows.length])),
    skippedTables: skipped,
    tables,
  };
}

/** True when the database holds no tenant and no account (a fresh install). */
export async function isEmptyDatabase(db) {
  const [{ tenants }] = await db("tenants").count({ tenants: "*" });
  const [{ users }] = await db("users").count({ users: "*" });
  return Number(tenants) === 0 && Number(users) === 0;
}

/**
 * Imports an export into a database that has just been migrated and holds nothing yet. One transaction: either
 * every row goes in, or none. `adjustTenant` may change the tenant row before it is written.
 * @returns {Promise<Record<string, number>>} rows imported per table
 */
export async function importTenantData(db, document, { adjustTenant = row => row } = {}) {
  if (document?.format !== EXPORT_FORMAT || !Array.isArray(document.tables)) throw Object.assign(new Error("This file is not a TaskFlow tenant export."), { code: "IMPORT_INVALID" });
  if (Number(document.formatVersion) > EXPORT_FORMAT_VERSION) throw Object.assign(new Error("This export was made by a newer TaskFlow. Update this app first."), { code: "IMPORT_TOO_NEW" });
  const known = await migrationSource.getMigrations();
  if (document.schemaVersion && !known.includes(document.schemaVersion)) {
    throw Object.assign(new Error(`This export needs database version ${document.schemaVersion}, which this app doesn't have. Use the app that came with the export.`), { code: "IMPORT_TOO_NEW" });
  }
  if (!(await isEmptyDatabase(db))) {
    throw Object.assign(new Error("This database already contains TaskFlow data. Importing needs an empty database: choose a new SQLite file name or an empty PostgreSQL database."), { code: "DATABASE_NOT_EMPTY" });
  }

  const schema = await describeSchema(db);
  const postgres = familyOf(db) === "postgres";
  const imported = {};
  await db.transaction(async trx => {
    const deferred = []; // [table, keyColumns, column, rows] links filled in once every row exists
    const present = new Set();
    for (const table of document.tables) {
      const target = schema.get(table.name);
      if (!target) {
        if (table.rows.length) throw Object.assign(new Error(`This database has no "${table.name}" table. Use the app that came with the export.`), { code: "IMPORT_SCHEMA" });
        continue;
      }
      const columns = table.columns.filter(column => target.columns.includes(column));
      // Links to rows that come later (the same table, or a cycle) are written as null first, then updated.
      const late = target.fks.filter(fk => columns.includes(fk.column) && (fk.table === table.name || !present.has(fk.table)) && schema.has(fk.table) && document.tables.some(other => other.name === fk.table));
      const lateColumns = new Set(late.filter(fk => !fk.notNull).map(fk => fk.column));
      const keyColumns = target.primaryKey.length ? target.primaryKey : ["id"];
      const rows = table.rows.map(values => {
        const row = {};
        table.columns.forEach((column, index) => {
          if (columns.includes(column)) row[column] = fromJsonValue(values[index]);
        });
        return table.name === "tenants" ? adjustTenant(row) : row;
      });
      for (const column of lateColumns) {
        const updates = rows.filter(row => row[column] != null).map(row => ({ key: Object.fromEntries(keyColumns.map(key => [key, row[key]])), value: row[column] }));
        if (updates.length) deferred.push({ table: table.name, column, updates });
        rows.forEach(row => (row[column] = null));
      }
      const chunk = Math.max(1, Math.floor(900 / Math.max(1, columns.length)));
      for (let start = 0; start < rows.length; start += chunk) await trx(table.name).insert(rows.slice(start, start + chunk));
      imported[table.name] = rows.length;
      present.add(table.name);
    }
    for (const { table, column, updates } of deferred) {
      for (const { key, value } of updates) await trx(table).where(key).update({ [column]: value });
    }
    // PostgreSQL: rows went in with their ids, so move each id sequence past the highest one.
    if (postgres) {
      for (const name of Object.keys(imported)) {
        if (!schema.get(name).serialId) continue;
        await trx.raw(`select setval(pg_get_serial_sequence(?, 'id'), coalesce((select max(id) from ${quote(name)}), 0) + 1, false)`, [name]);
      }
    }
  });
  return imported;
}
