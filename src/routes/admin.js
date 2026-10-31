// Admin console: a separate sign-in (the account created in the setup wizard, or credentials from server/.env on
// installs set up before the wizard asked for one) to manage tenants and browse, search, and export every table.
// Every sign-in attempt and every change is written to the admin_audit table.
//
// getDb here is the platform database (the tenant registry and the console's own tables). A tenant's rows are read
// from tenantDb(id): the platform database, or the tenant's own database (services/tenantDatabases.js).
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { isStandalone } from "../config/edition.js";
import { readConfig } from "../config/store.js";
import { createKnex, getPlatformDb as getDb, insertAndGetId, testConnection } from "../db/connection.js";
import { concatSql, describeConnectionError, describeDatabase, likeEscape } from "../db/dialects.js";
import { existingTables } from "../db/schemaCatalog.js";
import {
  closeTenantPool,
  databaseSummary,
  dedicatedConfig,
  ensureTenantSchema,
  forEachDatabase,
  loadRegistry,
  parseStoredDatabase,
  prepareDatabase,
  runInTenant,
  storedDatabase,
  syncTenantMirror,
  tenantDb,
  updateTenantRow,
  validateDatabaseInput,
} from "../services/tenantDatabases.js";
import { consoleDatabaseRouter } from "./adminDatabase.js";
import { notFound } from "../middleware/errors.js";
import { checkModules, DEFAULT_INDUSTRY, industryOf, INDUSTRY_KEYS, moduleCatalog, moduleLabel, modulesOutside, withRequirements } from "../services/moduleCatalog.js";
import { applySettingsPatch, DEFAULT_SETTINGS, settingsSchema } from "../services/moduleSettings.js";
// Namespace import: ensureModuleRoles (module roles such as Doctor / Nurse / Receptionist) is optional here.
import * as permissionsService from "../services/permissions.js";
import { standaloneFileName, writeStandaloneZip } from "../services/standaloneExport.js";
import { assertSeatAvailable, FEATURES, toTenant } from "../services/tenants.js";
import { createTenantAccessCode } from "../services/tenantAccessCodes.js";
import { processCelebrations } from "../services/celebrations.js";
import { ADMIN_PERMISSION, expireSubscriptionNotices, processSubscriptionNotices, publishDueBroadcasts, sendSubscriptionNotice } from "../services/broadcasts.js";
import { seedTenantRoles, usersWithPermission } from "../services/permissions.js";
import { disconnectTenantSockets, disconnectUser } from "../services/realtime.js";
import { closeOpenResets, expireStaleLinks, hashResetToken, newResetToken, OPEN_STATUSES } from "../services/passwordResets.js";
import { createUser, ROLES } from "../services/users.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";
import { RESERVED_SLUGS } from "../services/tenants.js";
import { consoleBroadcastsRouter } from "./adminBroadcasts.js";
import { consoleMaintenanceRouter } from "./adminMaintenance.js";

const router = Router();

// A standalone install (one exported workspace, config/edition.js) has no provider console.
router.use((req, res, next) => (isStandalone() ? notFound(req, res) : next()));

export const ADMIN_COOKIE = "tf_admin";
export const ADMIN_AUDIENCE = "taskflow-admin";
const SESSION_HOURS = 8;
const EXPORT_LIMIT = 10_000;

// Tables the console may read, in display order. Hidden columns never leave the server.
// userColumn: which column links a row to a user, for the per-user filter (teams filter by membership).
// tenant: how a row belongs to a tenant, for the per-tenant filter: a column, or a parent table it hangs off.
// key: the primary key column when it isn't "id" (clinic_providers is keyed by user_id).
// module: which part of the product the table belongs to (a licensed module key, "workspace", or "provider"),
// for the per-module counts of a tenant's overview.
// Every table except tenants holds one tenant's data, so it is only listed for one tenant at a time.
const TABLES = Object.freeze({
  tenants: { label: "Tenants", module: "provider", hidden: [], searchable: ["name", "slug", "status", "contact_email"], userColumn: null, tenant: { column: "id" } },
  users: { label: "Users", module: "workspace", hidden: ["password_hash"], searchable: ["name", "email", "role", "job_title"], userColumn: "id", tenant: { column: "tenant_id" } },
  teams: { label: "Teams", module: "workspace", hidden: [], searchable: ["name", "description"], userColumn: null, tenant: { column: "tenant_id" } },
  tickets: { label: "Tickets", module: "helpdesk", hidden: [], searchable: ["subject", "description", "status", "priority", "category"], userColumn: "requester_id", tenant: { column: "tenant_id" } },
  ticket_comments: { label: "Ticket comments", module: "helpdesk", hidden: [], searchable: ["body"], userColumn: "author_id", tenant: { via: ["ticket_id", "tickets"] } },
  products: { label: "Products", module: "inventory", hidden: [], searchable: ["sku", "name", "category"], userColumn: null, tenant: { column: "tenant_id" } },
  stock_movements: { label: "Stock movements", module: "inventory", hidden: [], searchable: ["type", "reason", "reference"], userColumn: "created_by", tenant: { column: "tenant_id" } },
  customers: { label: "Customers", module: "sales", hidden: [], searchable: ["name", "company", "email", "phone"], userColumn: "owner_id", tenant: { column: "tenant_id" } },
  deals: { label: "Deals", module: "sales", hidden: [], searchable: ["title", "stage"], userColumn: "owner_id", tenant: { column: "tenant_id" } },
  orders: { label: "Orders", module: "sales", hidden: [], searchable: ["status", "notes"], userColumn: "created_by", tenant: { column: "tenant_id" } },
  order_items: { label: "Order lines", module: "sales", hidden: [], searchable: ["description"], userColumn: null, tenant: { via: ["order_id", "orders"] } },
  invoices: { label: "Invoices & quotes", module: "billing", hidden: [], searchable: ["number", "kind", "status", "bill_to_name", "bill_to_email"], userColumn: "created_by", tenant: { column: "tenant_id" } },
  invoice_items: { label: "Invoice lines", module: "billing", hidden: [], searchable: ["description", "unit"], userColumn: null, tenant: { via: ["invoice_id", "invoices"] } },
  invoice_payments: { label: "Invoice payments", module: "billing", hidden: [], searchable: ["method", "reference", "notes"], userColumn: "recorded_by", tenant: { column: "tenant_id" } },
  carriers: { label: "Carriers", module: "logistics", hidden: [], searchable: ["name", "code", "phone", "email"], userColumn: null, tenant: { column: "tenant_id" } },
  vehicles: { label: "Vehicles", module: "logistics", hidden: [], searchable: ["registration", "type", "status"], userColumn: "driver_id", tenant: { column: "tenant_id" } },
  shipments: { label: "Shipments", module: "logistics", hidden: [], searchable: ["number", "tracking_code", "status", "recipient_name", "destination_city"], userColumn: "created_by", tenant: { column: "tenant_id" } },
  shipment_events: { label: "Shipment events", module: "logistics", hidden: [], searchable: ["status", "location", "note"], userColumn: "actor_id", tenant: { via: ["shipment_id", "shipments"] } },
  clinic_providers: { label: "Clinic practitioners", module: "clinic", hidden: [], searchable: ["specialty", "qualification", "room"], userColumn: "user_id", tenant: { column: "tenant_id" }, key: "user_id" },
  // Clinical content stays out of the provider console: records can be counted and managed, not read.
  patients: { label: "Patients", module: "clinic", hidden: ["allergies", "chronic_conditions", "notes", "insurance_number"], searchable: ["mrn", "first_name", "last_name", "phone", "email"], userColumn: "created_by", tenant: { column: "tenant_id" } },
  appointments: { label: "Appointments", module: "clinic", hidden: ["reason", "notes", "cancel_reason"], searchable: ["type", "status"], userColumn: "provider_id", tenant: { column: "tenant_id" } },
  clinic_visits: { label: "Clinic visits", module: "clinic", hidden: ["chief_complaint", "vitals", "examination", "diagnosis", "plan"], searchable: ["visit_date"], userColumn: "provider_id", tenant: { column: "tenant_id" } },
  prescriptions: { label: "Prescriptions", module: "clinic", hidden: ["medicine", "dosage", "frequency", "duration", "instructions"], searchable: ["route"], userColumn: null, tenant: { via: ["visit_id", "clinic_visits"] } },
  attendance_records: { label: "Attendance", module: "attendance", hidden: [], searchable: ["work_date", "note"], userColumn: "user_id", tenant: { column: "tenant_id" } },
  leave_requests: { label: "Leave requests", module: "attendance", hidden: [], searchable: ["type", "status", "reason"], userColumn: "user_id", tenant: { column: "tenant_id" } },
  expenses: { label: "Expenses", module: "expenses", hidden: [], searchable: ["title", "category", "status"], userColumn: "user_id", tenant: { column: "tenant_id" } },
  announcements: { label: "Announcements", module: "announcements", hidden: [], searchable: ["title", "body"], userColumn: "author_id", tenant: { column: "tenant_id" } },
  holidays: { label: "Holidays", module: "attendance", hidden: [], searchable: ["name", "type", "holiday_date"], userColumn: "created_by", tenant: { column: "tenant_id" } },
  roles: { label: "Roles", module: "workspace", hidden: [], searchable: ["name", "key", "description"], userColumn: null, tenant: { column: "tenant_id" } },
  tenant_audit: { label: "Tenant audit log", module: "workspace", hidden: [], searchable: ["action", "target"], userColumn: "actor_id", tenant: { column: "tenant_id" } },
  // Chat messages are private between colleagues and deliberately not browsable here.
  lists: { label: "Lists", module: "tasks", hidden: [], searchable: ["name", "color"], userColumn: "user_id", tenant: { via: ["user_id", "users"] } },
  tasks: { label: "Tasks", module: "tasks", hidden: [], searchable: ["title", "notes", "status", "priority"], userColumn: "user_id", tenant: { via: ["user_id", "users"] } },
  notifications: { label: "Notifications", module: "workspace", hidden: [], searchable: ["title", "body"], userColumn: "user_id", tenant: { via: ["user_id", "users"] } },
});

// ---- Sign-in throttling: 5 failed attempts per IP locks admin sign-in for 15 minutes. ----
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map();

function checkLock(ip) {
  const entry = failures.get(ip);
  if (!entry) return;
  if (Date.now() > entry.resetAt) return failures.delete(ip);
  if (entry.count >= MAX_FAILURES) {
    const minutes = Math.ceil((entry.resetAt - Date.now()) / 60_000);
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, {
      code: "TOO_MANY_ATTEMPTS",
    });
  }
}

function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() > entry.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + LOCK_MS });
  else entry.count += 1;
}

// ---- Schemas ----
const loginSchema = z.object({
  username: z.string().trim().min(1, "Username is required."),
  password: z.string().min(1, "Password is required."),
});

const rowsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.coerce.number().int().positive().optional(),
  tenantId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const tenantQuerySchema = z.object({ tenantId: z.coerce.number().int().positive().optional() });

const auditQuerySchema = pageSchema.extend({
  tenantId: z.coerce.number().int().positive().optional(),
  /** all = the tenant's own log plus console actions about it */
  source: z.enum(["all", "console", "tenant"]).default("all"),
});

const roleSchema = z.object({ role: z.enum(["admin", "agent", "member"]) });
const passwordSchema = z.object({ password: z.string().min(8, "Use at least 8 characters.").max(128) });

// ---- Helpers ----
/**
 * Checks a console sign-in; returns the username, or null when it's wrong. The setup wizard's account (stored
 * hashed in data/config.json) is the console's sign-in; without one, ADMIN_USERNAME / ADMIN_PASSWORD from .env.
 */
async function checkConsoleCredentials(username, password) {
  const account = readConfig()?.console;
  if (account?.username && account?.passwordHash) {
    const nameMatches = safeEqual(username, account.username);
    const passwordMatches = await bcrypt.compare(password, account.passwordHash);
    return nameMatches && passwordMatches ? account.username : null;
  }
  const expected = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD };
  if (!expected.username || !expected.password) {
    throw new HttpError(503, "Console sign-in is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in server/.env.", {
      code: "ADMIN_NOT_CONFIGURED",
    });
  }
  return safeEqual(username, expected.username) && safeEqual(password, expected.password) ? expected.username : null;
}

/** Signs the provider in to the console on this browser (also used right after the setup wizard). */
export function startConsoleSession(res, username) {
  const token = jwt.sign({ sub: username }, secret(), { audience: ADMIN_AUDIENCE, expiresIn: `${SESSION_HOURS}h` });
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: "/",
  });
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
function safeEqual(a, b) {
  const hash = value => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

const secret = () => readConfig().jwtSecret;

function requireAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) throw new HttpError(401, "Please sign in as admin.", { code: "UNAUTHENTICATED" });
  try {
    const payload = jwt.verify(token, secret(), { audience: ADMIN_AUDIENCE });
    req.admin = { username: payload.sub, expiresAt: new Date(payload.exp * 1000).toISOString() };
  } catch {
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    throw new HttpError(401, "Your admin session has expired. Please sign in again.", { code: "UNAUTHENTICATED" });
  }
  next();
}

/**
 * Audit failures must never break the action being audited. Actions about one tenant pass its id: it is stored as
 * the first key of the details ({"tenantId":4,...}) so the tenant's audit view can find them (see consoleAuditFor).
 */
async function audit(req, action, target = null, details = null, tenantId = null) {
  try {
    const stored = tenantId ? { tenantId: Number(tenantId), ...details } : details;
    await getDb()("admin_audit").insert({
      actor: req.admin?.username ?? String(req.body?.username ?? "unknown").slice(0, 120),
      action,
      target,
      details: stored ? JSON.stringify(stored) : null,
      ip: req.ip ?? null,
      created_at: nowIso(),
    });
  } catch (error) {
    console.error("[audit] failed to record", action, error.message);
  }
}

function tableOrThrow(name) {
  if (!Object.hasOwn(TABLES, name)) throw new HttpError(404, "Not found.");
  return TABLES[name];
}

/** The table's primary key column. */
const keyOf = name => TABLES[name].key ?? "id";

const toCount = rows => Number(rows[0]?.count ?? 0);

/** Map of user_id -> count for one table (optionally filtered). */
async function countByUser(db, table, where) {
  const query = db(table).select("user_id").count({ count: "*" }).groupBy("user_id");
  if (where) where(query);
  const rows = await query;
  return new Map(rows.map(row => [Number(row.user_id), Number(row.count)]));
}

async function visibleColumns(db, name) {
  const { hidden } = TABLES[name];
  return Object.keys(await db(name).columnInfo()).filter(column => !hidden.includes(column));
}

/** Applies the tenant filter, user filter, and search term shared by listing and export. */
function applyFilters(query, name, { tenantId, userId, search }) {
  const { userColumn, tenant } = TABLES[name];
  if (tenantId) {
    if (tenant.column) query.where(tenant.column, tenantId);
    else query.whereIn(tenant.via[0], sub => sub.select("id").from(tenant.via[1]).where("tenant_id", tenantId));
  }
  if (userId) {
    if (userColumn) query.where(userColumn, userId);
    else if (name === "teams") query.whereIn("id", sub => sub.select("team_id").from("team_members").where("user_id", userId));
  }
  if (search) {
    const term = `%${search.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`;
    const id = Number(search);
    query.where(inner => {
      TABLES[name].searchable.forEach(column => inner.orWhereRaw(`lower(??) like ?${likeEscape(query.client)}`, [column, term]));
      if (Number.isInteger(id) && id > 0) inner.orWhere(keyOf(name), id);
    });
  }
  return query;
}

/**
 * Every table but tenants holds tenant data: list it only for one chosen tenant, which must not be in the recycle bin.
 * Returns the database to read: the tenants table from the platform, everything else from the tenant's database.
 */
async function requireTenantScope(name, tenantId) {
  if (name !== "tenants" && !tenantId) throw new HttpError(422, "Choose a tenant first.", { code: "TENANT_REQUIRED" });
  if (tenantId) await findTenant(getDb(), tenantId);
  if (name === "tenants") return getDb();
  const db = tenantDb(tenantId);
  // A dedicated database has only the tables of the tenant's modules.
  if (dedicatedConfig(tenantId) && !(await existingTables(db)).has(name)) {
    throw new HttpError(404, "This tenant's database has no such table: its module isn't licensed.", { code: "TABLE_NOT_IN_TENANT" });
  }
  return db;
}

/** Row counts of every tenant table for one tenant (only the tables its database has, for a dedicated database). */
async function tenantTableCounts(db, tenantId) {
  const present = dedicatedConfig(tenantId) ? await existingTables(db) : null;
  return Promise.all(
    Object.entries(TABLES)
      .filter(([name]) => name !== "tenants" && (!present || present.has(name)))
      .map(async ([name, { label, module }]) => ({ name, label, module, count: toCount(await applyFilters(db(name).count({ count: "*" }), name, { tenantId })) }))
  );
}

/** Console audit rows about one tenant: the tenant itself, its users (current ids), or tagged with its id. */
function consoleAuditFor(query, tenantId) {
  const db = getDb();
  // People of a tenant with its own database: their ids are only meaningful with the tenant tag (below).
  const userTargets = dedicatedConfig(tenantId) ? [] : sub => sub.select(db.raw(concatSql(db, "'users#'", "id"))).from("users").where("tenant_id", tenantId);
  return query.where(inner =>
    inner
      .where("target", `tenants#${tenantId}`)
      .orWhereIn("target", userTargets)
      .orWhere("details", "like", `{"tenantId":${tenantId},%`)
      .orWhere("details", `{"tenantId":${tenantId}}`)
      // older entries recorded the tenant of a new user as "tenant"
      .orWhere("details", "like", `{"tenant":${tenantId},%`)
  );
}

function toCsv(columns, rows) {
  const cell = value => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...rows.map(row => columns.map(column => cell(row[column])).join(","))].join("\r\n");
}

/** UTC calendar days, oldest first: ["2026-09-17", ..., "2026-09-30"]. */
function lastDays(count) {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (count - 1 - index)));
    return day.toISOString().slice(0, 10);
  });
}

/** Restricts a query on a per-user table (tasks, notifications) to one tenant's users; no tenant = every tenant. */
function byTenantUsers(query, tenantId, column = "user_id") {
  if (tenantId) query.whereIn(column, sub => sub.select("id").from("users").where("tenant_id", tenantId));
  return query;
}

async function countPerDay(db, column, since, tenantId) {
  const rows = await byTenantUsers(
    db("tasks")
      .select(db.raw(`substr(??, 1, 10) as day`, [column]))
      .count({ count: "*" })
      .where(column, ">=", since),
    tenantId
  ).groupByRaw("substr(??, 1, 10)", [column]);
  return new Map(rows.map(row => [row.day, Number(row.count)]));
}

// ---- Session ----
router.post("/login", async (req, res) => {
  const ip = req.ip ?? "unknown";
  checkLock(ip);
  const input = validate(loginSchema, req.body);
  const username = await checkConsoleCredentials(input.username, input.password);
  if (!username) {
    recordFailure(ip);
    await audit(req, "login_failed");
    throw new HttpError(401, "Incorrect username or password.", { code: "INVALID_CREDENTIALS" });
  }

  failures.delete(ip);
  startConsoleSession(res, username);
  req.admin = { username };
  await audit(req, "login");
  res.json({ username, expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString() });
});

router.post("/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
  res.status(204).end();
});

router.get("/me", requireAdmin, (req, res) => res.json(req.admin));

/** user id -> [{ key, name }] for the users of one tenant (or every tenant). */
async function roleNamesByUser(db, tenantId) {
  const query = db("user_roles as ur").join("roles as r", "r.id", "ur.role_id").select("ur.user_id", "r.key", "r.name").orderBy("r.id");
  if (tenantId) query.where("r.tenant_id", tenantId);
  const rows = await query;
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push({ key: row.key, name: row.name });
  }
  return map;
}

/** A tenant as an overview card: no rows from inside the tenant, just its plan and head counts. */
const toTenantCard = tenant => ({
  id: tenant.id,
  name: tenant.name,
  slug: tenant.slug,
  siteTitle: tenant.settings?.branding?.siteTitle ?? "",
  status: tenant.status,
  features: tenant.features,
  industry: tenant.industry,
  maxUsers: tenant.maxUsers,
  users: tenant.users,
  subscription: tenant.subscription,
  createdAt: tenant.createdAt,
});

// ---- Overview & insights ----
// Without a tenant: cross-tenant aggregates only (tenant cards and totals). With ?tenantId: that tenant's row counts
// per table (grouped into modules by the client) and its users with how much data each one owns.
router.get("/overview", requireAdmin, async (req, res) => {
  const { tenantId } = validate(tenantQuerySchema, req.query);
  const db = getDb();

  if (!tenantId) {
    const [tenants, recycleBin] = await Promise.all([tenantSummaries(db), db("tenants").whereNotNull("deleted_at").count({ count: "*" }).then(toCount)]);
    const states = tenants.map(tenant => tenant.subscription.state);
    res.json({
      scope: "all",
      totals: {
        tenants: tenants.length,
        activeTenants: tenants.filter(tenant => tenant.status === "active").length,
        suspendedTenants: tenants.filter(tenant => tenant.status !== "active").length,
        users: tenants.reduce((sum, tenant) => sum + tenant.users.total, 0),
        activeUsers: tenants.reduce((sum, tenant) => sum + tenant.users.active, 0),
        expiringSoon: states.filter(state => state === "ending").length, // ends within 30 days
        inGrace: states.filter(state => state === "grace").length,
        expired: states.filter(state => state === "expired").length,
        recycleBin,
      },
      tenants: tenants.map(toTenantCard),
    });
    return;
  }

  const tenant = await findTenant(db, tenantId);
  const own = tenantDb(tenantId);
  const inTenant = query => query.whereIn("user_id", sub => sub.select("id").from("users").where("tenant_id", tenantId));
  const hasTasks = !dedicatedConfig(tenantId) || (await existingTables(own)).has("tasks");
  const none = new Map();
  const [tables, users, lists, tasks, openTasks, notifications, roleNames, database] = await Promise.all([
    tenantTableCounts(own, tenantId),
    own("users").where("tenant_id", tenantId).select("id", "name", "email", "is_active", "job_title", "created_at").orderBy("id"),
    hasTasks ? countByUser(own, "lists", inTenant) : none,
    hasTasks ? countByUser(own, "tasks", inTenant) : none,
    hasTasks ? countByUser(own, "tasks", query => inTenant(query).where("status", "!=", "done")) : none,
    countByUser(own, "notifications", inTenant),
    roleNamesByUser(own, tenantId),
    databaseSummary(tenantId, tenant.features),
  ]);

  res.json({
    scope: "tenant",
    tenant: toTenantCard(tenant),
    database,
    tables,
    users: users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      jobTitle: user.job_title ?? null,
      roles: roleNames.get(user.id) ?? [],
      isActive: Boolean(user.is_active),
      tenant: { id: tenant.id, name: tenant.name },
      createdAt: user.created_at,
      lists: lists.get(user.id) ?? 0,
      tasks: tasks.get(user.id) ?? 0,
      openTasks: openTasks.get(user.id) ?? 0,
      notifications: notifications.get(user.id) ?? 0,
    })),
  });
});

// Usage totals and 14-day task activity: for one tenant (?tenantId) or summed over every tenant.
router.get("/insights", requireAdmin, async (req, res) => {
  const { tenantId } = validate(tenantQuerySchema, req.query);
  if (tenantId) await findTenant(getDb(), tenantId);
  const days = lastDays(14);
  // One tenant: its database. Every tenant: each database, summed.
  const parts = tenantId ? [await insightsOf(tenantDb(tenantId), tenantId, days)] : (await forEachDatabase(db => insightsOf(db, undefined, days), { label: "insights" })).map(result => result.value);
  const sum = key => parts.reduce((total, part) => total + part.totals[key], 0);
  const merge = (key, names) => names.map(name => ({ name, count: parts.reduce((total, part) => total + (part[key].find(item => item.name === name)?.count ?? 0), 0) }));
  res.json({
    tenantId: tenantId ?? null,
    totals: { users: sum("users"), newUsers: sum("newUsers"), tasks: sum("tasks"), open: sum("open"), overdue: sum("overdue"), completedWeek: sum("completedWeek"), unread: sum("unread") },
    byStatus: merge("byStatus", ["todo", "in_progress", "done"]),
    byPriority: merge("byPriority", ["urgent", "high", "medium", "low"]),
    daily: days.map(day => ({ day, created: parts.reduce((total, part) => total + (part.created.get(day) ?? 0), 0), completed: parts.reduce((total, part) => total + (part.completed.get(day) ?? 0), 0) })),
  });
});

/** Usage figures of one database (optionally one tenant in it). A database without the tasks module counts no tasks. */
async function insightsOf(db, tenantId, days) {
  const now = nowIso();
  const since = `${days[0]}T00:00:00.000Z`;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const users = () => (tenantId ? db("users").where("tenant_id", tenantId) : db("users"));
  const tasks = () => byTenantUsers(db("tasks"), tenantId);

  const hasTasks = (await existingTables(db)).has("tasks");
  if (!hasTasks) {
    const [userCount, newUsers, unread] = await Promise.all([
      users().count({ count: "*" }).then(toCount),
      users().count({ count: "*" }).where("created_at", ">=", weekAgo).then(toCount),
      byTenantUsers(db("notifications"), tenantId).count({ count: "*" }).where("is_read", false).then(toCount),
    ]);
    return { totals: { users: userCount, newUsers, tasks: 0, open: 0, overdue: 0, completedWeek: 0, unread }, byStatus: [], byPriority: [], created: new Map(), completed: new Map() };
  }
  const [userCount, newUsers, taskCount, open, overdue, completedWeek, unread, byStatus, byPriority, created, completed] = await Promise.all([
    users().count({ count: "*" }).then(toCount),
    users().count({ count: "*" }).where("created_at", ">=", weekAgo).then(toCount),
    tasks().count({ count: "*" }).then(toCount),
    tasks().count({ count: "*" }).where("status", "!=", "done").then(toCount),
    tasks().count({ count: "*" }).where("status", "!=", "done").whereNotNull("due_at").where("due_at", "<", now).then(toCount),
    tasks().count({ count: "*" }).where("completed_at", ">=", weekAgo).then(toCount),
    byTenantUsers(db("notifications"), tenantId).count({ count: "*" }).where("is_read", false).then(toCount),
    tasks().select("status").count({ count: "*" }).groupBy("status"),
    tasks().select("priority").count({ count: "*" }).groupBy("priority"),
    countPerDay(db, "created_at", since, tenantId),
    countPerDay(db, "completed_at", since, tenantId),
  ]);

  const tally = (rows, key, keys) => keys.map(name => ({ name, count: Number(rows.find(row => row[key] === name)?.count ?? 0) }));
  return {
    totals: { users: userCount, newUsers, tasks: taskCount, open, overdue, completedWeek, unread },
    byStatus: tally(byStatus, "status", ["todo", "in_progress", "done"]),
    byPriority: tally(byPriority, "priority", ["urgent", "high", "medium", "low"]),
    created,
    completed,
  };
}

// ---- Table browsing, export, delete (one tenant at a time; only the tenants table itself is cross-tenant) ----
router.get("/tables/:table", requireAdmin, async (req, res) => {
  const name = req.params.table;
  tableOrThrow(name);
  const query = validate(rowsQuerySchema, req.query);
  const db = await requireTenantScope(name, query.tenantId);
  const columns = await visibleColumns(db, name);
  const key = keyOf(name);
  const sort = columns.includes(query.sort) ? query.sort : key;

  const total = toCount(await applyFilters(db(name).count({ count: "*" }), name, query));
  const rows = await applyFilters(db(name).select(columns), name, query)
    .orderBy(sort, query.order)
    .orderBy(key, query.order)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  res.json({
    table: name,
    key,
    columns,
    rows,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    sort,
    order: query.order,
  });
});

router.get("/tables/:table/export", requireAdmin, async (req, res) => {
  const name = req.params.table;
  tableOrThrow(name);
  const query = validate(rowsQuerySchema, req.query);
  const db = await requireTenantScope(name, query.tenantId);
  const columns = await visibleColumns(db, name);
  const key = keyOf(name);
  const sort = columns.includes(query.sort) ? query.sort : key;
  const rows = await applyFilters(db(name).select(columns), name, query).orderBy(sort, query.order).orderBy(key, query.order).limit(EXPORT_LIMIT);

  const slug = query.tenantId ? (await getDb()("tenants").where({ id: query.tenantId }).first("slug"))?.slug : null;
  await audit(req, "export", name, { rows: rows.length, userId: query.userId, search: query.search }, query.tenantId);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="taskflow-${name}${slug ? `-${slug}` : ""}.csv"`);
  res.send(toCsv(columns, rows));
});

// DELETE /tables/:table/:id?tenantId=4: the row must belong to that tenant.
router.delete("/tables/:table/:id", requireAdmin, async (req, res) => {
  const name = req.params.table;
  tableOrThrow(name);
  if (name === "tenants") throw new HttpError(422, "Tenants can't be deleted here. Use Delete on the Tenants view (it goes to the recycle bin first).", { code: "TENANT_DELETE" });
  const id = parseId(req.params.id);
  const { tenantId } = validate(tenantQuerySchema, req.query);
  const db = await requireTenantScope(name, tenantId);
  const key = keyOf(name);
  const row = await applyFilters(db(name).where(key, id), name, { tenantId }).first();
  if (!row) throw new HttpError(404, "Not found in this tenant.");

  await db(name).where(key, id).del();
  const summary = name === "users" ? { name: row.name, email: row.email } : { title: row.title ?? row.subject ?? row.name ?? null, user_id: row.user_id ?? row.requester_id ?? row.author_id ?? null };
  await audit(req, "delete_row", `${name}#${id}`, summary, tenantId);
  res.status(204).end();
});

// ---- User management ----
/**
 * The user, which must belong to ?tenantId when the console passes one (the tenant-scoped views do; tenants with their
 * own database need it, since their user ids are only unique there). Returns the user and their database.
 */
async function findUser(req, id) {
  const { tenantId } = validate(tenantQuerySchema, req.query);
  const db = tenantDb(tenantId);
  const user = await db("users").where({ id }).first();
  if (!user || (tenantId && user.tenant_id !== tenantId) || (!tenantId && dedicatedConfig(user.tenant_id))) throw new HttpError(404, "Not found.");
  await findTenant(getDb(), user.tenant_id); // refuses tenants in the recycle bin
  return { user, db };
}

router.patch("/users/:id/role", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const { role } = validate(roleSchema, req.body);
  const { user, db } = await findUser(req, id);

  const roles = await db("roles").where({ tenant_id: user.tenant_id }).select("id", "key");
  const target = roles.find(item => item.key === role);
  if (!target) throw new HttpError(422, "This tenant has no such role.", { code: "INVALID_ROLE" });
  const owner = roles.find(item => item.key === "owner");
  const before = (await roleNamesByUser(db, user.tenant_id)).get(id) ?? [];
  await db.transaction(async trx => {
    await trx("user_roles").where({ user_id: id }).whereNot("role_id", owner?.id ?? 0).delete();
    await trx("user_roles").insert({ user_id: id, role_id: target.id });
    await trx("users").where({ id }).update({ role });
  });
  runInTenant(user.tenant_id, () => disconnectUser(id, "Access changed")); // their tabs re-check the session and reconnect with the new access
  await audit(req, "change_role", `users#${id}`, { email: user.email, from: before.map(item => item.name).join(", "), to: role }, user.tenant_id);
  res.json({ id, role });
});

router.post("/users/:id/password", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const { password } = validate(passwordSchema, req.body);
  const { user, db } = await findUser(req, id);

  await db("users").where({ id }).update({ password_hash: await bcrypt.hash(password, 10), password_changed_at: nowIso() });
  runInTenant(user.tenant_id, () => disconnectUser(id, "Password changed"));
  await audit(req, "reset_password", `users#${id}`, { email: user.email }, user.tenant_id);
  res.status(204).end();
});

const adminResetLinkSchema = z.object({
  expiresInHours: z.number().int().min(1).max(72).default(24),
  tenantId: z.number().int().positive().optional(),
});

/**
 * Returns tenant admin password reset requests across all workspaces for Bunny overall admin.
 */
router.get("/password-requests", requireAdmin, async (req, res) => {
  const db = getDb();
  await expireStaleLinks(db);
  const rows = await db("password_resets as pr")
    .join("users as u", "u.id", "pr.user_id")
    .join("tenants as t", "t.id", "pr.tenant_id")
    .where("pr.is_tenant_admin", true)
    .whereIn("pr.status", OPEN_STATUSES)
    .select(
      "pr.id",
      "pr.tenant_id",
      "pr.user_id",
      "pr.status",
      "pr.requested_at",
      "pr.requested_ip",
      "pr.issued_at",
      "pr.expires_at",
      "u.name as user_name",
      "u.email as user_email",
      "u.job_title as user_job_title",
      "t.name as tenant_name",
      "t.slug as tenant_slug"
    )
    .orderByRaw("coalesce(pr.requested_at, pr.created_at) desc");

  res.json(rows.map(r => ({
    id: r.id,
    status: r.status,
    requestedAt: r.requested_at ?? null,
    requestedIp: r.requested_ip ?? null,
    issuedAt: r.issued_at ?? null,
    expiresAt: r.expires_at ?? null,
    user: { id: r.user_id, name: r.user_name, email: r.user_email, jobTitle: r.user_job_title ?? null },
    tenant: { id: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug },
  })));
});

/**
 * Generates a secure one-time password reset link for a tenant admin or user in /bunny.
 */
router.post("/users/:id/reset-link", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const { expiresInHours, tenantId: bodyTenantId } = validate(adminResetLinkSchema, req.body ?? {});
  if (!req.query.tenantId && bodyTenantId) {
    req.query.tenantId = String(bodyTenantId);
  }
  const { user, db } = await findUser(req, id);
  const tenantId = user.tenant_id || bodyTenantId;
  if (!user.is_active) throw new HttpError(422, "This account is deactivated. Reactivate it first.", { code: "USER_INACTIVE" });

  const token = newResetToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  const issued = {
    status: "issued",
    token_hash: hashResetToken(token),
    issued_at: now,
    expires_at: expiresAt,
    used_at: null,
    is_tenant_admin: true,
  };

  await db.transaction(async trx => {
    await expireStaleLinks(trx, { user_id: id });
    const open = await trx("password_resets").where({ user_id: id, tenant_id: tenantId }).whereIn("status", OPEN_STATUSES).orderBy("id", "desc").first();
    if (open) {
      await trx("password_resets").where({ id: open.id }).update(issued);
      await closeOpenResets(trx, id, "expired", { exceptId: open.id });
    } else {
      await insertAndGetId(trx, "password_resets", { tenant_id: tenantId, user_id: id, created_at: now, ...issued });
    }
  });

  await audit(req, "issue_reset_link", `users#${id}`, { email: user.email, expiresInHours }, tenantId);
  res.status(201).json({ url: `/reset-password/${token}`, token, expiresAt });
});

router.post("/password-requests/:id/dismiss", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const request = await db("password_resets").where({ id }).first();
  if (!request) throw new HttpError(404, "Request not found.");
  await db("password_resets").where({ id }).update({ status: "dismissed" });
  await audit(req, "dismiss_reset_request", `password_resets#${id}`, { userId: request.user_id }, request.tenant_id);
  res.status(204).end();
});

// ---- Tenants: each customer company, its modules, user limit, and accounts ----
const featureList = z.array(z.enum(FEATURES)).min(1, "Enable at least one module.");
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, "Use lowercase letters, numbers, and dashes.")
  .refine(value => !RESERVED_SLUGS.has(value), "That address is used by the app itself. Pick another one.");

// ---- Subscription: a free-text plan, start and (optional) end dates, and grace days before access stops ----
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-31.")
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Enter a valid date.");
const optionalDay = z.preprocess(value => (value === "" ? null : value), calendarDay.nullable());
const subscriptionFields = {
  plan: z.string().trim().min(1, "Plan is required.").max(40, "Use at most 40 characters."),
  subscriptionStartsOn: optionalDay,
  subscriptionEndsOn: optionalDay,
  graceDays: z.number().int("Use a whole number of days.").min(0, "Use 0 to 90 days.").max(90, "Use 0 to 90 days."),
};
const END_BEFORE_START = "The end date can't be before the start date.";
function endAfterStart(value, ctx) {
  if (value.subscriptionStartsOn && value.subscriptionEndsOn && value.subscriptionEndsOn < value.subscriptionStartsOn) {
    ctx.addIssue({ code: "custom", path: ["subscriptionEndsOn"], message: END_BEFORE_START });
  }
}

const industry = z.enum(INDUSTRY_KEYS, { error: "Choose an industry." });

/**
 * Modules must fit the industry and bring their hard dependencies (services/moduleCatalog.js). Clients that name the
 * industry (the console) are checked strictly; older API clients that don't get the dependencies added for them and
 * the Custom industry.
 */
function normalizeModules(value) {
  if (value.features === undefined) return value;
  return value.industry === undefined ? { ...value, features: withRequirements(value.features) } : value;
}
function modulesFit(value, ctx) {
  if (value.features === undefined) return;
  for (const [field, message] of Object.entries(checkModules(value.industry ?? DEFAULT_INDUSTRY, value.features))) ctx.addIssue({ code: "custom", path: [field], message });
}

const tenantSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(120),
    slug: slug.optional(),
    industry: industry.optional(),
    features: featureList,
    maxUsers: z.number().int().min(1).max(100_000).nullable().default(null),
    contactEmail: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable().default(null),
    settings: settingsSchema.default({}),
    plan: subscriptionFields.plan.default("Standard"),
    subscriptionStartsOn: subscriptionFields.subscriptionStartsOn.optional(),
    subscriptionEndsOn: subscriptionFields.subscriptionEndsOn.optional(),
    graceDays: subscriptionFields.graceDays.default(7),
    owner: z.object({
      name: z.string().trim().min(1, "Owner name is required.").max(120),
      email: z.email("Enter a valid email address."),
      password: z.string().min(8, "Use at least 8 characters.").max(128),
    }),
  })
  .superRefine(endAfterStart)
  .transform(normalizeModules)
  .superRefine(modulesFit);

/** Where a new tenant's data lives: the platform database (default) or a database of its own. */
const databaseChoice = z
  .object({
    mode: z.enum(["platform", "dedicated"]).default("platform"),
    /** Checked by validateDatabaseInput (field errors as database.<field>) */
    config: z.record(z.string(), z.unknown()).optional(),
    createDatabase: z.boolean().default(true),
  })
  .default({ mode: "platform", createDatabase: true });

// Industry and modules are checked against the stored tenant in PATCH (one of them may change alone).
const tenantUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(120),
    status: z.enum(["active", "suspended"]),
    industry,
    features: featureList,
    maxUsers: z.number().int().min(1).max(100_000).nullable(),
    contactEmail: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable(),
    settings: settingsSchema,
    ...subscriptionFields,
  })
  .partial()
  .superRefine(endAfterStart);

const tenantUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.email("Enter a valid email address."),
  role: z.enum(ROLES).default("member"),
  password: z.string().min(8, "Use at least 8 characters.").max(128),
});

const slugify = value =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "tenant";

async function uniqueSlug(db, base) {
  if (RESERVED_SLUGS.has(base)) base = `${base}-co`;
  let candidate = base;
  for (let n = 2; await db("tenants").where({ slug: candidate }).first(); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Where a tenant's data lives, for the console (never the password). */
function databaseLabel(row) {
  const config = parseStoredDatabase(row.database);
  if (!config) return { mode: "platform", client: null, label: "Platform database" };
  return { mode: "dedicated", client: config.client, label: config.client === "sqlite" ? `SQLite · ${config.filename}` : `${config.client} · ${config.database}@${config.host}` };
}

/** A tenant with its subscription and recycle-bin state (the console's view; toTenant is shared with the app). */
const toConsoleTenant = row => ({
  ...toTenant(row),
  subscription: subscriptionSummary(row),
  deletedAt: row.deleted_at ?? null,
  deletedBy: row.deleted_by ?? null,
});

/**
 * Tenants with their head counts. scope: live (default: not in the recycle bin), deleted (only the recycle bin),
 * or any (both); id narrows it to one tenant.
 */
async function tenantSummaries(db, { scope = "live", id } = {}) {
  const tenants = db("tenants").orderBy("id");
  if (scope === "live") tenants.whereNull("deleted_at");
  if (scope === "deleted") tenants.whereNotNull("deleted_at");
  if (id) tenants.where({ id });
  const countsIn = (knex, tenantId) => {
    const query = knex("users").select("tenant_id").count({ total: "*" }).sum({ active: knex.raw("case when is_active then 1 else 0 end") }).groupBy("tenant_id");
    if (tenantId) query.where({ tenant_id: tenantId });
    return query;
  };
  const [rows, userCounts] = await Promise.all([tenants, countsIn(db, id)]);
  const byTenant = new Map(userCounts.map(row => [Number(row.tenant_id), { total: Number(row.total), active: Number(row.active ?? 0) }]));
  // Tenants with their own database count their people there.
  for (const row of rows) {
    if (!dedicatedConfig(row.id)) continue;
    try {
      const [own] = await countsIn(tenantDb(row.id), row.id);
      byTenant.set(row.id, { total: Number(own?.total ?? 0), active: Number(own?.active ?? 0) });
    } catch (error) {
      console.error(`[tenant-db] tenant ${row.id}: counting users failed: ${error.message}`);
    }
  }
  return rows.map(row => ({ ...toConsoleTenant(row), users: byTenant.get(row.id) ?? { total: 0, active: 0 }, database: databaseLabel(row) }));
}

/** One tenant for a tenant-scoped view: tenants in the recycle bin are refused (only Restore and Purge pass allowDeleted). */
async function findTenant(db, id, { allowDeleted = false } = {}) {
  const [tenant] = await tenantSummaries(db, { scope: allowDeleted ? "any" : "live", id });
  if (!tenant) {
    if (!allowDeleted && (await db("tenants").where({ id }).whereNotNull("deleted_at").first("id"))) {
      throw new HttpError(409, "This tenant is in the recycle bin. Restore it first.", { code: "TENANT_DELETED" });
    }
    throw new HttpError(404, "Tenant not found.");
  }
  return tenant;
}

/** Ends the live sockets of everyone in a tenant (their tabs then re-check the session). */
async function disconnectTenant(db, tenantId, reason) {
  disconnectTenantSockets(tenantId, reason);
}

// ?scope=deleted lists the recycle bin; the default leaves it out. counts feeds the Active / Suspended / Recycle bin filter.
router.get("/tenants", requireAdmin, async (req, res) => {
  const { scope } = validate(z.object({ scope: z.enum(["live", "deleted"]).default("live") }), req.query);
  const db = getDb();
  const [tenants, rows] = await Promise.all([
    tenantSummaries(db, { scope }),
    db("tenants").select(db.raw("case when deleted_at is not null then 'deleted' else status end as bucket")).count({ count: "*" }).groupByRaw("case when deleted_at is not null then 'deleted' else status end"),
  ]);
  const counts = { active: 0, suspended: 0, deleted: 0 };
  for (const row of rows) counts[row.bucket === "active" || row.bucket === "deleted" ? row.bucket : "suspended"] += Number(row.count);
  // catalog: module dependencies and industries (services/moduleCatalog.js), so the console applies the same rules.
  res.json({ features: FEATURES, catalog: moduleCatalog(), defaultSettings: DEFAULT_SETTINGS, scope, counts, tenants });
});

// ---- Lifecycle: delete (to the recycle bin), restore, delete permanently ----
// While in the recycle bin nobody can sign in (accessProblem: TENANT_DELETED), its public pages are gone, and the
// console's tenant views refuse it. The slug stays reserved until the tenant is deleted permanently.
router.delete("/tenants/:id", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenant = await findTenant(db, id);
  const now = nowIso();
  await updateTenantRow(id, { deleted_at: now, deleted_by: req.admin.username, updated_at: now });
  await disconnectTenant(db, id, "Workspace deleted");
  await audit(req, "delete_tenant", `tenants#${id}`, { name: tenant.name, slug: tenant.slug }, id);
  res.json(await findTenant(db, id, { allowDeleted: true }));
});

router.post("/tenants/:id/restore", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenant = await findTenant(db, id, { allowDeleted: true });
  if (!tenant.deletedAt) throw new HttpError(409, "This tenant isn't in the recycle bin.", { code: "TENANT_NOT_DELETED" });
  await updateTenantRow(id, { deleted_at: null, deleted_by: null, updated_at: nowIso() });
  await audit(req, "restore_tenant", `tenants#${id}`, { name: tenant.name, deletedAt: tenant.deletedAt, deletedBy: tenant.deletedBy }, id);
  res.json(await findTenant(db, id));
});

/** Row counts that a permanent delete removes: every console table plus the tables only reachable through users. */
async function purgeCounts(platform, tenantId) {
  const counts = { tenants: 1 };
  const db = tenantDb(tenantId);
  for (const { name, count } of await tenantTableCounts(db, tenantId)) counts[name] = count;
  const byUsers = async (table, column = "user_id") => toCount(await byTenantUsers(db(table).count({ count: "*" }), tenantId, column));
  const extra = {
    user_roles: () => byUsers("user_roles"),
    team_members: () => byUsers("team_members"),
    conversations: async () => toCount(await db("conversations").where("tenant_id", tenantId).count({ count: "*" })),
    messages: async () => toCount(await db("messages").whereIn("conversation_id", sub => sub.select("id").from("conversations").where("tenant_id", tenantId)).count({ count: "*" })),
    notes: async () => toCount(await db("notes").where("tenant_id", tenantId).count({ count: "*" })),
    password_resets: async () => toCount(await db("password_resets").where("tenant_id", tenantId).count({ count: "*" })),
    provider_broadcast_targets: async () => toCount(await platform("provider_broadcast_targets").where("tenant_id", tenantId).count({ count: "*" })),
    subscription_notices: async () => toCount(await platform("subscription_notices").where("tenant_id", tenantId).count({ count: "*" })),
  };
  for (const [name, count] of Object.entries(extra)) {
    try {
      counts[name] = await count();
    } catch {
      // a table this database doesn't have: nothing to count
    }
  }
  return counts;
}

// POST /tenants/:id/purge { slug }: only from the recycle bin, and only with the tenant's address typed to confirm.
// The tenant row goes; foreign-key cascades remove everything that belongs to it.
router.post("/tenants/:id/purge", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const { slug: typed } = validate(z.object({ slug: z.string().trim().toLowerCase().min(1, "Type the tenant's address to confirm.") }), req.body ?? {});
  const db = getDb();
  const tenant = await findTenant(db, id, { allowDeleted: true });
  if (!tenant.deletedAt) throw new HttpError(409, "Only tenants in the recycle bin can be deleted permanently. Delete it first.", { code: "TENANT_NOT_DELETED" });
  if (typed !== tenant.slug) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { slug: `Type ${tenant.slug} to confirm.` } });

  const before = await purgeCounts(db, id);
  const broadcastIds = (await db("provider_broadcast_targets").where("tenant_id", id).distinct("broadcast_id")).map(row => row.broadcast_id);
  // A dedicated database: its copy of the tenant row goes first (foreign keys remove the tenant's rows there). The
  // database itself (or SQLite file) stays: the provider owns it and may keep it as a backup.
  const dedicated = Boolean(dedicatedConfig(id));
  if (dedicated) await tenantDb(id)("tenants").where({ id }).del();
  await db.transaction(async trx => {
    await trx("tenants").where({ id }).del();
    // Broadcasts addressed only to this tenant have nobody left to reach.
    if (broadcastIds.length) await trx("provider_broadcasts").whereIn("id", broadcastIds).whereNot("audience", "all").whereNotExists(sub => sub.select("id").from("provider_broadcast_targets").whereRaw("provider_broadcast_targets.broadcast_id = provider_broadcasts.id")).del();
  });
  if (await db("tenants").where({ id }).first("id")) throw new HttpError(500, "The tenant could not be deleted.");
  if (dedicated) {
    await closeTenantPool(id);
    await loadRegistry();
  }
  const removed = Object.fromEntries(Object.entries(before).filter(([, count]) => count > 0));
  const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
  await audit(req, "purge_tenant", `tenants#${id}`, { name: tenant.name, slug: tenant.slug, rows: total, users: removed.users ?? 0 }, id);
  res.json({ id, name: tenant.name, slug: tenant.slug, removed, total });
});

// ---- Subscription: send the renewal notice now (the scheduler also sends them 30/14/7/3/1/0 days before) ----
router.post("/tenants/:id/renewal-reminder", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findTenant(db, id);
  const row = await db("tenants").where({ id }).first();
  if (!row.subscription_ends_on) throw new HttpError(422, "This tenant's subscription has no end date, so there is nothing to renew.", { code: "NO_END_DATE" });
  const result = await sendSubscriptionNotice(db, row, { createdBy: req.admin.username });
  await audit(req, "renewal_reminder", `tenants#${id}`, { endsOn: row.subscription_ends_on, recipients: result.recipients }, id);
  res.json(result);
});

/** Roles that come with licensed modules (a clinic's Doctor, Nurse, Receptionist); idempotent. */
async function ensureModuleRoles(db, tenantId, features, now) {
  if (typeof permissionsService.ensureModuleRoles === "function") await permissionsService.ensureModuleRoles(db, tenantId, features, now);
}

// ---- Export one tenant as a self-hostable app: code + data + a standalone edition file (services/standaloneExport.js) ----
// Streams a ZIP. The client hosts it themselves; their people keep their passwords. Tenants in the recycle bin are refused.
router.get("/tenants/:id/export", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findTenant(db, id);
  const { database: _connection, ...row } = await db("tenants").where({ id }).first();
  const filename = standaloneFileName(row.slug);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Export-Filename", filename);
  try {
    const result = await runInTenant(id, () => writeStandaloneZip(tenantDb(id), row, res));
    await audit(req, "export_standalone", `tenants#${id}`, { slug: row.slug, files: result.files, rows: result.rows }, id);
  } catch (error) {
    console.error("[export] standalone export failed:", error);
    // Headers (and maybe part of the file) are already sent: end the download so the browser reports it as failed.
    if (!res.headersSent) {
      for (const header of ["Content-Type", "Content-Disposition", "X-Export-Filename"]) res.removeHeader(header);
      throw error;
    }
    res.destroy(error);
  }
});

/** Like validate(), but nested owner fields report as ownerName / ownerEmail / ownerPassword (plus "owner"). */
function validateNewTenant(body) {
  const result = tenantSchema.safeParse(body);
  if (result.success) return result.data;
  const errors = {};
  for (const issue of result.error.issues) {
    const [first, second] = issue.path.map(String);
    const field = first === "owner" && second ? `owner${second[0].toUpperCase()}${second.slice(1)}` : (first ?? "form");
    errors[field] ??= issue.message;
    if (first === "owner") errors.owner ??= issue.message;
  }
  throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors });
}

router.post("/tenants", requireAdmin, async (req, res) => {
  const { database: databaseInput, ...body } = req.body ?? {};
  const input = validateNewTenant(body);
  const choice = validate(databaseChoice, databaseInput ?? {});
  const db = getDb();
  const wanted = input.slug ?? slugify(input.name);
  if (input.slug && (await db("tenants").where({ slug: wanted }).first())) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { slug: "Another tenant already uses this address." } });
  }
  const now = nowIso();
  if (choice.mode === "dedicated") {
    const config = validateDatabaseInput(choice.config ?? {});
    const result = await createDedicatedTenant(req, input, config, { slug: input.slug ? wanted : await uniqueSlug(db, wanted), now, createDatabase: choice.createDatabase });
    return res.status(201).json(result);
  }
  const { tenantId, ownerId } = await db.transaction(async trx => {
    const id = await insertAndGetId(trx, "tenants", {
      name: input.name,
      slug: input.slug ? wanted : await uniqueSlug(trx, wanted),
      status: "active",
      industry: input.industry ?? DEFAULT_INDUSTRY,
      features: JSON.stringify(input.features),
      max_users: input.maxUsers,
      contact_email: input.contactEmail || null,
      settings: applySettingsPatch(null, input.settings),
      plan: input.plan,
      // default start: today (or the end date, when that is already past)
      subscription_starts_on: input.subscriptionStartsOn ?? [now.slice(0, 10), input.subscriptionEndsOn].filter(Boolean).sort()[0],
      subscription_ends_on: input.subscriptionEndsOn ?? null,
      grace_days: input.graceDays,
      created_at: now,
      updated_at: now,
    });
    const roleIds = await seedTenantRoles(trx, id, now);
    await ensureModuleRoles(trx, id, input.features, now); // e.g. Doctor, Nurse, Receptionist for a licensed clinic
    // Emails are unique per workspace, so an owner may reuse an address from another tenant; field errors map to owner*.
    const owner = await createUser(trx, { tenantId: id, ...input.owner, role: "admin", roleIds: [roleIds.owner, roleIds.admin] }).catch(error => {
      if (error?.errors?.email) error.errors = { ownerEmail: error.errors.email, owner: error.errors.email };
      throw error;
    });
    return { tenantId: id, ownerId: owner };
  });
  const createdTenant = await findTenant(db, tenantId);
  if (createdTenant) {
    await createTenantAccessCode({ id: tenantId, name: createdTenant.name, slug: createdTenant.slug });
  }
  await audit(req, "create_tenant", `tenants#${tenantId}`, { name: input.name, owner: input.owner.email, industry: input.industry ?? DEFAULT_INDUSTRY, features: input.features.join(" ") }, tenantId);
  res.status(201).json({ ...createdTenant, ownerId });
});

/** The row a new tenant starts with (registry, and the copy in a dedicated database). */
function newTenantRow(input, slug, now) {
  return {
    name: input.name,
    slug,
    status: "active",
    industry: input.industry ?? DEFAULT_INDUSTRY,
    features: JSON.stringify(input.features),
    max_users: input.maxUsers,
    contact_email: input.contactEmail || null,
    settings: applySettingsPatch(null, input.settings),
    plan: input.plan,
    subscription_starts_on: input.subscriptionStartsOn ?? [now.slice(0, 10), input.subscriptionEndsOn].filter(Boolean).sort()[0],
    subscription_ends_on: input.subscriptionEndsOn ?? null,
    grace_days: input.graceDays,
    created_at: now,
    updated_at: now,
  };
}

/** Connection problems as field errors of the console's database form. */
function databaseError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(422, describeConnectionError(error), { code: "DATABASE_UNAVAILABLE", errors: { database: describeConnectionError(error) } });
}

/**
 * A tenant in a database of its own: the database is prepared first (tables of its modules), then the registry row,
 * then the tenant's copy, roles, and owner in its database. Anything that fails undoes the registry row.
 */
async function createDedicatedTenant(req, input, config, { slug, now, createDatabase }) {
  const db = getDb();
  let prepared;
  try {
    prepared = await prepareDatabase(config, input.features, { createDatabase });
  } catch (error) {
    throw databaseError(error);
  }
  const tenantId = await insertAndGetId(db, "tenants", { ...newTenantRow(input, slug, now), database: storedDatabase(config) });
  let ownerId;
  try {
    await loadRegistry();
    await syncTenantMirror(tenantId);
    ownerId = await runInTenant(tenantId, () =>
      tenantDb(tenantId).transaction(async trx => {
        const roleIds = await seedTenantRoles(trx, tenantId, now);
        await ensureModuleRoles(trx, tenantId, input.features, now);
        return createUser(trx, { tenantId, ...input.owner, role: "admin", roleIds: [roleIds.owner, roleIds.admin] }).catch(error => {
          if (error?.errors?.email) error.errors = { ownerEmail: error.errors.email, owner: error.errors.email };
          throw error;
        });
      })
    );
  } catch (error) {
    await tenantDb(tenantId)("tenants").where({ id: tenantId }).del().catch(() => {});
    await db("tenants").where({ id: tenantId }).del();
    await closeTenantPool(tenantId);
    await loadRegistry();
    throw error;
  }
  await audit(req, "create_tenant", `tenants#${tenantId}`, { name: input.name, owner: input.owner.email, industry: input.industry ?? DEFAULT_INDUSTRY, features: input.features.join(" "), database: describeDatabase(config), tables: prepared.tables.length }, tenantId);
  return { ...(await findTenant(db, tenantId)), ownerId, databaseVersion: prepared.version, tablesCreated: prepared.tables };
}

router.patch("/tenants/:id", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const before = await findTenant(db, id);
  const { database: databaseInput, ...body } = req.body ?? {};
  const input = validate(tenantUpdateSchema, body);
  // Modules and industry: checked together against what's stored (no module is ever dropped silently).
  if (input.features !== undefined && input.industry === undefined && before.industry === DEFAULT_INDUSTRY) input.features = withRequirements(input.features);
  if (input.features !== undefined || input.industry !== undefined) {
    const nextIndustry = input.industry ?? before.industry;
    const nextFeatures = input.features ?? before.features;
    const errors = checkModules(nextIndustry, nextFeatures);
    const outside = modulesOutside(nextIndustry, nextFeatures);
    if (input.industry !== undefined && input.industry !== before.industry && input.features === undefined && outside.length) {
      const them = outside.length === 1 ? "it" : "them";
      errors.industry = `${industryOf(nextIndustry).label} doesn't include ${outside.map(moduleLabel).join(", ")}. Remove ${them} from the modules first, or keep the current industry.`;
    }
    if (Object.keys(errors).length) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors });
  }
  const changes = {};
  if (input.name !== undefined) {
    changes.name = input.name;
    await getPlatformDb()("tenant_access_codes").where({ tenant_id: id }).update({ tenant_name: input.name });
  }
  if (input.status !== undefined) changes.status = input.status;
  if (input.industry !== undefined) changes.industry = input.industry;
  if (input.features !== undefined) changes.features = JSON.stringify(input.features);
  if (input.maxUsers !== undefined) changes.max_users = input.maxUsers;
  if (input.contactEmail !== undefined) changes.contact_email = input.contactEmail || null;
  if (input.settings !== undefined) {
    const stored = await db("tenants").where({ id }).first();
    changes.settings = applySettingsPatch(stored.settings, input.settings);
  }
  // Subscription: checked against the stored dates when only one of them changes.
  if (input.plan !== undefined) changes.plan = input.plan;
  if (input.subscriptionStartsOn !== undefined) changes.subscription_starts_on = input.subscriptionStartsOn;
  if (input.subscriptionEndsOn !== undefined) changes.subscription_ends_on = input.subscriptionEndsOn;
  if (input.graceDays !== undefined) changes.grace_days = input.graceDays;
  const startsOn = input.subscriptionStartsOn !== undefined ? input.subscriptionStartsOn : before.subscription.startsOn;
  const endsOn = input.subscriptionEndsOn !== undefined ? input.subscriptionEndsOn : before.subscription.endsOn;
  if (startsOn && endsOn && endsOn < startsOn) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { subscriptionEndsOn: END_BEFORE_START } });
  const graceDays = input.graceDays ?? before.subscription.graceDays;
  const datesChanged = endsOn !== before.subscription.endsOn || graceDays !== before.subscription.graceDays;

  // A dedicated database: new connection details (the same data, moved or with new credentials), checked first.
  if (databaseInput?.config) {
    if (!dedicatedConfig(id)) throw new HttpError(422, "This tenant uses the platform database. Its data can't be moved to another database here yet.", { code: "DATABASE_MOVE_UNSUPPORTED", errors: { database: "Moving an existing tenant to its own database isn't supported yet." } });
    const config = validateDatabaseInput(databaseInput.config, dedicatedConfig(id));
    try {
      await testConnection(config);
      const probe = createKnex(config, { pool: { min: 0, max: 1 } });
      try {
        if (!(await existingTables(probe)).has("tenants") || !(await probe("tenants").where({ id }).first("id"))) {
          throw new HttpError(422, "That database doesn't hold this tenant's data. Copy the data there first, then change the connection.", { code: "DATABASE_MISMATCH", errors: { database: "That database doesn't hold this tenant's data." } });
        }
      } finally {
        await probe.destroy();
      }
    } catch (error) {
      throw databaseError(error);
    }
    changes.database = storedDatabase(config);
  }
  // New modules: their tables first (a dedicated database has only what its modules need).
  if (input.features !== undefined && dedicatedConfig(id)) {
    try {
      await ensureTenantSchema(id, input.features);
    } catch (error) {
      throw databaseError(error);
    }
  }
  if (Object.keys(changes).length) await db("tenants").where({ id }).update({ ...changes, updated_at: nowIso() });
  if (changes.database) await loadRegistry();
  if (dedicatedConfig(id)) {
    if (changes.database) await ensureTenantSchema(id, input.features ?? before.features);
    await syncTenantMirror(id);
  }
  if (input.features !== undefined) await ensureModuleRoles(tenantDb(id), id, input.features, nowIso());
  // New dates: earlier "ends in N days" notices no longer apply (the scheduler sends fresh ones for the new end date).
  if (datesChanged) await expireSubscriptionNotices(db, id);
  const nowExpired = datesChanged && subscriptionExpired(endsOn, graceDays) && !subscriptionExpired(before.subscription.endsOn, before.subscription.graceDays);
  // Suspended, expired, or modules (and so permissions) changed: end everyone's live sockets so their tabs re-check the session.
  if ((input.status === "suspended" && before.status !== "suspended") || input.features !== undefined || nowExpired) {
    await disconnectTenant(db, id, input.status === "suspended" ? "Workspace suspended" : nowExpired ? "Subscription ended" : "Access changed");
  }

  const details = {};
  if (input.status && input.status !== before.status) details.status = `${before.status} -> ${input.status}`;
  if (input.industry && input.industry !== before.industry) details.industry = `${before.industry} -> ${input.industry}`;
  if (input.features) details.features = input.features.join(" ");
  if (input.maxUsers !== undefined) details.maxUsers = input.maxUsers ?? "unlimited";
  if (input.name && input.name !== before.name) details.name = input.name;
  if (input.settings) details.settings = Object.keys(input.settings).join(" ");
  if (input.plan !== undefined && input.plan !== before.subscription.plan) details.plan = input.plan;
  if (datesChanged) details.subscription = `ends ${endsOn ?? "never"}, ${graceDays} grace days`;
  if (changes.database) details.database = describeDatabase(dedicatedConfig(id));
  await audit(req, "update_tenant", `tenants#${id}`, details, id);
  res.json(await findTenant(db, id));
});

router.get("/tenants/:id/users", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  await findTenant(getDb(), id);
  const db = tenantDb(id);
  const [users, roleNames, admins] = await Promise.all([
    db("users").where({ tenant_id: id }).orderBy("is_active", "desc").orderByRaw("lower(name)"),
    roleNamesByUser(db, id),
    usersWithPermission(db, id, ADMIN_PERMISSION).then(ids => new Set(ids)),
  ]);
  res.json(
    users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      roles: roleNames.get(user.id) ?? [],
      jobTitle: user.job_title,
      isActive: Boolean(user.is_active),
      /** owner or manages users: receives "tenant admins only" broadcasts */
      isAdmin: admins.has(user.id),
      createdAt: user.created_at,
    }))
  );
});

// A tenant's roles (built-in and custom) with their permissions and how many people hold each.
router.get("/tenants/:id/roles", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  await findTenant(getDb(), id);
  const db = tenantDb(id);
  const [roles, members] = await Promise.all([
    db("roles").where({ tenant_id: id }).orderBy("is_system", "desc").orderBy("id"),
    db("user_roles as ur").join("users as u", "u.id", "ur.user_id").where("u.tenant_id", id).select("ur.role_id").count({ total: "*" }).sum({ active: db.raw("case when u.is_active then 1 else 0 end") }).groupBy("ur.role_id"),
  ]);
  const byRole = new Map(members.map(row => [Number(row.role_id), { total: Number(row.total), active: Number(row.active ?? 0) }]));
  const parse = text => { try { const list = JSON.parse(text ?? "[]"); return Array.isArray(list) ? list : []; } catch { return []; } };
  res.json(
    roles.map(role => ({
      id: role.id,
      key: role.key ?? null,
      name: role.name,
      description: role.description ?? "",
      isSystem: Boolean(role.is_system),
      permissions: parse(role.permissions),
      members: byRole.get(role.id) ?? { total: 0, active: 0 },
      createdAt: role.created_at,
      updatedAt: role.updated_at,
    }))
  );
});

router.post("/tenants/:id/users", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(tenantUserSchema, req.body);
  await findTenant(getDb(), id);
  const userId = await runInTenant(id, () => createUser(tenantDb(id), { tenantId: id, ...input }));
  await audit(req, "create_user", `users#${userId}`, { email: input.email, role: input.role }, id);
  res.status(201).json({ id: userId });
});

router.patch("/users/:id/active", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const { isActive } = validate(z.object({ isActive: z.boolean() }), req.body);
  const { user, db } = await findUser(req, id);
  if (isActive && !user.is_active) await assertSeatAvailable(db, user.tenant_id);
  await db("users").where({ id }).update({ is_active: isActive });
  if (!isActive) runInTenant(user.tenant_id, () => disconnectUser(id, "Account deactivated"));
  await audit(req, isActive ? "activate_user" : "deactivate_user", `users#${id}`, { email: user.email }, user.tenant_id);
  res.json({ id, isActive });
});

// ---- Jobs: run the daily greetings now (normally every 10 minutes, once per person per year) ----
router.post("/jobs/celebrations", requireAdmin, async (req, res) => {
  const sent = await processCelebrations();
  await audit(req, "run_job", "celebrations", { sent });
  res.json({ sent });
});

// Run the broadcast scheduler now (normally every minute / hour): due subscription notices, then scheduled broadcasts.
router.post("/jobs/subscriptions", requireAdmin, async (req, res) => {
  const notices = await processSubscriptionNotices();
  const published = await publishDueBroadcasts();
  await audit(req, "run_job", "subscriptions", { notices, published });
  res.json({ notices, published });
});

// ---- Announcements to tenants (routes/adminBroadcasts.js) ----
router.use("/broadcasts", consoleBroadcastsRouter({ requireAdmin, audit }));

// ---- Maintenance windows: the whole platform or one tenant (routes/adminMaintenance.js) ----
router.use("/maintenance", consoleMaintenanceRouter({ requireAdmin, audit }));

// ---- Audit log ----
// Without a tenant: the console's own log. With ?tenantId: the tenant's own audit log (tenant_audit) merged with
// console actions about that tenant, newest first; ?source=console|tenant narrows it to one of the two.
router.get("/audit", requireAdmin, async (req, res) => {
  const { page, pageSize, tenantId, source } = validate(auditQuerySchema, req.query);
  const db = getDb();
  if (tenantId) await findTenant(db, tenantId);

  const consoleRows = () => {
    const query = db("admin_audit").select(db.raw("'console' as source"), "id", "actor", "action", "target", "details", "ip", "created_at");
    return tenantId ? consoleAuditFor(query, tenantId) : query;
  };
  const tenantRows = () =>
    db("tenant_audit as a")
      .leftJoin("users as u", "u.id", "a.actor_id")
      .where("a.tenant_id", tenantId)
      .select(db.raw("'tenant' as source"), "a.id", db.raw("coalesce(u.name, 'System') as actor"), "a.action", "a.target", "a.details", db.raw("null as ip"), "a.created_at");

  // A tenant with its own database: its log is there, so the two are merged here instead of in SQL.
  if (tenantId && source !== "console" && dedicatedConfig(tenantId)) {
    const own = tenantDb(tenantId);
    const theirs = () =>
      own("tenant_audit as a")
        .leftJoin("users as u", "u.id", "a.actor_id")
        .where("a.tenant_id", tenantId)
        .select(own.raw("'tenant' as source"), "a.id", own.raw("coalesce(u.name, 'System') as actor"), "a.action", "a.target", "a.details", own.raw("null as ip"), "a.created_at");
    const wanted = page * pageSize;
    const [tenantTotal, tenantList, consoleTotal, consoleList] = await Promise.all([
      own("tenant_audit").where("tenant_id", tenantId).count({ count: "*" }).then(toCount),
      theirs().orderBy("a.created_at", "desc").orderBy("a.id", "desc").limit(wanted),
      source === "tenant" ? 0 : consoleRows().clone().clearSelect().count({ count: "*" }).then(toCount),
      source === "tenant" ? [] : consoleRows().orderBy("created_at", "desc").orderBy("id", "desc").limit(wanted),
    ]);
    const merged = [...tenantList, ...consoleList].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
    return res.json(auditPage(merged.slice((page - 1) * pageSize, page * pageSize), tenantTotal + consoleTotal, page, pageSize));
  }

  let union;
  if (!tenantId || source === "console") union = consoleRows();
  else if (source === "tenant") union = tenantRows();
  else union = consoleRows().unionAll(tenantRows());

  const total = toCount(await db.from(union.clone().as("e")).count({ count: "*" }));
  const rows = await db
    .from(union.as("e"))
    .select("*")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  res.json(auditPage(rows, total, page, pageSize));
});

/** One page of the audit log in the console's shape. */
function auditPage(rows, total, page, pageSize) {
  const parse = text => {
    if (!text) return null;
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : { value };
    } catch {
      return { value: text };
    }
  };

  return {
    entries: rows.map(row => ({
      id: row.id,
      key: `${row.source}-${row.id}`,
      source: row.source,
      actor: row.actor,
      action: row.action,
      target: row.target,
      details: parse(row.details),
      ip: row.ip ?? null,
      createdAt: row.created_at,
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---- Databases: the platform database, engines, connection tests, and what each module stores (routes/adminDatabase.js) ----
router.use("/databases", consoleDatabaseRouter({ requireAdmin, audit }));

export default router;
