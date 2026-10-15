import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import {
  accessProblem,
  endAllSessions,
  endSession,
  findUserWithTenant,
  loadAccess,
  loadSession,
  requestedWorkspace,
  requireAuth,
  SESSION_COOKIE,
  startSession,
  tenantFromRow,
  workspaceSessions,
} from "../middleware/auth.js";
import { assertPasswordAllowed } from "../services/securityPolicy.js";
import { bypassesMaintenance, maintenanceError, workspaceMaintenance } from "../services/maintenance.js";
import { ACCENTS, imageUrlSchema, normalizeCss, resolveSettings, STYLES, TOUR_KEYS, userCssProblem } from "../services/moduleSettings.js";
import { avatarUrlOf } from "../services/avatars.js";
import { notifyUsers } from "../services/notify.js";
import { closeOpenResets, expireStaleLinks, hashResetToken, maskEmail, OPEN_STATUSES, TOKEN_PATTERN } from "../services/passwordResets.js";
import { usersWithPermission } from "../services/permissions.js";
import { findAccountIdsByEmail } from "../services/users.js";
import { forEachDatabase, runInTenant, runInWorkspace } from "../services/tenantDatabases.js";
import jwt from "jsonwebtoken";
import { disconnectUser, publish } from "../services/realtime.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { ageOf, dateOfBirthSchema } from "../services/personDates.js";
import { HttpError, nowIso, validate } from "../utils/http.js";

const router = Router();

const email = z.email("Enter a valid email address.").transform(value => value.toLowerCase());

const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required."),
  // Signing in on a workspace's own page (/w/<slug>/login): the account must belong to that workspace.
  workspace: z.string().trim().toLowerCase().max(60).optional(),
});

const profileSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  jobTitle: z.string().trim().max(120, "Keep the job title under 120 characters.").nullable().optional(),
  dateOfBirth: dateOfBirthSchema.nullable().optional(),
  showBirthday: z.boolean().optional(),
  // Profile picture link ("" or null = none, initials are shown); stored in users.preferences.avatarUrl.
  avatarUrl: imageUrlSchema.nullable().optional(),
});

/** Sections of the home page a person can hide or reorder (web: features/dashboard/utils/homeSections.ts). */
export const HOME_SECTIONS = Object.freeze(["attendance", "celebrations", "announcements", "tasks", "helpdesk", "expenses", "sales", "billing", "inventory", "logistics", "clinic", "notes", "modules"]);
const sectionList = z
  .array(z.enum(HOME_SECTIONS, "Unknown home section."))
  .max(HOME_SECTIONS.length)
  .refine(keys => new Set(keys).size === keys.length, "Each section can be listed once.");
// sizes: how wide each section is on large screens (full row, or half: two side by side); missing = its default.
const homeLayoutSchema = z
  .object({ hidden: sectionList, order: sectionList, sizes: z.partialRecord(z.enum(HOME_SECTIONS), z.enum(["full", "half"])).optional() })
  .strict();

/** Guided tours this person finished or skipped (web: features/help); off: no tours start by themselves. */
const toursSchema = z
  .object({
    seen: z.array(z.enum(TOUR_KEYS)).max(TOUR_KEYS.length).transform(list => [...new Set(list)]),
    off: z.boolean(),
  })
  .partial()
  .strict();

/** Personal look and feel, and the home page layout; stored on the account so it follows the person to any device. */
const preferencesSchema = z
  .object({
    homeLayout: homeLayoutSchema.nullable(), // null = the default layout
    tours: toursSchema,
    theme: z.enum(["light", "dark", "system"]),
    accent: z.enum(ACCENTS).nullable(), // null = the workspace's brand colour
    fontScale: z.enum(["sm", "md", "lg"]),
    density: z.enum(["comfortable", "compact"]),
    reduceMotion: z.boolean(),
    style: z.enum(STYLES).nullable(), // null = the workspace's default style
    backgroundImage: z.union([imageUrlSchema, z.literal("none")]).nullable(), // null = the workspace's picture; "none" = no picture
    backgroundDim: z.number().int().min(0).max(90).nullable(),
    font: z.enum(["auto", "system", "inter", "jakarta", "plex"]),
    sidebar: z.enum(["auto", "light", "tinted", "dark"]),
    avatarUrl: imageUrlSchema, // "" = none (also set from the profile form)
    // Personal CSS, applied after the workspace's (same sanitizer, smaller limit); the workspace can switch it off.
    customCss: z
      .string()
      .transform(normalizeCss)
      .superRefine((css, ctx) => {
        const problem = userCssProblem(css);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    customCssEnabled: z.boolean(),
  })
  .partial()
  .strict();

const readPreferences = json => {
  try {
    return JSON.parse(json || "{}") ?? {};
  } catch {
    return {};
  }
};

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required."),
    newPassword: z.string().min(8, "Use at least 8 characters.").max(128),
  })
  .refine(value => value.newPassword !== value.currentPassword, { path: ["newPassword"], message: "Choose a password different from the current one." });

// ---- Sign-in throttling: 8 wrong passwords for one email from one IP locks that pair for 15 minutes. ----
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map();

function checkLock(key) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() > entry.resetAt) return failures.delete(key);
  if (entry.count >= MAX_FAILURES) {
    const minutes = Math.ceil((entry.resetAt - Date.now()) / 60_000);
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, { code: "TOO_MANY_ATTEMPTS" });
  }
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() > entry.resetAt) failures.set(key, { count: 1, resetAt: Date.now() + LOCK_MS });
  else entry.count += 1;
}

export function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    jobTitle: row.job_title ?? null,
    dateOfBirth: row.date_of_birth ?? null,
    age: ageOf(row.date_of_birth),
    joinedOn: row.joined_on ?? null,
    showBirthday: row.show_birthday === undefined ? true : Boolean(row.show_birthday),
    avatarUrl: avatarUrlOf(row.preferences),
    preferences: readPreferences(row.preferences),
    createdAt: row.created_at,
  };
}

/** The signed-in user, their workspace and its modules, and what they're allowed to do. */
const toSession = (user, tenant, access) => ({
  ...toUser(user),
  tenant,
  roles: access.roles,
  permissions: access.permissions,
  isOwner: access.isOwner,
  mustChangePassword: Boolean(user.must_change_password),
});

// Accounts are created by workspace admins; there is no self-service sign-up.
router.post("/register", () => {
  throw new HttpError(403, "Accounts are created by your workspace administrator.", { code: "REGISTRATION_DISABLED" });
});

/** Each account (with its tenant) for a list of user ids, in order. */
const loadAccounts = async (db, ids) => (await Promise.all(ids.map(id => findUserWithTenant(db, { "u.id": id })))).filter(Boolean);

/**
 * Accounts with this email: the named workspace's (its database is already the current one), or, without a workspace,
 * every workspace's (the platform database and each tenant's own database).
 */
async function accountsByEmail(address, workspace) {
  if (workspace) {
    const db = getDb();
    return loadAccounts(db, await findAccountIdsByEmail(db, address, { workspace }));
  }
  const results = await forEachDatabase(async db => loadAccounts(db, await findAccountIdsByEmail(db, address)), { label: "accounts by email" });
  return results.flatMap(result => result.value);
}

router.post("/login", async (req, res) => {
  const input = validate(loginSchema, req.body);
  const key = `${req.ip ?? "unknown"}|${input.email}`;
  checkLock(key);
  // Emails are unique per workspace: with a workspace there is at most one account, without one there may be several.
  const candidates = await accountsByEmail(input.email, input.workspace);
  const matches = [];
  for (const candidate of candidates) {
    if (await bcrypt.compare(input.password, candidate.password_hash)) matches.push(candidate);
  }
  if (!matches.length) {
    recordFailure(key);
    throw new HttpError(401, "Incorrect email or password.", { code: "INVALID_CREDENTIALS" });
  }
  failures.delete(key);
  // The password is right for several workspaces. Only now (after the password checked out, so this can't be used to
  // find accounts) say which ones; workspaces the person can't use right now are left out when another one works.
  const usable = matches.filter(match => !accessProblem(match));
  if (usable.length > 1) {
    return res.status(409).json({
      message: "This email is in more than one workspace. Pick one to sign in to.",
      code: "CHOOSE_WORKSPACE",
      workspaces: usable.map(match => ({ slug: match.tenant_slug, siteTitle: resolveSettings(match.tenant_settings).branding.siteTitle || match.tenant_name })),
    });
  }
  const row = usable[0] ?? matches[0];
  const problem = accessProblem(row);
  if (problem) throw new HttpError(problem.status, problem.message, { code: problem.code });
  // The rest runs in the account's own database (its tenant may have one).
  await runInTenant(row.tenant_id, () => completeLogin(res, row));
});

async function completeLogin(res, row) {
  const db = getDb();
  const tenant = tenantFromRow(row);
  const access = await loadAccess(db, row.id, tenant.features);
  const maintenance = await workspaceMaintenance(db, row.tenant_maintenance);
  if (maintenance.active && !bypassesMaintenance(maintenance.active, access)) throw maintenanceError(maintenance.active);
  // Only this workspace's session is set: others this browser is signed in to stay signed in.
  startSession(res, { userId: row.id, slug: tenant.slug, settings: tenant.settings });
  await db("users").where({ id: row.id }).update({ last_login_at: nowIso() });
  res.json({ ...toSession(row, tenant, access), maintenance });
}

// Signs out of the workspace the request is for (X-Workspace / ?ws=, or body.workspace); { all: true } signs out
// of every workspace on this browser.
router.post("/logout", (req, res) => {
  if (req.body?.all === true) endAllSessions(req, res);
  else {
    const fromBody = typeof req.body?.workspace === "string" ? req.body.workspace.trim().toLowerCase() : null;
    endSession(req, res, requestedWorkspace(req) ?? (fromBody && /^[a-z0-9-]{1,60}$/.test(fromBody) ? fromBody : null));
  }
  res.status(204).end();
});

/**
 * The workspaces this browser is signed in to, for the start page and the workspace switcher. Each one is checked
 * like a request to that workspace would be; sessions that can't work any more are cleared.
 */
router.get("/sessions", async (req, res) => {
  const slugs = workspaceSessions(req.cookies).map(session => session.slug);
  // A sign-in from before per-workspace cookies is only in tf_session: list its workspace too (in its own database).
  const latestWorkspace = req.cookies?.[SESSION_COOKIE] ? jwt.decode(req.cookies[SESSION_COOKIE])?.ws : null;
  const latest = req.cookies?.[SESSION_COOKIE] ? await runInWorkspace(typeof latestWorkspace === "string" ? latestWorkspace : "", () => loadSession(getDb(), req.cookies, null)) : null;
  if (latest?.row && !slugs.includes(latest.row.tenant_slug)) slugs.push(latest.row.tenant_slug);
  const sessions = [];
  for (const slug of slugs) {
    // Each workspace in its own database.
    const item = await runInWorkspace(slug, () => describeSession(req, res, slug, latest));
    if (item) sessions.push(item);
  }
  res.set("Cache-Control", "no-store");
  res.json(sessions);
});

/** One workspace this browser is signed in to, or null (its cookie is cleared when it can't work any more). */
async function describeSession(req, res, slug, latest) {
  const db = getDb();
  const session = await loadSession(db, req.cookies, slug);
  if (session.problem) {
    if (session.drop) res.clearCookie(session.drop, { path: "/" });
    return null;
  }
  const { row } = session;
  const { branding } = resolveSettings(row.tenant_settings);
  const { active } = await workspaceMaintenance(db, row.tenant_maintenance);
  const access = await loadAccess(db, row.id, tenantFromRow(row).features);
  return {
    slug: row.tenant_slug,
    siteTitle: branding.siteTitle || row.tenant_name,
    accent: branding.accent,
    user: { name: row.name, email: row.email },
    latest: latest?.row?.id === row.id && latest.row.tenant_slug === row.tenant_slug,
    maintenance: Boolean(active),
    // Owners and user managers: the app offers switching only between workspaces where the same person is an admin.
    isAdmin: access.isOwner || access.permissions.includes("workspace.users.manage"),
  };
}

// maintenance: { active, upcoming } — active only reaches owners and admins a window lets in (everyone else gets 503).
router.get("/me", requireAuth, (req, res) => {
  res.json({ ...toSession(req.user, req.tenant, req.access), maintenance: req.maintenance });
});

router.patch("/me", requireAuth, async (req, res) => {
  const input = validate(profileSchema, req.body);
  const db = getDb();
  const changes = { name: input.name };
  if (input.jobTitle !== undefined) changes.job_title = input.jobTitle || null;
  if (input.dateOfBirth !== undefined) changes.date_of_birth = input.dateOfBirth || null;
  if (input.showBirthday !== undefined) changes.show_birthday = input.showBirthday;
  if (input.avatarUrl !== undefined) {
    const current = await db("users").where({ id: req.user.id }).first("preferences");
    changes.preferences = JSON.stringify({ ...readPreferences(current?.preferences), avatarUrl: input.avatarUrl || "" });
  }
  await db("users").where({ id: req.user.id }).update(changes);
  res.json(toSession(await db("users").where({ id: req.user.id }).first(), req.tenant, req.access));
});

/**
 * What the workspace's branding forbids in a preferences change: a colour or style of one's own while the workspace
 * locks it (null, "use the workspace's", is always fine), and personal CSS while the workspace has it switched off.
 */
function brandingProblems(input, branding) {
  const errors = {};
  if (branding.lockAccent && input.accent != null && input.accent !== branding.accent) errors.accent = "Your workspace uses one colour for everyone.";
  if (branding.lockStyle && input.style != null && input.style !== branding.style) errors.style = "Your workspace uses one style for everyone.";
  if (branding.allowUserCss === false && (input.customCssEnabled === true || Boolean(input.customCss?.trim()))) {
    errors.customCss = "Your workspace doesn't allow personal CSS.";
  }
  return errors;
}

router.patch("/me/preferences", requireAuth, async (req, res) => {
  const input = validate(preferencesSchema, req.body ?? {});
  const errors = brandingProblems(input, req.tenant.settings.branding);
  if (Object.keys(errors).length) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors });
  const db = getDb();
  const user = await db("users").where({ id: req.user.id }).first();
  const preferences = { ...readPreferences(user.preferences), ...input };
  await db("users").where({ id: req.user.id }).update({ preferences: JSON.stringify(preferences) });
  res.json(preferences);
});

/** Changing the password also clears a "choose a new password" requirement from a temporary one. */
router.post("/me/password", requireAuth, async (req, res) => {
  const input = validate(passwordSchema, req.body);
  const db = getDb();
  const user = await db("users").where({ id: req.user.id }).first();
  if (!(await bcrypt.compare(input.currentPassword, user.password_hash))) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { currentPassword: "Current password is incorrect." } });
  }
  assertPasswordAllowed(req.tenant.settings.security, input.newPassword, "newPassword");
  await db("users").where({ id: user.id }).update({ password_hash: await bcrypt.hash(input.newPassword, 10), must_change_password: false, password_changed_at: nowIso() });
  // Other devices are signed out; this one gets a fresh session.
  disconnectUser(user.id, "Password changed");
  startSession(res, { userId: user.id, slug: req.tenant.slug, settings: req.tenant.settings });
  res.status(204).end();
});

// ---- Forgotten passwords: the person asks, a workspace admin sends them a one-time link ----
// Every answer is the same whether or not the account exists, so the form can't be used to find accounts.
const FORGOT_MESSAGE = "If that account exists, your administrator has been asked to reset it.";
const INVALID_LINK = "This reset link is invalid or has expired.";
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_PER_EMAIL = 3;
const FORGOT_PER_IP = 20;
const forgotHits = new Map();

const forgotSchema = z.object({ email, workspace: z.string().trim().toLowerCase().max(60).optional() });
const resetSchema = z.object({
  token: z.string().max(100),
  newPassword: z.string().min(8, "Use at least 8 characters.").max(128),
});

/** Counts every request (known email or not) so the limit itself reveals nothing. */
function checkForgotLimit(ip, address) {
  const now = Date.now();
  const keys = [
    [`ip|${ip}`, FORGOT_PER_IP],
    [`email|${address}`, FORGOT_PER_EMAIL],
  ];
  for (const [key, limit] of keys) {
    const entry = forgotHits.get(key);
    if (entry && now <= entry.resetAt && entry.count >= limit) {
      const minutes = Math.ceil((entry.resetAt - now) / 60_000);
      throw new HttpError(429, `Too many reset requests. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, { code: "TOO_MANY_ATTEMPTS" });
    }
  }
  for (const [key] of keys) {
    const entry = forgotHits.get(key);
    if (!entry || now > entry.resetAt) forgotHits.set(key, { count: 1, resetAt: now + FORGOT_WINDOW_MS });
    else entry.count += 1;
  }
}

/** Audit entries for public actions: the person themselves is the actor. */
const asSelf = user => ({ user: { id: user.id, tenant_id: user.tenant_id } });

/** Keeps one open request per person: refreshes it, or opens a new one, then tells the admins. */
async function recordResetRequest(db, user, ip) {
  const now = nowIso();
  await expireStaleLinks(db, { user_id: user.id });
  const open = await db("password_resets").where({ user_id: user.id }).whereIn("status", OPEN_STATUSES).orderBy("id", "desc").first();
  let requestId;
  if (open) {
    requestId = open.id;
    await db("password_resets").where({ id: open.id }).update({ requested_at: now, requested_ip: ip });
  } else {
    requestId = await insertAndGetId(db, "password_resets", { tenant_id: user.tenant_id, user_id: user.id, status: "requested", requested_ip: ip, requested_at: now, created_at: now });
  }
  const admins = await usersWithPermission(db, user.tenant_id, "workspace.users.manage");
  await notifyUsers(db, admins, { title: `${user.name} asked for a password reset`, body: "Open Manage users to send them a one-time reset link or set a temporary password.", actorId: user.id });
  publish({ tenantId: user.tenant_id, permission: "workspace.users.manage" }, "password_reset.requested", { requestId });
  await recordTenantAudit(db, asSelf(user), "user.password_reset_request", user.name, { ip });
}

/** The issued, unexpired link for a token, with its person and workspace, or a 404. */
async function findIssuedLink(db, token) {
  const notFound = new HttpError(404, INVALID_LINK, { code: "INVALID_RESET_LINK" });
  if (!TOKEN_PATTERN.test(String(token ?? ""))) throw notFound;
  const link = await db("password_resets").where({ token_hash: hashResetToken(token), status: "issued" }).where("expires_at", ">", nowIso()).first();
  if (!link) throw notFound;
  return checkIssuedLink(db, link, notFound);
}

/**
 * The tenant whose database holds a reset link (links carry no workspace: every database is asked, by the token's
 * hash), or null. Runs nothing else: the caller continues inside runInTenant().
 */
async function tenantOfLink(token) {
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return null;
  const hash = hashResetToken(token);
  const results = await forEachDatabase(async db => (await db("password_resets").where({ token_hash: hash, status: "issued" }).first("tenant_id"))?.tenant_id ?? null, { label: "reset link" });
  return results.find(result => result.value)?.value ?? null;
}

async function checkIssuedLink(db, link, notFound) {
  const user = await findUserWithTenant(db, { "u.id": link.user_id });
  if (!user || user.tenant_id !== link.tenant_id || accessProblem(user)) throw notFound;
  return { link, user };
}

router.post("/password/forgot", async (req, res) => {
  const input = validate(forgotSchema, req.body ?? {});
  const ip = req.ip ?? "unknown";
  checkForgotLimit(ip, input.email);
  // With a workspace: that workspace's account. Without one: every active account with this email (one per workspace).
  const accounts = await accountsByEmail(input.email, input.workspace);
  for (const user of accounts.filter(account => !accessProblem(account))) {
    try {
      await runInTenant(user.tenant_id, () => recordResetRequest(getDb(), user, ip));
    } catch (error) {
      // Never let a failure here change the answer (that would tell an attacker the account exists).
      console.error("[password-reset] request failed:", error.message);
    }
  }
  res.status(202).json({ message: FORGOT_MESSAGE });
});

router.get("/password/reset/:token", async (req, res) => {
  const tenantId = await tenantOfLink(req.params.token);
  const { user } = await runInTenant(tenantId, () => findIssuedLink(getDb(), req.params.token));
  const { branding, security } = resolveSettings(user.tenant_settings);
  res.set("Cache-Control", "no-store");
  res.json({
    valid: true,
    name: String(user.name ?? "").trim().split(/\s+/)[0],
    email: maskEmail(user.email),
    workspace: { slug: user.tenant_slug, siteTitle: branding.siteTitle || user.tenant_name },
    passwordRule: { minLength: security.passwordMinLength, requireMixed: security.passwordRequireMixed },
  });
});

/** Sets the new password, burns the link, closes the person's other requests, and ends their live sockets. */
router.post("/password/reset", async (req, res) => {
  const input = validate(resetSchema, req.body ?? {});
  await runInTenant(await tenantOfLink(input.token), () => completeReset(res, input));
});

/** Finishes a reset inside the link's own database. */
async function completeReset(res, input) {
  const db = getDb();
  const { link, user } = await findIssuedLink(db, input.token);
  assertPasswordAllowed(resolveSettings(user.tenant_settings).security, input.newPassword, "newPassword");
  const passwordHash = await bcrypt.hash(input.newPassword, 10);
  const claimed = await db.transaction(async trx => {
    // Conditional update: two submits of the same link can't both succeed.
    const count = await trx("password_resets").where({ id: link.id, status: "issued" }).update({ status: "used", used_at: nowIso() });
    if (!count) return false;
    await trx("users").where({ id: user.id }).update({ password_hash: passwordHash, must_change_password: false, password_changed_at: nowIso() });
    await closeOpenResets(trx, user.id, "expired", { exceptId: link.id });
    return true;
  });
  if (!claimed) throw new HttpError(404, INVALID_LINK, { code: "INVALID_RESET_LINK" });
  // Sessions issued before now are rejected by requireAuth (password_changed_at).
  disconnectUser(user.id, "Password changed");
  await recordTenantAudit(db, asSelf(user), "user.password_reset_complete", user.name);
  res.status(204).end();
}

export default router;
