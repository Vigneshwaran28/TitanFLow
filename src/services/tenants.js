// Tenants (one per customer company) and the modules each one is licensed to use.
import { getEdition } from "../config/edition.js";
import { HttpError } from "../utils/http.js";
import { resolveSettings } from "./moduleSettings.js";

/** Module keys a tenant can be given. Order is display order. */
export const FEATURES = Object.freeze(["tasks", "helpdesk", "directory", "messaging", "announcements", "inventory", "sales", "billing", "logistics", "attendance", "expenses", "clinic", "notes"]);

/**
 * Workspace addresses the web app needs for itself: its top-level pages (/login, /bunny, ...) and the app sections
 * under a workspace (/<slug>/billing). Mirrors web/src/lib/tenantPath.ts.
 */
export const RESERVED_SLUGS = new Set([
  "login", "register", "setup", "bunny", "admin", "track", "q", "w", "reset-password", "api", "_next",
  "tasks", "lists", "calendar", "tickets", "teams", "people", "messages", "announcements", "inventory", "sales", "billing",
  "logistics", "attendance", "expenses", "clinic", "clinic-display", "notes", "users", "roles", "audit", "settings",
]);

/**
 * The licensed modules stored on a tenant. A standalone install (config/edition.js) is licensed for exactly the
 * modules in its edition file, whatever the database says: nobody can change them there.
 * @param {string | null | undefined} json
 */
export function parseFeatures(json) {
  const edition = getEdition();
  if (edition) return FEATURES.filter(key => edition.features.includes(key));
  try {
    const list = JSON.parse(json ?? "[]");
    return Array.isArray(list) ? FEATURES.filter(key => list.includes(key)) : [];
  } catch {
    return [];
  }
}

/**
 * The modules people in a workspace can use: the licensed ones, minus any the workspace's admins switched off
 * (settings.security.disabledModules). Licensing stays the provider's; switching off is the tenant's own restriction.
 * @param {string | null | undefined} featuresJson - tenants.features
 * @param {Object} settings - resolved settings (resolveSettings)
 */
export function effectiveFeatures(featuresJson, settings) {
  const off = new Set(settings?.security?.disabledModules ?? []);
  return parseFeatures(featuresJson).filter(key => !off.has(key));
}

/** @param {Object} row - tenants row */
export function toTenant(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    features: parseFeatures(row.features),
    /** hospital, logistics, retail, services, or custom (services/moduleCatalog.js); older tenants are custom */
    industry: row.industry ?? "custom",
    maxUsers: row.max_users ?? null,
    contactEmail: row.contact_email ?? null,
    settings: resolveSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Throws when a tenant can't add another active user. */
export async function assertSeatAvailable(db, tenantId) {
  const tenant = await db("tenants").where({ id: tenantId }).first();
  if (!tenant?.max_users) return;
  const [{ count }] = await db("users").where({ tenant_id: tenantId, is_active: true }).count({ count: "*" });
  if (Number(count) >= tenant.max_users) {
    throw new HttpError(422, `This workspace's plan allows ${tenant.max_users} active users. Deactivate someone or ask for a higher limit.`, {
      code: "USER_LIMIT_REACHED",
    });
  }
}
