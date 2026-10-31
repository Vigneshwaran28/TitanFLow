import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { readConfig } from "../config/store.js";
import { getDb } from "../db/connection.js";
import { bypassesMaintenance, maintenanceError, workspaceMaintenance } from "../services/maintenance.js";
import { resolveSettings } from "../services/moduleSettings.js";
import { activeRulesByUser, effectivePermissions } from "../services/permissions.js";
import { sessionHoursOf } from "../services/securityPolicy.js";
import { subscriptionExpired } from "../services/subscriptionDates.js";
import { effectiveFeatures } from "../services/tenants.js";
import { HttpError, nowIso } from "../utils/http.js";

// ---- Sessions: one per workspace, so one browser can be signed in to several workspaces side by side ----
// Each workspace's sign-in lives in its own cookie (tf_s_<slug>). The web app says which workspace a request is
// for (the X-Workspace header, or ?ws= on plain browser downloads), taken from the page's URL (/<slug>/...).
// tf_session mirrors the most recent sign-in: pages without a workspace in the URL (/, /login) use it, and
// sessions from before per-workspace cookies live only there.
export const SESSION_COOKIE = "tf_session";
const WORKSPACE_COOKIE_PREFIX = "tf_s_";
const WORKSPACE_HEADER = "x-workspace";
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** The cookie that holds one workspace's session. */
export const workspaceCookie = slug => `${WORKSPACE_COOKIE_PREFIX}${slug}`;

function secret() {
  const config = readConfig();
  if (!config) throw new HttpError(503, "Setup is not complete.", { code: "SETUP_REQUIRED" });
  return config.jwtSecret;
}

const cookieOptions = maxAge => ({ httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge, path: "/" });

/** The workspace a request is for (a valid slug), or null on pages outside a workspace. */
export function requestedWorkspace(req) {
  const value = String(req.get?.(WORKSPACE_HEADER) ?? req.query?.ws ?? "").trim().toLowerCase();
  return SLUG.test(value) ? value : null;
}

/**
 * The session token for a workspace (or the most recent one when `slug` is null), and the cookie it came from.
 * @param {Record<string, string>} cookies
 * @param {string | null} slug
 * @returns {{ token: string, cookie: string } | null}
 */
export function sessionToken(cookies, slug, authHeader) {
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return { token: bearer, cookie: "authorization_bearer" };
  }
  const own = slug ? cookies?.[workspaceCookie(slug)] : null;
  if (own) return { token: own, cookie: workspaceCookie(slug) };
  // Older sessions (and pages without a workspace) use tf_session; its workspace is checked after loading the account.
  if (cookies?.[SESSION_COOKIE]) return { token: cookies[SESSION_COOKIE], cookie: SESSION_COOKIE };
  // A client that names no workspace and kept only one workspace cookie (scripts, API tools): that one.
  const sessions = slug ? [] : workspaceSessions(cookies);
  return sessions.length === 1 ? { token: sessions[0].token, cookie: workspaceCookie(sessions[0].slug) } : null;
}

/** Every workspace session cookie the browser sent: [{ slug, token }]. */
export function workspaceSessions(cookies) {
  return Object.entries(cookies ?? {})
    .filter(([name, value]) => name.startsWith(WORKSPACE_COOKIE_PREFIX) && value && SLUG.test(name.slice(WORKSPACE_COOKIE_PREFIX.length)))
    .map(([name, token]) => ({ slug: name.slice(WORKSPACE_COOKIE_PREFIX.length), token }));
}

export const verifySession = token => jwt.verify(token, secret());

/**
 * Tracks an active session in user_sessions and enforces the tenant's maxActiveSessions limit.
 */
export async function trackUserSession(db, { userId, tenantId, sid, settings, ip, userAgent }) {
  if (!db || !sid) return;
  try {
    const hasTable = await db.schema.hasTable("user_sessions");
    if (!hasTable) return;
    const now = nowIso();
    const hours = sessionHoursOf(settings);
    const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();

    // 1. Clean up expired sessions for this user
    await db("user_sessions")
      .where({ user_id: userId })
      .where("expires_at", "<", now)
      .delete();

    // 2. Enforce maxActiveSessions limit if configured by tenant admin
    const maxActive = settings?.security?.maxActiveSessions;
    if (typeof maxActive === "number" && maxActive > 0) {
      const activeRows = await db("user_sessions")
        .where({ user_id: userId })
        .orderBy("id", "asc"); // oldest first
      
      if (activeRows.length >= maxActive) {
        const toEvictCount = activeRows.length - maxActive + 1;
        const toEvictIds = activeRows.slice(0, toEvictCount).map(r => r.id);
        await db("user_sessions").whereIn("id", toEvictIds).delete();
      }
    }

    // 3. Insert this new session
    await db("user_sessions").insert({
      tenant_id: tenantId,
      user_id: userId,
      session_id: sid,
      ip_address: ip || null,
      user_agent: (userAgent || "").slice(0, 255) || null,
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error("[auth] trackUserSession error:", err.message);
  }
}

/**
 * Signs a person in to their workspace on this browser. Other workspaces' sessions are left alone.
 * @param {import("express").Response} res
 * @param {{ userId: number, slug: string, settings?: Object, tenantId?: number, req?: Object }} session
 */
export function startSession(res, { userId, slug, settings, tenantId = null, req = null, isCodeLogin = false }) {
  const hours = sessionHoursOf(settings);
  const sid = crypto.randomUUID();
  const token = jwt.sign({ sub: String(userId), ws: slug, sid, isCodeLogin: Boolean(isCodeLogin), iatMs: Date.now() }, secret(), { expiresIn: `${hours}h` });
  const options = cookieOptions(hours * 60 * 60 * 1000);
  res.cookie(SESSION_COOKIE, token, options);
  res.cookie(workspaceCookie(slug), token, options);

  // Background active session recording in DB
  const ip = req?.ip ?? null;
  const userAgent = req?.get ? req.get("user-agent") : null;
  const db = getDb();
  if (db) {
    Promise.resolve().then(async () => {
      try {
        let tId = tenantId;
        if (!tId) {
          const user = await db("users").where({ id: userId }).first("tenant_id");
          tId = user?.tenant_id;
        }
        if (tId) {
          await trackUserSession(db, { userId, tenantId: tId, sid, settings: resolveSettings(settings), ip, userAgent });
        }
      } catch (e) {
        // Ignore session track error
      }
    });
  }

  return token;
}

/**
 * Signs out of one workspace on this browser (or, with slug null, of the most recent sign-in only).
 * tf_session is cleared too when it holds that workspace's session.
 */
export function endSession(req, res, slug) {
  const latest = req.cookies?.[SESSION_COOKIE];
  const token = (slug && req.cookies?.[workspaceCookie(slug)]) || latest;
  if (token) {
    try {
      const payload = jwt.decode(token);
      if (payload?.sid) {
        const db = getDb();
        if (db) {
          Promise.resolve(db.schema.hasTable("user_sessions")).then(has => {
            if (has) db("user_sessions").where({ session_id: payload.sid }).delete().catch(() => {});
          }).catch(() => {});
        }
      }
    } catch {}
  }
  if (slug) res.clearCookie(workspaceCookie(slug), { path: "/" });
  const latestSlug = latest ? jwt.decode(latest)?.ws : null;
  if (!slug || !latestSlug || latestSlug === slug || latest === req.cookies?.[workspaceCookie(slug)]) res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Signs out of every workspace on this browser. */
export function endAllSessions(req, res) {
  for (const { slug, token } of workspaceSessions(req.cookies)) {
    try {
      const payload = jwt.decode(token);
      if (payload?.sid) {
        const db = getDb();
        if (db) db("user_sessions").where({ session_id: payload.sid }).delete().catch(() => {});
      }
    } catch {}
    res.clearCookie(workspaceCookie(slug), { path: "/" });
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Drops one cookie whose session is no longer valid (and tf_session when it carries the same token). */
function dropSession(req, res, cookie) {
  if (cookie === "authorization_bearer") return;
  res.clearCookie(cookie, { path: "/" });
  if (cookie !== SESSION_COOKIE && req.cookies?.[SESSION_COOKIE] === req.cookies?.[cookie]) res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Loads a user with their tenant. Used by sign-in and by every authenticated request.
 * @param {import("knex").Knex} db
 * @param {Object} where - e.g. { "u.id": 3 } or { "u.email": "a@b.c" }
 */
export function findUserWithTenant(db, where) {
  return db("users as u")
    .leftJoin("tenants as t", "t.id", "u.tenant_id")
    .where(where)
    .select("u.*", "t.name as tenant_name", "t.slug as tenant_slug", "t.status as tenant_status", "t.features as tenant_features", "t.settings as tenant_settings")
    .select("t.deleted_at as tenant_deleted_at", "t.subscription_ends_on as tenant_ends_on", "t.grace_days as tenant_grace_days") // lifecycle checks in accessProblem
    .select("t.maintenance as tenant_maintenance") // maintenance windows (services/maintenance.js)
    .first();
}

/**
 * A person's roles, their access rules in effect today, and the permissions those add up to (limited to the tenant's
 * licensed modules).
 */
export async function loadAccess(db, userId, features) {
  const [roles, rules] = await Promise.all([
    db("user_roles as ur").join("roles as r", "r.id", "ur.role_id").where("ur.user_id", userId).select("r.id", "r.key", "r.name", "r.permissions"),
    activeRulesByUser(db, null, [userId]).then(map => map.get(userId) ?? []),
  ]);
  return {
    roles: roles.map(role => ({ id: role.id, key: role.key, name: role.name })),
    rules: rules.map(rule => ({ id: rule.id, name: rule.name, mode: rule.mode })),
    permissions: effectivePermissions(roles, features, rules),
    isOwner: roles.some(role => role.key === "owner"),
  };
}

/**
 * Why a user can't use the app right now, or null when they can.
 * @param {Object} row - from findUserWithTenant
 */
export function accessProblem(row) {
  if (!row.tenant_id) return { status: 403, message: "Your account isn't part of a workspace. Contact your administrator.", code: "NO_TENANT" };
  if (row.tenant_deleted_at) return { status: 403, message: "This workspace has been deleted. Contact your provider.", code: "TENANT_DELETED" };
  if (!row.is_active) return { status: 403, message: "Your account has been deactivated. Contact your workspace administrator.", code: "ACCOUNT_DISABLED" };
  if (row.tenant_status !== "active") return { status: 403, message: "This workspace is suspended. Contact your provider.", code: "TENANT_SUSPENDED" };
  if (subscriptionExpired(row.tenant_ends_on, row.tenant_grace_days)) {
    return { status: 403, message: "Your workspace's subscription has ended. Contact your provider to renew.", code: "SUBSCRIPTION_EXPIRED" };
  }
  return null;
}

/** True when a token was issued before `isoTime` (tokens carry iatMs; older ones only JWT `iat` in seconds). */
function issuedBefore(payload, isoTime) {
  if (!isoTime) return false;
  const at = Date.parse(isoTime);
  if (typeof payload?.iatMs === "number") return payload.iatMs < at;
  return Boolean(payload?.iat) && payload.iat < Math.floor(at / 1000);
}

/**
 * Why a valid-looking session token may no longer be used, or null: the password changed after it was issued,
 * an admin signed the person out everywhere, or it is older than the workspace's session length allows now.
 */
export function sessionProblem(payload, row) {
  if (issuedBefore(payload, row.password_changed_at)) return { message: "Your password was changed. Please sign in again.", code: "SESSION_REVOKED" };
  if (issuedBefore(payload, row.sessions_revoked_at)) return { message: "You were signed out by an administrator. Please sign in again.", code: "SESSION_REVOKED" };
  const issuedMs = typeof payload?.iatMs === "number" ? payload.iatMs : (payload?.iat ?? 0) * 1000;
  const hours = sessionHoursOf(resolveSettings(row.tenant_settings));
  if (issuedMs && Date.now() - issuedMs > hours * 3_600_000) return { message: "Your session has expired. Please sign in again.", code: "UNAUTHENTICATED" };
  return null;
}

/** The session view of a tenant: identity, usable modules, and resolved module settings. */
export function tenantFromRow(row) {
  const settings = resolveSettings(row.tenant_settings);
  return { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug, features: effectiveFeatures(row.tenant_features, settings), settings };
}

/**
 * Loads the account behind a browser's session for one workspace (or the most recent sign-in when slug is null).
 * @returns {Promise<{ row: Object, payload: Object, cookie: string } | { problem: { message: string, code: string }, drop: string | null }>}
 *   drop: the cookie to clear because its session can never work again (null: keep it)
 */
export async function loadSession(db, cookies, slug, authHeader) {
  const found = sessionToken(cookies, slug, authHeader);
  if (!found) return { problem: { message: "Please sign in.", code: "UNAUTHENTICATED" }, drop: null };
  let payload;
  try {
    payload = verifySession(found.token);
  } catch {
    return { problem: { message: "Your session has expired. Please sign in again.", code: "UNAUTHENTICATED" }, drop: found.cookie };
  }
  const row = await findUserWithTenant(db, { "u.id": Number(payload.sub) });
  if (!row) return { problem: { message: "Please sign in.", code: "UNAUTHENTICATED" }, drop: found.cookie };
  // A session belongs to the workspace it was issued for. Tenants with their own database number their people
  // independently, so the same user id can exist in another workspace: never accept it there.
  if (payload.ws && payload.ws !== row.tenant_slug) {
    return { problem: { message: "Sign in to this workspace to continue.", code: "UNAUTHENTICATED" }, drop: found.cookie === SESSION_COOKIE ? null : found.cookie };
  }
  // The most recent sign-in belongs to another workspace: it stays valid there, but this workspace needs its own.
  if (slug && row.tenant_slug !== slug) {
    return { problem: { message: "Sign in to this workspace to continue.", code: "UNAUTHENTICATED" }, drop: found.cookie === SESSION_COOKIE ? null : found.cookie };
  }
  const problem = accessProblem(row) ?? sessionProblem(payload, row);
  if (problem) return { problem: { message: problem.message, code: problem.code }, drop: found.cookie };

  // If session token has sid, verify user_sessions hasn't evicted it due to active session limit
  if (payload.sid && db) {
    try {
      const hasSessionsTable = await db.schema.hasTable("user_sessions");
      if (hasSessionsTable) {
        const activeSession = await db("user_sessions").where({ session_id: payload.sid }).first();
        if (!activeSession) {
          const [{ count }] = await db("user_sessions").where({ user_id: row.id }).count({ count: "*" });
          if (Number(count || 0) > 0) {
            return {
              problem: {
                message: "Your session was ended because the active session limit for your workspace was reached on another device, or you were signed out.",
                code: "SESSION_LIMIT_EXCEEDED",
              },
              drop: found.cookie,
            };
          }
        }
      }
    } catch {}
  }

  return { row, payload, cookie: found.cookie };
}

/**
 * Attaches `req.user`, `req.tenant`, and `req.access` or responds 401 / 403. The session is the one for the
 * workspace the request names (requestedWorkspace), so each workspace open in this browser keeps its own sign-in.
 * Accounts with a temporary password may only reach /api/auth until they choose their own.
 */
export async function requireAuth(req, res, next) {
  const db = getDb();
  const session = await loadSession(db, req.cookies, requestedWorkspace(req), req.get("authorization"));
  if (session.problem) {
    if (session.drop) dropSession(req, res, session.drop);
    throw new HttpError(401, session.problem.message, { code: session.problem.code });
  }
  const { row, payload } = session;

  req.user = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    job_title: row.job_title,
    created_at: row.created_at,
    tenant_id: row.tenant_id,
    must_change_password: Boolean(row.must_change_password),
    is_code_login: Boolean(payload?.isCodeLogin),
    date_of_birth: row.date_of_birth,
    joined_on: row.joined_on,
    show_birthday: row.show_birthday,
    preferences: row.preferences,
  };
  req.tenant = tenantFromRow(row);
  req.access = await loadAccess(db, row.id, req.tenant.features);
  // A maintenance window closes the workspace (owners and admins may stay when the window allows it).
  req.maintenance = await workspaceMaintenance(db, row.tenant_maintenance);
  if (req.maintenance.active && !bypassesMaintenance(req.maintenance.active, req.access)) throw maintenanceError(req.maintenance.active);

  if (req.user.must_change_password && req.baseUrl !== "/api/auth") {
    throw new HttpError(403, "Choose a new password to continue.", { code: "PASSWORD_CHANGE_REQUIRED" });
  }
  next();
}

/**
 * True when the signed-in user holds a permission (see services/permissions.js).
 * @param {import("express").Request} req
 * @param {string} permission
 */
export const can = (req, permission) => Boolean(req.access?.permissions.includes(permission));

/**
 * Allows the request when the user holds any of the permissions; use after requireAuth.
 * @param {...string} permissions
 */
export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!permissions.some(permission => can(req, permission))) {
      throw new HttpError(403, "You don't have permission to do that. Ask your workspace admin for access.", { code: "FORBIDDEN" });
    }
    next();
  };
}

/**
 * Blocks a module the tenant isn't licensed for; use after requireAuth.
 * With several keys, any one of them is enough (for routes shared between modules).
 * @param {...string} features - FEATURES keys
 */
export function requireFeature(...features) {
  return (req, res, next) => {
    if (!features.some(feature => req.tenant?.features.includes(feature))) {
      throw new HttpError(403, "This module isn't enabled for your workspace.", { code: "FEATURE_DISABLED" });
    }
    next();
  };
}
