// Dedicated tenant databases. A tenant either lives in the platform database (the default) or in a database of its own
// on any supported engine (SQLite, PostgreSQL, MySQL, MariaDB), chosen when the provider creates it.
//
// The platform database stays the registry: tenants.database holds the connection (the password encrypted with the
// install's secret). A dedicated database has the core workspace tables plus the tables of the tenant's licensed modules
// (MODULE_TABLES), all with the same columns as the platform schema (db/schemaCatalog.js), and a mirror of the tenant's
// own row in its `tenants` table, so the app's queries work unchanged there. Requests are routed by workspace
// (middleware/tenantDatabase.js); jobs visit every database with forEachDatabase().
import crypto from "node:crypto";
import { readConfig } from "../config/store.js";
import { createKnex, getPlatformDb, isDbReady, testConnection } from "../db/connection.js";
import { PLATFORM_KEY, runWithDatabase } from "../db/context.js";
import { databaseSchema, describeDatabase, publicDatabaseConfig } from "../db/dialects.js";
import { existingTables, getCatalog, syncTables } from "../db/schemaCatalog.js";
import { HttpError } from "../utils/http.js";

/** Tables every workspace has, whatever its modules: people, roles, notifications, audit, and the inbox state. */
export const CORE_TABLES = Object.freeze(["tenants", "tenant_access_codes", "users", "roles", "user_roles", "teams", "team_members", "notifications", "tenant_audit", "password_resets", "celebration_notices", "provider_broadcast_reads", "access_rules", "access_rule_users", "meetings", "meeting_participants"]);

/**
 * The tables each module brings. Shared tables are listed under every module that reads them: billing invoices sales
 * orders and picks inventory products; logistics books orders for customers; the clinic closes on attendance holidays.
 */
export const MODULE_TABLES = Object.freeze({
  tasks: ["lists", "tasks"],
  helpdesk: ["tickets", "ticket_comments", "ticket_events"],
  directory: [],
  messaging: ["conversations", "conversation_members", "messages"],
  announcements: ["announcements", "announcement_reads", "announcement_roles"],
  inventory: ["products", "stock_movements"],
  sales: ["customers", "deals", "orders", "order_items", "products"],
  billing: ["invoices", "invoice_items", "invoice_payments", "customers", "products", "orders", "order_items"],
  logistics: ["carriers", "vehicles", "shipments", "shipment_events", "customers", "orders", "order_items"],
  attendance: ["attendance_records", "leave_requests", "holidays", "holiday_selections"],
  expenses: ["expenses"],
  clinic: ["clinic_providers", "patients", "appointments", "clinic_visits", "prescriptions", "holidays", "holiday_selections"],
  notes: ["notes", "note_shares", "note_positions", "note_boards"],
});

/** Provider-only tables: they stay in the platform database. */
export const PLATFORM_TABLES = Object.freeze(["admin_audit", "platform_settings", "provider_broadcasts", "provider_broadcast_targets", "subscription_notices"]);

/** Every table a workspace with these modules needs, core first. */
export function tablesForFeatures(features) {
  const names = new Set(CORE_TABLES);
  for (const feature of features ?? []) for (const table of MODULE_TABLES[feature] ?? []) names.add(table);
  return [...names];
}

/** For the console: which module brings each table (core tables: "workspace"). */
export function tableModules(features) {
  const owners = new Map(CORE_TABLES.map(name => [name, ["workspace"]]));
  for (const feature of features ?? []) {
    for (const table of MODULE_TABLES[feature] ?? []) owners.set(table, [...(owners.get(table) ?? []).filter(owner => owner !== "workspace"), feature]);
  }
  return owners;
}

// ---- Secrets: database passwords are stored encrypted with a key derived from the install's JWT secret ----
const keyOf = () => crypto.createHash("sha256").update(`taskflow-tenant-db:${readConfig()?.jwtSecret ?? ""}`).digest();

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

function decrypt(value) {
  if (!value || !String(value).startsWith("enc:v1:")) return value ?? "";
  const raw = Buffer.from(String(value).slice(7), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyOf(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** The JSON stored in tenants.database for a connection (null: the platform database). */
export function storedDatabase(config) {
  if (!config) return null;
  return JSON.stringify(config.client === "sqlite" ? config : { ...config, password: encrypt(config.password) });
}

/** The connection a tenants.database value describes, or null. */
export function parseStoredDatabase(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed?.client) return null;
    return parsed.client === "sqlite" ? parsed : { ...parsed, password: decrypt(parsed.password) };
  } catch (error) {
    console.error("[tenant-db] unreadable database setting:", error.message);
    return null;
  }
}

/** A connection the console sent (validated), keeping the stored password when the field was left empty. */
export function validateDatabaseInput(body, previous = null) {
  const result = databaseSchema.safeParse(body);
  if (!result.success) {
    const errors = {};
    for (const issue of result.error.issues) errors[`database.${issue.path.join(".") || "client"}`] ??= issue.message;
    throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors });
  }
  const config = result.data;
  if (config.client !== "sqlite" && !config.password && previous && previous.client === config.client && previous.host === config.host && previous.user === config.user) {
    config.password = previous.password;
  }
  return config;
}

// ---- Registry and connection pools ----
/** @type {{ byId: Map<number, { id: number, slug: string, config: Object }>, bySlug: Map<string, number> } | null} */
let registry = null;
/** tenantId -> { knex, fingerprint } */
const pools = new Map();

const fingerprintOf = config => crypto.createHash("sha1").update(JSON.stringify(config)).digest("hex");

/** Reads which tenants have their own database (call after any change to tenants.database or a slug). */
export async function loadRegistry(db = getPlatformDb()) {
  const rows = await db("tenants").whereNotNull("database").select("id", "slug", "database");
  const next = { byId: new Map(), bySlug: new Map() };
  for (const row of rows) {
    const config = parseStoredDatabase(row.database);
    if (!config) continue;
    next.byId.set(Number(row.id), { id: Number(row.id), slug: row.slug, config });
    next.bySlug.set(row.slug, Number(row.id));
  }
  registry = next;
  // Pools of tenants that no longer have (this) database close.
  for (const [tenantId, pool] of pools) {
    const entry = next.byId.get(tenantId);
    if (!entry || fingerprintOf(entry.config) !== pool.fingerprint) await closeTenantPool(tenantId);
  }
  return next;
}

/** True when at least one tenant has its own database (requests then need routing). */
export const hasDedicatedDatabases = () => Boolean(registry?.byId.size);

/** The dedicated database config of a tenant, or null when it uses the platform database. */
export const dedicatedConfig = tenantId => registry?.byId.get(Number(tenantId))?.config ?? null;

export const tenantIdForSlug = slug => registry?.bySlug.get(String(slug).toLowerCase()) ?? null;

/** Every tenant id with a dedicated database. */
export const dedicatedTenantIds = () => [...(registry?.byId.keys() ?? [])];

function poolFor(tenantId) {
  const entry = registry?.byId.get(Number(tenantId));
  if (!entry) return null;
  const fingerprint = fingerprintOf(entry.config);
  const existing = pools.get(entry.id);
  if (existing && existing.fingerprint === fingerprint) return existing.knex;
  const knex = createKnex(entry.config, { pool: { min: 0, max: 5 } });
  pools.set(entry.id, { knex, fingerprint });
  return knex;
}

export async function closeTenantPool(tenantId) {
  const pool = pools.get(Number(tenantId));
  pools.delete(Number(tenantId));
  if (pool) await pool.knex.destroy().catch(() => {});
}

export async function closeAllTenantPools() {
  for (const tenantId of [...pools.keys()]) await closeTenantPool(tenantId);
}

/** The database entry (for runWithDatabase) of a tenant: its own database, or the platform database. */
export function databaseEntryFor(tenantId) {
  const knex = tenantId ? poolFor(tenantId) : null;
  if (knex) return { key: `tenant:${Number(tenantId)}`, tenantId: Number(tenantId), db: knex };
  return { key: PLATFORM_KEY, tenantId: tenantId ? Number(tenantId) : null, db: getPlatformDb() };
}

/** The Knex instance holding a tenant's data. */
export const tenantDb = tenantId => databaseEntryFor(tenantId).db;

/** Runs fn inside a tenant's database context (its own database, or the platform database). */
export function runInTenant(tenantId, fn) {
  return runWithDatabase(databaseEntryFor(tenantId), fn);
}

/** Runs fn inside the database of a workspace address (unknown addresses: the platform database). */
export function runInWorkspace(slug, fn) {
  return runInTenant(tenantIdForSlug(slug), fn);
}

/**
 * Runs fn(db, entry) once for the platform database and once for every dedicated tenant database, each inside its
 * own context, one after another. A database that fails (unreachable) is logged and skipped. Returns the results.
 * @template T
 * @param {(db: import("knex").Knex, entry: { key: string, tenantId: number | null }) => Promise<T>} fn
 * @param {{ label?: string }} [options]
 * @returns {Promise<{ key: string, tenantId: number | null, value: T }[]>}
 */
export async function forEachDatabase(fn, { label = "job" } = {}) {
  const results = [];
  const entries = [{ key: PLATFORM_KEY, tenantId: null, db: getPlatformDb() }];
  for (const tenantId of dedicatedTenantIds()) {
    try {
      entries.push(databaseEntryFor(tenantId));
    } catch (error) {
      console.error(`[tenant-db] ${label}: tenant ${tenantId} skipped: ${error.message}`);
    }
  }
  for (const entry of entries) {
    try {
      const value = await runWithDatabase(entry, () => fn(entry.db, entry));
      results.push({ key: entry.key, tenantId: entry.tenantId, value });
    } catch (error) {
      if (entry.key === PLATFORM_KEY) throw error;
      console.error(`[tenant-db] ${label}: tenant ${entry.tenantId} failed: ${error.message}`);
    }
  }
  return results;
}

/**
 * The first database where fn(db) finds something (public pages that look a record up by a code alone: tracking
 * codes, clinic tokens). Databases without the table (a module the tenant doesn't have) are skipped quietly.
 * @template T
 * @param {(db: import("knex").Knex) => Promise<T | null | undefined>} fn
 * @returns {Promise<{ db: import("knex").Knex, tenantId: number | null, value: T } | null>}
 */
export async function findInAnyDatabase(fn) {
  const platform = getPlatformDb();
  const value = await fn(platform);
  if (value) return { db: platform, tenantId: null, value };
  for (const tenantId of dedicatedTenantIds()) {
    try {
      const entry = databaseEntryFor(tenantId);
      const found = await runWithDatabase(entry, () => fn(entry.db));
      if (found) return { db: entry.db, tenantId, value: found };
    } catch (error) {
      if (!missingTableName(error)) console.error(`[tenant-db] lookup in tenant ${tenantId} failed: ${error.message}`);
    }
  }
  return null;
}

// ---- Keeping a dedicated database in step with the platform ----

/** Copies the tenant's registry row into its own database (everything but the connection itself). */
export async function syncTenantMirror(tenantId, platform = getPlatformDb()) {
  const knex = poolFor(tenantId);
  if (!knex) return false;
  const row = await platform("tenants").where({ id: tenantId }).first();
  if (!row) return false;
  const columns = await knex("tenants").columnInfo();
  const mirror = Object.fromEntries(Object.entries(row).filter(([column]) => Object.hasOwn(columns, column) && column !== "database"));
  const updated = await knex("tenants").where({ id: tenantId }).update(mirror);
  if (!updated) await knex("tenants").insert(mirror);
  return true;
}

/**
 * Writes changes to a tenant's row in the platform registry and in its own database. Every change to a tenant row
 * goes through here (settings saved inside the workspace included), so both copies stay the same.
 */
export async function updateTenantRow(tenantId, changes) {
  const platform = getPlatformDb();
  const count = await platform("tenants").where({ id: tenantId }).update(changes);
  if (dedicatedConfig(tenantId)) await syncTenantMirror(tenantId, platform);
  return count;
}

/** Creates the tables a tenant's modules need in its own database (and adds new columns after an update). */
export async function ensureTenantSchema(tenantId, features) {
  const knex = poolFor(tenantId);
  if (!knex) return null;
  return syncTables(knex, tablesForFeatures(features));
}

/**
 * Prepares a new dedicated database for a tenant: connects (creating the database on PostgreSQL / MySQL when asked),
 * refuses one that already holds another TaskFlow workspace, and creates the tables of its modules.
 * The tenant row and its people are written afterwards, by the caller, through the usual queries.
 * @returns {Promise<{ version: string, createdDatabase: boolean, tables: string[] }>}
 */
export async function prepareDatabase(config, features, { tenantId = null, createDatabase = true } = {}) {
  const probe = await testConnection(config, { createDatabase });
  const knex = createKnex(config, { pool: { min: 0, max: 2 } });
  try {
    const tables = await existingTables(knex);
    if (tables.has("tenants")) {
      const others = await knex("tenants").whereNot("id", tenantId ?? 0).count({ count: "*" });
      if (Number(others[0]?.count ?? 0) > 0) {
        throw Object.assign(new Error("This database already holds another TaskFlow workspace. Use an empty database (or a new file name)."), { code: "NOT_EMPTY" });
      }
    }
    if (tables.has("knex_migrations")) {
      throw Object.assign(new Error("This database is a TaskFlow platform database. Use an empty database for the tenant."), { code: "NOT_EMPTY" });
    }
    const result = await syncTables(knex, tablesForFeatures(features));
    return { version: probe.version, createdDatabase: probe.createdDatabase, tables: result.created };
  } finally {
    await knex.destroy();
  }
}

/** Brings every dedicated database up to date at startup: new tables and columns, and the tenant mirror. */
export async function syncAllTenantDatabases() {
  if (!isDbReady()) return;
  await loadRegistry();
  const platform = getPlatformDb();
  for (const tenantId of dedicatedTenantIds()) {
    try {
      const row = await platform("tenants").where({ id: tenantId }).first("features");
      await ensureTenantSchema(tenantId, parseFeatureList(row?.features));
      await syncTenantMirror(tenantId, platform);
    } catch (error) {
      console.error(`[tenant-db] tenant ${tenantId}: ${error.message}`);
    }
  }
  if (dedicatedTenantIds().length) console.log(`[tenant-db] ${dedicatedTenantIds().length} dedicated tenant database(s) ready`);
}

function parseFeatureList(value) {
  try {
    const list = JSON.parse(value ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** What the console shows about a tenant's database. */
export async function databaseSummary(tenantId, features) {
  const config = dedicatedConfig(tenantId);
  const expected = tablesForFeatures(features);
  if (!config) return { mode: "platform", label: "Platform database", config: null, tables: expected, status: "ok" };
  try {
    const present = await existingTables(tenantDb(tenantId));
    const catalog = await getCatalog();
    return {
      mode: "dedicated",
      label: describeDatabase(config),
      config: publicDatabaseConfig(config),
      tables: expected.filter(name => catalog.has(name)),
      missing: expected.filter(name => catalog.has(name) && !present.has(name)),
      status: "ok",
    };
  } catch (error) {
    return { mode: "dedicated", label: describeDatabase(config), config: publicDatabaseConfig(config), tables: expected, status: "unreachable", error: error.message };
  }
}

/** Errors from a table that doesn't exist (a module's table missing from a dedicated database). */
export function missingTableName(error) {
  const message = String(error?.message ?? "");
  const match = message.match(/no such table: (?:main\.)?["`]?([a-z_]+)/i) ?? message.match(/relation "([a-z_]+)" does not exist/i) ?? message.match(/Table '[^.']+\.([a-z_]+)' doesn't exist/i);
  return match ? match[1] : null;
}
