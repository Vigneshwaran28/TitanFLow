// Maintenance windows, set by the provider in the console: one for the whole platform (every tenant) and one per
// tenant. While a window is active, the workspace's people see a maintenance page instead of the app (the API answers
// 503 MAINTENANCE); with allowAdmins, the workspace's owners and admins can still sign in to check things.
// A window may be scheduled (startsAt in the future: people see a notice first) and ends by itself at endsAt.
import { getPlatformDb } from "../db/connection.js";
import { HttpError, nowIso } from "../utils/http.js";

const GLOBAL_KEY = "maintenance";
const CACHE_MS = 5_000;
/** Scheduled windows starting within this time are announced in the app. */
export const NOTICE_HOURS = 72;

/** @typedef {{ enabled: boolean, message: string, startsAt: string | null, endsAt: string | null, allowAdmins: boolean, updatedAt: string | null, updatedBy: string | null }} Maintenance */

/** @type {Maintenance} */
export const NO_MAINTENANCE = Object.freeze({ enabled: false, message: "", startsAt: null, endsAt: null, allowAdmins: true, updatedAt: null, updatedBy: null });

/** Stored JSON (or null) -> a complete window. */
export function parseMaintenance(json) {
  try {
    const value = typeof json === "string" ? JSON.parse(json) : json;
    return value && typeof value === "object" ? { ...NO_MAINTENANCE, ...value } : { ...NO_MAINTENANCE };
  } catch {
    return { ...NO_MAINTENANCE };
  }
}

/** off, scheduled (starts later), active, or ended (its end time passed: it no longer applies). */
export function maintenanceState(window, now = Date.now()) {
  if (!window?.enabled) return "off";
  if (window.endsAt && now >= Date.parse(window.endsAt)) return "ended";
  if (window.startsAt && now < Date.parse(window.startsAt)) return "scheduled";
  return "active";
}

export const withState = window => ({ ...window, state: maintenanceState(window) });

// ---- The platform-wide window (platform_settings row), cached briefly: every request reads it ----
let cache = null;

// The platform window lives in the platform database, whichever database the caller works on (`db` is ignored).
export async function getGlobalMaintenance(_db) {
  const db = getPlatformDb();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await db("platform_settings").where({ key: GLOBAL_KEY }).first();
  const value = parseMaintenance(row?.value);
  cache = { at: Date.now(), value };
  return value;
}

export async function setGlobalMaintenance(_db, window) {
  const db = getPlatformDb();
  const value = JSON.stringify(window);
  const updated = await db("platform_settings").where({ key: GLOBAL_KEY }).update({ value, updated_at: nowIso() });
  if (!updated) await db("platform_settings").insert({ key: GLOBAL_KEY, value, updated_at: nowIso() });
  cache = null;
}

/** What people of a workspace see: the active window (the platform's first), or null. */
export function activeWindow(global, tenant) {
  if (maintenanceState(global) === "active") return { scope: "platform", ...pick(global) };
  if (maintenanceState(tenant) === "active") return { scope: "workspace", ...pick(tenant) };
  return null;
}

/** The next scheduled window starting within NOTICE_HOURS, for the in-app notice, or null. */
export function upcomingWindow(global, tenant, now = Date.now()) {
  const soon = [
    { scope: "platform", window: global },
    { scope: "workspace", window: tenant },
  ].filter(({ window }) => maintenanceState(window, now) === "scheduled" && Date.parse(window.startsAt) - now <= NOTICE_HOURS * 3_600_000);
  soon.sort((a, b) => Date.parse(a.window.startsAt) - Date.parse(b.window.startsAt));
  return soon[0] ? { scope: soon[0].scope, ...pick(soon[0].window) } : null;
}

const pick = window => ({ message: window.message, startsAt: window.startsAt, endsAt: window.endsAt, allowAdmins: window.allowAdmins });

/** Owners and admins (who manage settings) may use a workspace during a window that allows admins. */
export const bypassesMaintenance = (window, access) => Boolean(window?.allowAdmins && (access?.isOwner || access?.permissions?.includes("workspace.settings.manage")));

export function maintenanceError(window) {
  const message = window.scope === "platform" ? "TaskFlow is down for scheduled maintenance. Please check back soon." : "This workspace is down for maintenance. Please check back soon.";
  return new HttpError(503, message, { code: "MAINTENANCE", data: { maintenance: window } });
}

/**
 * The maintenance situation of a workspace for its people: { active, upcoming }, from the tenant's stored window
 * (the `maintenance` column, or `tenant_maintenance` on joined rows).
 */
export async function workspaceMaintenance(db, tenantJson) {
  const global = await getGlobalMaintenance(db);
  const tenant = parseMaintenance(tenantJson);
  return { active: activeWindow(global, tenant), upcoming: upcomingWindow(global, tenant) };
}
