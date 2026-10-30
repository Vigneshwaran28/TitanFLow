import crypto from "node:crypto";
import { getPlatformDb } from "../db/connection.js";
import { HttpError, nowIso } from "../utils/http.js";

/** Prefix used for standard Taskflow tenant PIN codes. */
export const CODE_PREFIX = "TF-";

/**
 * Generates a clean, cryptographically random numeric PIN code (e.g. TF-749210).
 */
export function generateRandomPinCode() {
  const pinNumber = crypto.randomInt(100000, 999999);
  return `${CODE_PREFIX}${pinNumber}`;
}

/**
 * Normalizes user-entered access code, handling with or without the TF- prefix.
 */
export function normalizeAccessCode(input) {
  if (!input) return "";
  const trimmed = String(input).trim().toUpperCase();
  // Strip extraneous spaces or hyphens
  return trimmed;
}

/**
 * Finds a unique code that is not already in use in the platform database.
 */
export async function generateUniqueAccessCode(platform = getPlatformDb()) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = generateRandomPinCode();
    const existing = await platform("tenant_access_codes").where({ code: candidate }).first();
    if (!existing) return candidate;
  }
  // Fallback with random alphanumeric suffix if collisions occur
  const randomSuffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${CODE_PREFIX}${randomSuffix}`;
}

/**
 * Formats a database row for client consumption.
 */
export function toAccessCodeDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    code: row.code,
    name: row.name,
    type: row.type,
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
    isDeleted: Boolean(row.is_deleted),
    usageCount: Number(row.usage_count ?? 0),
    maxUses: row.max_uses != null ? Number(row.max_uses) : null,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Retrieves the currently active, non-deleted security code for a tenant.
 * If none exists, one is generated and stored automatically.
 */
export async function getActiveTenantAccessCode(tenantId) {
  const platform = getPlatformDb();
  let row = await platform("tenant_access_codes")
    .where({ tenant_id: tenantId, is_deleted: false, is_active: true })
    .orderBy("id", "desc")
    .first();

  if (row) return toAccessCodeDto(row);

  // Generate on demand if the tenant doesn't have an active code yet
  const tenant = await platform("tenants").where({ id: tenantId }).first();
  if (!tenant) throw new HttpError(404, "Workspace not found.");

  return createTenantAccessCode(tenant);
}

/**
 * Creates a new access code record for a tenant.
 */
export async function createTenantAccessCode(tenant, { createdBy = null, name = "Tenant Security PIN", type = "login_pin" } = {}) {
  const platform = getPlatformDb();
  const code = await generateUniqueAccessCode(platform);
  const now = nowIso();

  let validCreatedBy = createdBy;
  if (validCreatedBy) {
    const userExists = await platform("users").where({ id: validCreatedBy }).first();
    if (!userExists) validCreatedBy = null;
  }

  const [id] = await platform("tenant_access_codes").insert({
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    tenant_slug: tenant.slug,
    code,
    name,
    type,
    description: "Tenant access code for user creation and login",
    is_active: true,
    is_deleted: false, // Soft delete: true or false only
    usage_count: 0,
    created_by: validCreatedBy,
    created_at: now,
    updated_at: now,
  });

  const row = await platform("tenant_access_codes").where({ id }).first();
  return toAccessCodeDto(row);
}

/**
 * Regenerates the tenant's security PIN/code:
 * Soft deletes any existing active codes (is_deleted = true, is_active = false)
 * and generates a fresh unique random code in the common table.
 */
export async function regenerateTenantAccessCode(tenantId, userId = null) {
  const platform = getPlatformDb();
  const tenant = await platform("tenants").where({ id: tenantId }).first();
  if (!tenant) throw new HttpError(404, "Workspace not found.");

  const now = nowIso();

  // Soft-delete all existing active codes for this tenant (is_deleted: true, is_active: false)
  await platform("tenant_access_codes")
    .where({ tenant_id: tenantId, is_deleted: false })
    .update({
      is_deleted: true,
      is_active: false,
      updated_at: now,
    });

  return createTenantAccessCode(tenant, { createdBy: userId });
}

/**
 * Looks up a tenant from the common table by access code / security PIN.
 * Checks soft delete (is_deleted = false) and active status.
 */
export async function findTenantByAccessCode(rawCode) {
  if (!rawCode) return null;
  const platform = getPlatformDb();
  const clean = normalizeAccessCode(rawCode);

  // Accept with or without the TF- prefix (e.g. 749210 or TF-749210)
  const candidates = [clean];
  if (!clean.startsWith(CODE_PREFIX)) {
    candidates.push(`${CODE_PREFIX}${clean}`);
  } else {
    candidates.push(clean.slice(CODE_PREFIX.length));
  }

  const row = await platform("tenant_access_codes")
    .whereIn("code", candidates)
    .where({ is_deleted: false, is_active: true })
    .first();

  if (!row) return null;

  // Verify expiration
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { problem: "EXPIRED", message: "This security PIN has expired.", row };
  }

  // Verify max uses
  if (row.max_uses != null && Number(row.usage_count) >= Number(row.max_uses)) {
    return { problem: "MAX_USES_REACHED", message: "This security PIN has reached its maximum allowed uses.", row };
  }

  return { valid: true, row, code: toAccessCodeDto(row) };
}

/**
 * Increments the usage count and updates the last_used_at timestamp on successful login or user creation.
 */
export async function recordAccessCodeUsage(codeId) {
  if (!codeId) return;
  const platform = getPlatformDb();
  const now = nowIso();
  await platform("tenant_access_codes")
    .where({ id: codeId })
    .increment("usage_count", 1)
    .update({
      last_used_at: now,
      updated_at: now,
    });
}
