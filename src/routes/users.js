// Workspace user management: create accounts, assign roles, deactivate, reset passwords.
// Everything is limited to the manager's own tenant, and nobody can hand out access they don't have:
// granting a role needs every permission in it, and only owners can make or unmake owners.
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { closeOpenResets, expireStaleLinks, hashResetToken, newResetToken, OPEN_STATUSES } from "../services/passwordResets.js";
import { isLicensed, parsePermissions, rolesByUser } from "../services/permissions.js";
import { startSession } from "../middleware/auth.js";
import { disconnectUser } from "../services/realtime.js";
import { assertEmailAllowed, assertPasswordAllowed, emailDomainProblem } from "../services/securityPolicy.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { assertSeatAvailable } from "../services/tenants.js";
import { ageOf, dateOfBirthSchema, joinedOnSchema } from "../services/personDates.js";
import { createUser, generateUniqueUserLoginCode, resolveRoleIds, ROLES } from "../services/users.js";
import { syncUserAccessCode } from "../services/tenantAccessCodes.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const roleIdsSchema = z.array(z.number().int().positive()).min(1, "Give at least one role.").max(20);

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  // Unique within this workspace only (checked case-insensitively by createUser).
  email: z.string().trim().pipe(z.email("Enter a valid email address.")).transform(value => value.toLowerCase()),
  role: z.enum(ROLES).optional(),
  roleIds: roleIdsSchema.optional(),
  jobTitle: z.string().trim().max(120).nullable().default(null),
  dateOfBirth: dateOfBirthSchema.nullable().default(null),
  joinedOn: joinedOnSchema.nullable().default(null),
  password: z.string().min(8, "Use at least 8 characters.").max(128),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(120),
    role: z.enum(ROLES),
    roleIds: roleIdsSchema,
    jobTitle: z.string().trim().max(120).nullable(),
    dateOfBirth: dateOfBirthSchema.nullable(),
    joinedOn: joinedOnSchema.nullable(),
    isActive: z.boolean(),
    isCodeLoginEnabled: z.boolean(),
  })
  .partial();

const passwordSchema = z.object({ password: z.string().min(8, "Use at least 8 characters.").max(128) });

const forbidden = message => new HttpError(403, message, { code: "FORBIDDEN" });

const toManagedUser = (row, roles) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  roles: roles ?? [],
  jobTitle: row.job_title ?? null,
  dateOfBirth: row.date_of_birth ?? null,
  age: ageOf(row.date_of_birth),
  joinedOn: row.joined_on ?? null,
  isActive: Boolean(row.is_active),
  isCodeLoginEnabled: row.is_code_login_enabled !== false,
  mustChangePassword: Boolean(row.must_change_password),
  lastLoginAt: row.last_login_at ?? null,
  loginCode: row.login_code ?? null,
  createdAt: row.created_at,
});

async function findMember(db, tenantId, id) {
  const user = await db("users").where({ id, tenant_id: tenantId }).first();
  if (!user) throw new HttpError(404, "User not found.");
  return user;
}

/**
 * Anti-escalation: the manager must hold every permission the roles grant; owner roles need an owner.
 * Only licensed permissions count: a role may keep permissions of unlicensed modules, which grant nothing.
 */
async function assertCanGrant(db, req, roleIds) {
  if (req.access.isOwner) return;
  const roles = await db("roles").whereIn("id", roleIds).select("key", "name", "permissions");
  for (const role of roles) {
    if (role.key === "owner") throw forbidden("Only an owner can make someone an owner.");
    const missing = parsePermissions(role.permissions).filter(key => isLicensed(key, req.tenant.features) && !req.access.permissions.includes(key));
    if (missing.length) throw forbidden(`You can't give the "${role.name}" role: it includes access you don't have yourself.`);
  }
}

const ownerRoleId = async (db, tenantId) => (await db("roles").where({ tenant_id: tenantId, key: "owner" }).first())?.id;

/** A workspace always keeps at least one active owner. */
async function assertAnotherOwner(db, tenantId, exceptUserId) {
  const ownerId = await ownerRoleId(db, tenantId);
  const [{ count }] = await db("user_roles as ur")
    .join("users as u", "u.id", "ur.user_id")
    .where({ "ur.role_id": ownerId, "u.is_active": true })
    .whereNot("u.id", exceptUserId)
    .count({ count: "*" });
  if (Number(count) === 0) throw new HttpError(422, "Your workspace needs at least one active owner.", { code: "LAST_OWNER" });
}

async function loadRoles(db, tenantId, userId) {
  return (await rolesByUser(db, tenantId)).get(userId) ?? [];
}

router.get("/", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const [users, tenant, roles] = await Promise.all([
    db("users").where({ tenant_id: tenantId }).orderBy("is_active", "desc").orderByRaw("lower(name)"),
    db("tenants").where({ id: tenantId }).first(),
    rolesByUser(db, tenantId),
  ]);

  // Ensure any existing user missing a login_code receives one
  const missingCode = users.filter(user => !user.login_code);
  if (missingCode.length > 0) {
    for (const user of missingCode) {
      const code = await generateUniqueUserLoginCode(db);
      await db("users").where({ id: user.id }).update({ login_code: code });
      user.login_code = code;
    }
  }

  res.json({
    users: users.map(user => toManagedUser(user, roles.get(user.id))),
    seats: { used: users.filter(user => user.is_active).length, limit: tenant?.max_users ?? null },
  });
});

router.post("/", async (req, res) => {
  const input = validate(createSchema, req.body);
  const policy = req.tenant.settings.security;
  assertEmailAllowed(policy, input.email);
  assertPasswordAllowed(policy, input.password);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const roleIds = await resolveRoleIds(db, tenantId, input);
  await assertCanGrant(db, req, roleIds);
  const id = await createUser(db, { tenantId, ...input, roleIds });
  const roles = await loadRoles(db, tenantId, id);
  await recordTenantAudit(db, req, "user.create", input.name, { email: input.email.toLowerCase(), roles: roles.map(role => role.name).join(", ") });
  res.status(201).json(toManagedUser(await db("users").where({ id }).first(), roles));
});

router.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(updateSchema, req.body ?? {});
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await findMember(db, tenantId, id);
  const currentRoles = await loadRoles(db, tenantId, id);
  const isOwner = currentRoles.some(role => role.key === "owner");

  if (id === req.user.id && input.isActive === false) throw new HttpError(422, "You can't deactivate your own account.", { code: "SELF_DEACTIVATE" });
  if (isOwner && !req.access.isOwner && (input.isActive === false || input.roleIds || input.role)) throw forbidden("Only an owner can change another owner's access.");

  let nextRoleIds = null;
  if (input.roleIds || input.role) {
    nextRoleIds = await resolveRoleIds(db, tenantId, input);
    const added = nextRoleIds.filter(roleId => !currentRoles.some(role => role.id === roleId));
    if (added.length) await assertCanGrant(db, req, added);
    const ownerId = await ownerRoleId(db, tenantId);
    if (isOwner && !nextRoleIds.includes(ownerId)) await assertAnotherOwner(db, tenantId, id);
  }
  if (isOwner && input.isActive === false) await assertAnotherOwner(db, tenantId, id);
  if (input.isActive === true && !user.is_active) await assertSeatAvailable(db, tenantId);

  const changes = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.jobTitle !== undefined) changes.job_title = input.jobTitle || null;
  if (input.dateOfBirth !== undefined) changes.date_of_birth = input.dateOfBirth || null;
  if (input.joinedOn !== undefined) changes.joined_on = input.joinedOn || null;
  if (input.isActive !== undefined) changes.is_active = input.isActive;
  if (input.isCodeLoginEnabled !== undefined) changes.is_code_login_enabled = input.isCodeLoginEnabled;

  await db.transaction(async trx => {
    if (Object.keys(changes).length) await trx("users").where({ id }).update(changes);
    if (nextRoleIds) {
      await trx("user_roles").where({ user_id: id }).delete();
      await trx("user_roles").insert(nextRoleIds.map(roleId => ({ user_id: id, role_id: roleId })));
    }
  });

  if (input.isCodeLoginEnabled !== undefined) {
    try {
      await syncUserAccessCode(req.tenant, { id, name: user.name, login_code: user.login_code }, { isActive: input.isCodeLoginEnabled });
      await recordTenantAudit(db, req, input.isCodeLoginEnabled ? "user.enable_code_login" : "user.disable_code_login", user.name);
    } catch (e) {
      console.error("[user.patch] syncUserAccessCode error:", e.message);
    }
  }

  // Live sockets carry the old access: close them so the person's tabs re-check the session (signed out when
  // deactivated; reconnected with the new permissions after a role change).
  if (input.isActive === false || nextRoleIds) disconnectUser(id, input.isActive === false ? "Account deactivated" : "Access changed");

  const roles = await loadRoles(db, tenantId, id);
  if (nextRoleIds) await recordTenantAudit(db, req, "user.roles", user.name, { from: currentRoles.map(role => role.name).join(", "), to: roles.map(role => role.name).join(", ") });
  if (input.isActive !== undefined && input.isActive !== Boolean(user.is_active)) await recordTenantAudit(db, req, input.isActive ? "user.activate" : "user.deactivate", user.name);
  if (input.name !== undefined && input.name !== user.name) await recordTenantAudit(db, req, "user.rename", user.name, { to: input.name });
  res.json(toManagedUser(await db("users").where({ id }).first(), roles));
});

router.post("/:id/password", async (req, res) => {
  const id = parseId(req.params.id);
  const { password } = validate(passwordSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await findMember(db, tenantId, id);
  await assertCanResetPassword(db, req, tenantId, id);
  assertPasswordAllowed(req.tenant.settings.security, password);
  // A password set by someone else is temporary: the person picks their own at next sign-in.
  await db("users").where({ id }).update({ password_hash: await bcrypt.hash(password, 10), must_change_password: id !== req.user.id, password_changed_at: nowIso() });
  if (id === req.user.id) startSession(res, { userId: id, slug: req.tenant.slug, settings: req.tenant.settings }); // keep the admin signed in on this device
  // Their reset request (if any) is handled, and an unused link must not work any more.
  await closeOpenResets(db, id, "used");
  if (id !== req.user.id) disconnectUser(id, "Password changed");
  await recordTenantAudit(db, req, "user.password_reset", user.name);
  res.status(204).end();
});

/** Signs the person out on every device (their password stays). Their open tabs return to the sign-in page. */
router.post("/:id/sign-out", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await findMember(db, tenantId, id);
  if (id === req.user.id) throw new HttpError(422, "Use Sign out in your own account menu instead.", { code: "SELF_SIGN_OUT" });
  const roles = await loadRoles(db, tenantId, id);
  if (roles.some(role => role.key === "owner") && !req.access.isOwner) throw forbidden("Only an owner can sign out another owner.");
  await db("users").where({ id }).update({ sessions_revoked_at: nowIso() });
  disconnectUser(id, "Signed out by an administrator");
  await recordTenantAudit(db, req, "user.sign_out", user.name);
  res.status(204).end();
});

/** Regenerates a unique login key code for a specific user. */
router.post("/:id/login-code/regenerate", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await findMember(db, tenantId, id);

  const currentRoles = await loadRoles(db, tenantId, id);
  const isOwner = currentRoles.some(role => role.key === "owner");
  if (isOwner && !req.access.isOwner) {
    throw forbidden("Only an owner can regenerate another owner's login code.");
  }

  const newCode = await generateUniqueUserLoginCode(db);
  await db("users").where({ id, tenant_id: tenantId }).update({ login_code: newCode });
  try {
    await syncUserAccessCode(req.tenant, { id, name: user.name, login_code: newCode }, { isActive: user.is_code_login_enabled !== false, newCode });
  } catch (e) {
    console.error("[user.regenerate_login_code] syncUserAccessCode error:", e.message);
  }
  await recordTenantAudit(db, req, "user.regenerate_login_code", user.name, { code: newCode });

  res.json({ ok: true, id, loginCode: newCode });
});

// ---- Bulk import: many accounts at once (from a CSV the web app parses), all with one temporary password ----
const importSchema = z.object({
  password: z.string().min(8, "Use at least 8 characters.").max(128),
  roleIds: roleIdsSchema,
  dryRun: z.boolean().default(false),
  rows: z
    .array(
      z.object({
        name: z.string().trim().max(120).default(""),
        email: z.string().trim().max(255).default(""),
        jobTitle: z.string().trim().max(120).nullable().default(null),
      })
    )
    .min(1, "Add at least one person.")
    .max(500, "Import at most 500 people at a time."),
});
const EMAIL = z.email();

/**
 * Checks every row first (email format, duplicates, allowed domains, seats), then creates the valid ones.
 * With dryRun nothing is created: the answer says what would happen, row by row.
 */
router.post("/import", async (req, res) => {
  const input = validate(importSchema, req.body);
  const policy = req.tenant.settings.security;
  assertPasswordAllowed(policy, input.password);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const roleIds = await resolveRoleIds(db, tenantId, { roleIds: input.roleIds });
  await assertCanGrant(db, req, roleIds);

  const existing = new Set((await db("users").where({ tenant_id: tenantId }).select("email")).map(row => row.email.toLowerCase()));
  const tenant = await db("tenants").where({ id: tenantId }).first();
  const [{ count }] = await db("users").where({ tenant_id: tenantId, is_active: true }).count({ count: "*" });
  let seatsLeft = tenant?.max_users ? Math.max(0, tenant.max_users - Number(count)) : Infinity;

  const seen = new Set();
  const results = input.rows.map((row, index) => {
    const email = row.email.toLowerCase();
    const base = { row: index + 1, name: row.name, email };
    if (!row.name) return { ...base, status: "error", message: "Name is required." };
    if (!EMAIL.safeParse(email).success) return { ...base, status: "error", message: "Not a valid email address." };
    if (seen.has(email)) return { ...base, status: "error", message: "Listed twice in this file." };
    seen.add(email);
    if (existing.has(email)) return { ...base, status: "skipped", message: "Already has an account." };
    const domain = emailDomainProblem(policy, email);
    if (domain) return { ...base, status: "error", message: domain };
    if (seatsLeft <= 0) return { ...base, status: "error", message: "No seats left on your plan." };
    seatsLeft -= 1;
    return { ...base, status: "ready", jobTitle: row.jobTitle };
  });

  if (!input.dryRun) {
    for (const result of results.filter(item => item.status === "ready")) {
      try {
        await db.transaction(trx => createUser(trx, { tenantId, name: result.name, email: result.email, password: input.password, roleIds, jobTitle: result.jobTitle }));
        result.status = "created";
      } catch (error) {
        result.status = "error";
        result.message = error?.errors?.email ?? error?.message ?? "Couldn't create this account.";
      }
    }
    const created = results.filter(item => item.status === "created").length;
    if (created) await recordTenantAudit(db, req, "user.import", `${created} ${created === 1 ? "person" : "people"}`, { roles: roleIds.length });
  }
  const summary = { created: 0, ready: 0, skipped: 0, error: 0 };
  for (const result of results) summary[result.status] += 1;
  res.status(input.dryRun ? 200 : 201).json({ dryRun: input.dryRun, summary, results: results.map(({ jobTitle: _jobTitle, ...rest }) => rest) });
});

// ---- Password reset requests and one-time reset links ----
const resetLinkSchema = z.object({ expiresInHours: z.number().int().min(1, "Between 1 and 72 hours.").max(72, "Between 1 and 72 hours.").default(24) });

const personRef = (id, name) => (id ? { id, name } : null);

const toResetRequest = row => ({
  id: row.id,
  user: { id: row.user_id, name: row.user_name, email: row.user_email, jobTitle: row.user_job_title ?? null },
  status: row.status,
  requestedAt: row.requested_at ?? null,
  requestedIp: row.requested_ip ?? null,
  issuedAt: row.issued_at ?? null,
  expiresAt: row.expires_at ?? null,
  issuedBy: personRef(row.issued_by, row.issued_by_name),
});

/** Same rule as setting a temporary password: only an owner can reset another owner. */
async function assertCanResetPassword(db, req, tenantId, userId) {
  const roles = await loadRoles(db, tenantId, userId);
  if (roles.some(role => role.key === "owner") && !req.access.isOwner) throw forbidden("Only an owner can reset another owner's password.");
}

const resetRequestsQuery = (db, tenantId) =>
  db("password_resets as pr")
    .join("users as u", "u.id", "pr.user_id")
    .leftJoin("users as ib", "ib.id", "pr.issued_by")
    .where("pr.tenant_id", tenantId)
    .where("u.tenant_id", tenantId)
    .where(builder => builder.where("pr.is_tenant_admin", false).orWhereNull("pr.is_tenant_admin"))
    .select("pr.*", "u.name as user_name", "u.email as user_email", "u.job_title as user_job_title", "ib.name as issued_by_name");

router.get("/password-requests", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await expireStaleLinks(db, { tenant_id: tenantId });
  const [open, closed] = await Promise.all([
    resetRequestsQuery(db, tenantId).whereIn("pr.status", OPEN_STATUSES).orderByRaw("coalesce(pr.requested_at, pr.created_at) desc").orderBy("pr.id", "desc"),
    resetRequestsQuery(db, tenantId).whereNotIn("pr.status", OPEN_STATUSES).orderBy("pr.id", "desc").limit(20),
  ]);
  res.json([...open, ...closed].map(toResetRequest));
});

/** A one-time link for the person to choose a new password. The token is returned only now; only its hash is kept. */
router.post("/:id/reset-link", async (req, res) => {
  const id = parseId(req.params.id);
  const { expiresInHours } = validate(resetLinkSchema, req.body ?? {});
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await findMember(db, tenantId, id);
  if (!user.is_active) throw new HttpError(422, "This account is deactivated. Reactivate it before sending a reset link.", { code: "USER_INACTIVE" });
  await assertCanResetPassword(db, req, tenantId, id);

  const token = newResetToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  const issued = { status: "issued", token_hash: hashResetToken(token), issued_by: req.user.id, issued_at: now, expires_at: expiresAt, used_at: null };
  await db.transaction(async trx => {
    await expireStaleLinks(trx, { user_id: id });
    // Keep one open request per person: the newest one becomes this link, older links stop working.
    const open = await trx("password_resets").where({ user_id: id, tenant_id: tenantId }).whereIn("status", OPEN_STATUSES).orderBy("id", "desc").first();
    if (open) {
      await trx("password_resets").where({ id: open.id }).update(issued);
      await closeOpenResets(trx, id, "expired", { exceptId: open.id });
    } else {
      await insertAndGetId(trx, "password_resets", { tenant_id: tenantId, user_id: id, created_at: now, ...issued });
    }
  });
  await recordTenantAudit(db, req, "user.reset_link", user.name, { expiresInHours });
  res.status(201).json({ url: `/reset-password/${token}`, token, expiresAt });
});

router.post("/password-requests/:id/dismiss", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const request = await db("password_resets").where({ id, tenant_id: tenantId }).first();
  if (!request) throw new HttpError(404, "Request not found.");
  if (!OPEN_STATUSES.includes(request.status)) throw new HttpError(409, "This request is already closed.", { code: "REQUEST_CLOSED" });
  await db("password_resets").where({ id }).update({ status: "dismissed" });
  const user = await db("users").where({ id: request.user_id }).first();
  await recordTenantAudit(db, req, "user.password_reset_dismiss", user?.name ?? null);
  res.status(204).end();
});

export default router;
