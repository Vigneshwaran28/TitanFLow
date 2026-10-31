import crypto from "node:crypto";
import { getPlatformDb } from "../db/connection.js";
import { resolveSettings } from "./moduleSettings.js";
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
    userId: row.user_id ?? null,
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
 * Synchronizes a user's personal login code into the common tenant_access_codes table.
 */
export async function syncUserAccessCode(tenant, user, { isActive = true, newCode = null } = {}) {
  const platform = getPlatformDb();
  const code = newCode || user.login_code;
  if (!code) return null;
  const now = nowIso();

  const existing = await platform("tenant_access_codes").where({ user_id: user.id }).first();
  if (existing) {
    await platform("tenant_access_codes").where({ id: existing.id }).update({
      code,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      tenant_slug: tenant.slug,
      is_active: isActive,
      is_deleted: false,
      updated_at: now,
    });
    return toAccessCodeDto(await platform("tenant_access_codes").where({ id: existing.id }).first());
  }

  const [id] = await platform("tenant_access_codes").insert({
    tenant_id: tenant.id,
    user_id: user.id,
    tenant_name: tenant.name,
    tenant_slug: tenant.slug,
    code,
    name: `${user.name} Login Code`,
    type: "user_login",
    description: "User personal login access code",
    is_active: isActive,
    is_deleted: false,
    usage_count: 0,
    created_at: now,
    updated_at: now,
  });

  return toAccessCodeDto(await platform("tenant_access_codes").where({ id }).first());
}

/**
 * Retrieves the currently active, non-deleted security code for a tenant.
 * If none exists, one is generated and stored automatically.
 */
export async function getActiveTenantAccessCode(tenantId) {
  const platform = getPlatformDb();
  let row = await platform("tenant_access_codes")
    .where({ tenant_id: tenantId, is_deleted: false, is_active: true, type: "login_pin" })
    .orderBy("id", "desc")
    .first();

  if (row) return toAccessCodeDto(row);

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
    is_deleted: false,
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

  await platform("tenant_access_codes")
    .where({ tenant_id: tenantId, type: "login_pin", is_deleted: false })
    .update({
      is_deleted: true,
      is_active: false,
      updated_at: now,
    });

  return createTenantAccessCode(tenant, { createdBy: userId });
}

/**
 * Looks up a tenant or user from the common index table (tenant_access_codes) by access code / security PIN.
 * Checks soft delete (is_deleted = false) and active status, and navigates to the corresponding tenant table.
 */
export async function findTenantByAccessCode(rawCode) {
  if (!rawCode) return null;
  const platform = getPlatformDb();
  const clean = normalizeAccessCode(rawCode);

  const candidates = [clean];
  if (!clean.startsWith(CODE_PREFIX)) {
    candidates.push(`${CODE_PREFIX}${clean}`);
  } else {
    candidates.push(clean.slice(CODE_PREFIX.length));
  }

  // 1. Look up in the common index table (tenant_access_codes)
  let row = await platform("tenant_access_codes")
    .whereIn("code", candidates)
    .where({ is_deleted: false })
    .first();

  // Fallback: If not yet in tenant_access_codes, check users table and auto-sync
  if (!row) {
    const userRow = await platform("users as u")
      .join("tenants as t", "t.id", "u.tenant_id")
      .whereIn("u.login_code", candidates)
      .select("u.*", "t.id as tenant_id", "t.name as tenant_name", "t.slug as tenant_slug", "t.status as tenant_status", "t.settings as tenant_settings")
      .first();

    if (userRow) {
      await syncUserAccessCode(
        { id: userRow.tenant_id, name: userRow.tenant_name, slug: userRow.tenant_slug },
        userRow,
        { isActive: userRow.is_code_login_enabled !== false }
      );
      row = await platform("tenant_access_codes").where({ code: userRow.login_code }).first();
    }
  }

  if (!row) return null;

  // Verify active status in the common index table
  if (!row.is_active) {
    return { valid: false, problem: "CODE_DISABLED", message: "This access code is currently disabled." };
  }

  // Verify expiration
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { valid: false, problem: "EXPIRED", message: "This access code has expired.", row };
  }

  // Verify max uses
  if (row.max_uses != null && Number(row.usage_count) >= Number(row.max_uses)) {
    return { valid: false, problem: "MAX_USES_REACHED", message: "This access code has reached its maximum allowed uses.", row };
  }

  // Check workspace status and overall code login setting
  const tenant = await platform("tenants").where({ id: row.tenant_id }).first();
  if (!tenant) return { valid: false, problem: "TENANT_NOT_FOUND", message: "Workspace not found." };
  if (tenant.status !== "active") {
    return { valid: false, problem: "TENANT_SUSPENDED", message: "This workspace is currently suspended." };
  }

  const security = resolveSettings(tenant.settings).security;
  if (security.allowCodeLogin === false) {
    return { valid: false, problem: "WORKSPACE_CODE_LOGIN_DISABLED", message: "Login with access code is disabled for this workspace by the administrator." };
  }

  // If this code represents an individual user's login access code
  if (row.user_id || row.type === "user_login") {
    const user = await platform("users").where({ id: row.user_id || undefined, tenant_id: tenant.id }).first();
    if (!user) {
      return { valid: false, problem: "USER_NOT_FOUND", message: "User account associated with this code was not found." };
    }
    if (!user.is_active) {
      return { valid: false, problem: "USER_DEACTIVATED", message: "This user account is currently deactivated." };
    }
    if (user.is_code_login_enabled === false) {
      return { valid: false, problem: "USER_CODE_DISABLED", message: "Login with access code has been disabled for this account." };
    }

    return {
      valid: true,
      type: "user",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        jobTitle: user.job_title ?? null,
        password_hash: user.password_hash,
        mustChangePassword: Boolean(user.must_change_password),
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      code: toAccessCodeDto(row),
    };
  }

  // Tenant-level security PIN
  return {
    valid: true,
    type: "tenant",
    row,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
    },
    code: toAccessCodeDto(row),
  };
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
