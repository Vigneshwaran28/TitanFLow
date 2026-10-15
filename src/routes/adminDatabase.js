// Provider console → Databases (mounted by admin.js at /api/bunny/databases, behind requireAdmin).
//   GET  /                  the platform database, the engines this server supports, and every tenant's database
//   POST /test              try a connection (optionally creating the database)
//   POST /platform/switch   copy the platform database to another engine or server and switch to it
//   GET  /schema            which tables each module brings and how they link (for the tenant form)
//   GET  /tenants/:id       one tenant's database: where it is, its tables, what is missing
import { Router } from "express";
import { z } from "zod";
import { readConfig } from "../config/store.js";
import { getPlatformDb, readVersion, testConnection } from "../db/connection.js";
import { describeConnectionError, describeDatabase, ENGINES, publicDatabaseConfig } from "../db/dialects.js";
import { describeTables, getCatalog } from "../db/schemaCatalog.js";
import { platformSwitchInProgress, switchPlatformDatabase } from "../services/platformDatabase.js";
import { CORE_TABLES, databaseSummary, MODULE_TABLES, parseStoredDatabase, PLATFORM_TABLES, tablesForFeatures, validateDatabaseInput } from "../services/tenantDatabases.js";
import { FEATURES, parseFeatures } from "../services/tenants.js";
import { HttpError, parseId, validate } from "../utils/http.js";

const testSchema = z.object({ config: z.record(z.string(), z.unknown()), createDatabase: z.boolean().default(false), tenantId: z.number().int().positive().optional() });
const switchSchema = z.object({ config: z.record(z.string(), z.unknown()), createDatabase: z.boolean().default(true), confirm: z.literal("SWITCH", { error: "Type SWITCH to confirm." }) });

/** Is the driver of an engine installed on this server? */
async function driverReady(engine) {
  if (engine.driver === "node:sqlite") return true;
  try {
    await import(engine.driver);
    return true;
  } catch {
    return false;
  }
}

/** Connection failures as a 422 the console's form shows next to the fields. */
function connectionProblem(error) {
  if (error instanceof HttpError) return error;
  const message = describeConnectionError(error);
  return new HttpError(422, message, { code: error.code === "NOT_EMPTY" ? "NOT_EMPTY" : "DATABASE_UNAVAILABLE", errors: { database: message } });
}

/** @param {{ requireAdmin: import("express").RequestHandler, audit: Function }} deps */
export function consoleDatabaseRouter({ requireAdmin, audit }) {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res) => {
    const db = getPlatformDb();
    const config = readConfig();
    let version = null;
    try {
      version = await readVersion(db, config.database.client);
    } catch (error) {
      version = `unknown (${error.message})`;
    }
    const engines = await Promise.all(Object.entries(ENGINES).map(async ([key, engine]) => ({ key, label: engine.label, defaultPort: engine.defaultPort, note: engine.note, available: await driverReady(engine) })));
    const tenants = await db("tenants").orderBy("name").select("id", "name", "slug", "database", "deleted_at");
    res.json({
      platform: {
        config: publicDatabaseConfig(config.database),
        label: describeDatabase(config.database),
        version,
        previous: config.previousDatabase ? describeDatabase(config.previousDatabase) : null,
        switchedAt: config.databaseSwitchedAt ?? null,
        switching: platformSwitchInProgress(),
      },
      engines,
      tenants: tenants.map(row => {
        const own = parseStoredDatabase(row.database);
        return { id: row.id, name: row.name, slug: row.slug, deleted: Boolean(row.deleted_at), mode: own ? "dedicated" : "platform", label: own ? describeDatabase(own) : "Platform database", client: own?.client ?? config.database.client };
      }),
    });
  });

  router.post("/test", async (req, res) => {
    const input = validate(testSchema, req.body ?? {});
    // A tenant's saved connection: an empty password field keeps the saved password.
    let previous = null;
    if (input.tenantId) previous = parseStoredDatabase((await getPlatformDb()("tenants").where({ id: input.tenantId }).first("database"))?.database);
    const config = validateDatabaseInput(input.config, previous);
    try {
      const result = await testConnection(config, { createDatabase: input.createDatabase });
      res.json({ ok: true, version: result.version, createdDatabase: result.createdDatabase, label: describeDatabase(config) });
    } catch (error) {
      throw connectionProblem(error);
    }
  });

  router.post("/platform/switch", async (req, res) => {
    const input = validate(switchSchema, req.body ?? {});
    const current = readConfig().database;
    const config = validateDatabaseInput(input.config, current);
    try {
      const result = await switchPlatformDatabase(config, { createDatabase: input.createDatabase, actor: req.admin.username });
      await audit(req, "switch_database", "platform", { from: result.from, to: result.to, tables: result.tables, rows: result.rows });
      res.json(result);
    } catch (error) {
      await audit(req, "switch_database_failed", "platform", { to: describeDatabase(config), error: String(error.message).slice(0, 300) });
      if (error.code === "SWITCH_RUNNING") throw new HttpError(409, error.message, { code: error.code });
      if (error.code === "SAME_DATABASE") throw new HttpError(422, error.message, { code: error.code, errors: { database: error.message } });
      if (error.code === "COPY_MISMATCH") throw new HttpError(500, error.message, { code: error.code });
      throw connectionProblem(error);
    }
  });

  // Which tables each module brings, with their links, so the tenant form can show what a choice of modules creates.
  router.get("/schema", async (req, res) => {
    const catalog = await getCatalog();
    const all = [...new Set([...CORE_TABLES, ...Object.values(MODULE_TABLES).flat()])];
    res.set("Cache-Control", "private, max-age=300");
    res.json({
      core: CORE_TABLES.filter(name => catalog.has(name)),
      platform: PLATFORM_TABLES,
      modules: Object.fromEntries(FEATURES.map(key => [key, (MODULE_TABLES[key] ?? []).filter(name => catalog.has(name))])),
      tables: await describeTables(all),
    });
  });

  router.get("/tenants/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const row = await getPlatformDb()("tenants").where({ id }).first("id", "features");
    if (!row) throw new HttpError(404, "Tenant not found.");
    const features = parseFeatures(row.features);
    const summary = await databaseSummary(id, features);
    res.json({ ...summary, relations: await describeTables(summary.tables ?? tablesForFeatures(features)) });
  });

  return router;
}
