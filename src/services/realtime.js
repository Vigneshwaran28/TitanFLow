// Live updates over WebSockets.
//   /ws?ws=<slug> signed-in sockets (that workspace's session cookie, see middleware/auth.js), one per browser tab
//   /ws/public   anonymous sockets for one public channel: ?channel=queue:<code> or track:<code>
// Server code calls publish(); clients only receive. Every message is { type, data, at }.
// The event catalogue lives in docs/REALTIME.md.
import { WebSocketServer } from "ws";
import { getDb } from "../db/connection.js";
import { currentDbKey } from "../db/context.js";
import jwt from "jsonwebtoken";
import { accessProblem, findUserWithTenant, loadAccess, loadSession, sessionProblem, sessionToken, tenantFromRow } from "../middleware/auth.js";
import { bypassesMaintenance, workspaceMaintenance } from "./maintenance.js";
import { runInTenant, runInWorkspace } from "./tenantDatabases.js";

const HEARTBEAT_MS = 30_000;
const ACCESS_REFRESH_MS = 120_000; // re-check the account (deactivated, roles changed) this often
const PUBLIC_CHANNEL = /^(queue|track):[A-Za-z0-9]{6,24}$/;

/** @type {Set<import("ws").WebSocket & { meta: SocketMeta }>} */
const sockets = new Set();

/**
 * @typedef {Object} SocketMeta
 * @property {"user" | "public"} kind
 * @property {number} [userId]
 * @property {number} [tenantId]
 * @property {string} [dbKey] the database the user lives in (db/context.js): user ids are only unique inside one
 * @property {Set<string>} [permissions]
 * @property {string} [channel]
 * @property {boolean} alive
 * @property {number} checkedAt
 */

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

/** Same machine name as the API (any port), or listed in ALLOWED_ORIGINS. Blocks other sites from opening sockets with a visitor's cookie. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients send no Origin; they have no ambient cookie either
  const allowed = (process.env.ALLOWED_ORIGINS || process.env.TASKFLOW_ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    if (process.env.NODE_ENV !== "production") {
      if (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1" || originUrl.hostname === "::1") return true;
    }
    const trustedHosts = (process.env.TRUSTED_HOSTS || process.env.TASKFLOW_TRUSTED_HOSTS || "")
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(Boolean);
    if (trustedHosts.length > 0) {
      return trustedHosts.includes(originUrl.hostname.toLowerCase());
    }
    const configuredHost = (process.env.APP_URL || process.env.PUBLIC_URL || process.env.TASKFLOW_URL)
      ? new URL(process.env.APP_URL || process.env.PUBLIC_URL || process.env.TASKFLOW_URL).hostname
      : null;
    if (configuredHost && originUrl.hostname.toLowerCase() === configuredHost.toLowerCase()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Loads the signed-in account behind a socket (the session of the workspace in ?ws=), or null when it may not connect. */
async function authenticate(req, url) {
  const slug = String(url.searchParams.get("ws") ?? "").toLowerCase() || null;
  const cookies = parseCookies(req.headers.cookie);
  // The workspace's own database (a tenant may have one): the address, else the workspace of the session cookie.
  const found = slug ? null : sessionToken(cookies, null);
  const workspace = slug ?? (found ? jwt.decode(found.token)?.ws : null);
  return runInWorkspace(typeof workspace === "string" ? workspace : "", async () => {
    const session = await loadSession(getDb(), cookies, slug);
    if (session.problem) return null;
    return loadMeta(session.row.id, session.payload);
  });
}

async function loadMeta(userId, payload = null) {
  const db = getDb();
  const row = await findUserWithTenant(db, { "u.id": userId });
  if (!row || accessProblem(row) || row.must_change_password || (payload && sessionProblem(payload, row))) return null;
  const tenant = tenantFromRow(row);
  const access = await loadAccess(db, row.id, tenant.features);
  const { active } = await workspaceMaintenance(db, row.tenant_maintenance);
  if (active && !bypassesMaintenance(active, access)) return null;
  return { kind: "user", iat: payload?.iat, iatMs: payload?.iatMs, userId: row.id, tenantId: row.tenant_id, dbKey: currentDbKey(), permissions: new Set(access.permissions), alive: true, checkedAt: Date.now() };
}

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Attaches the WebSocket endpoints to the HTTP server. */
export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" && url.pathname !== "/ws/public") return reject(socket, 404, "Not Found");
    if (!originAllowed(req)) return reject(socket, 403, "Forbidden");
    try {
      let meta;
      if (url.pathname === "/ws/public") {
        const channel = url.searchParams.get("channel") ?? "";
        if (!PUBLIC_CHANNEL.test(channel)) return reject(socket, 400, "Bad Request");
        meta = { kind: "public", channel: channel.replace(/:(.*)$/, (_, code) => `:${code.toUpperCase()}`), alive: true, checkedAt: Date.now() };
      } else {
        meta = await authenticate(req, url);
        if (!meta) return reject(socket, 401, "Unauthorized");
      }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.meta = meta;
        sockets.add(ws);
        ws.on("pong", () => (ws.meta.alive = true));
        ws.on("message", raw => {
          // The only client message is a keep-alive; anything else is ignored.
          if (String(raw).slice(0, 20).includes("ping")) ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
        });
        ws.on("close", () => sockets.delete(ws));
        ws.on("error", () => sockets.delete(ws));
        ws.send(JSON.stringify({ type: "hello", data: { kind: meta.kind }, at: new Date().toISOString() }));
      });
    } catch {
      reject(socket, 500, "Internal Server Error");
    }
  });

  const heartbeat = setInterval(async () => {
    for (const ws of sockets) {
      if (!ws.meta.alive) {
        ws.terminate();
        sockets.delete(ws);
        continue;
      }
      ws.meta.alive = false;
      ws.ping();
      if (ws.meta.kind === "user" && Date.now() - ws.meta.checkedAt > ACCESS_REFRESH_MS) {
        const fresh = await runInTenant(ws.meta.tenantId, () => loadMeta(ws.meta.userId, { iat: ws.meta.iat, iatMs: ws.meta.iatMs })).catch(() => ws.meta);
        if (!fresh) {
          ws.close(4001, "Session ended");
          sockets.delete(ws);
        } else ws.meta = { ...fresh, alive: ws.meta.alive };
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    close() {
      clearInterval(heartbeat);
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      wss.close();
    },
  };
}

/**
 * Sends an event to the matching sockets. Pick recipients with any combination of:
 * - users: these user ids, in the database of the current request or job (db/context.js)
 * - tenantId (+ optional permission, a key or a list where any one is enough): everyone in the tenant who holds it
 * - channel: anonymous public subscribers (queue:<code>, track:<code>)
 * Never throws: live updates are best-effort; the data is always re-fetched over HTTP.
 * @param {{ users?: number[], tenantId?: number, permission?: string | string[], channel?: string | string[] }} to
 * @param {string} type
 * @param {Object} [data]
 */
export function publish(to, type, data = {}) {
  try {
    const users = new Set((to.users ?? []).filter(Boolean));
    const permissions = to.permission ? [to.permission].flat() : null;
    const channels = new Set([to.channel ?? []].flat().map(channel => channel.replace(/:(.*)$/, (_, code) => `:${String(code).toUpperCase()}`)));
    const message = JSON.stringify({ type, data, at: new Date().toISOString() });
    const dbKey = currentDbKey();
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      const meta = ws.meta;
      let match = false;
      if (meta.kind === "public") match = channels.has(meta.channel);
      else {
        if (users.has(meta.userId) && (meta.dbKey ?? "platform") === dbKey) match = true;
        else if (to.tenantId && meta.tenantId === to.tenantId) match = !permissions || permissions.some(permission => meta.permissions.has(permission));
      }
      if (match) ws.send(message);
    }
  } catch (error) {
    console.warn("[realtime] publish failed:", error.message);
  }
}

/** Closes a person's live sockets (deactivated, password reset): their tabs then re-check the session. */
export function disconnectUser(userId, reason = "Session ended") {
  const dbKey = currentDbKey();
  for (const ws of sockets) {
    if (ws.meta.kind === "user" && ws.meta.userId === userId && (ws.meta.dbKey ?? "platform") === dbKey) {
      ws.close(4001, reason);
      sockets.delete(ws);
    }
  }
}

/** Closes the signed-in sockets of one tenant, or of every tenant with null (maintenance changes): tabs re-check access. */
export function disconnectTenantSockets(tenantId, reason = "Access changed") {
  for (const ws of sockets) {
    if (ws.meta.kind === "user" && (tenantId == null || ws.meta.tenantId === tenantId)) {
      ws.close(4001, reason);
      sockets.delete(ws);
    }
  }
}

/** Connection counts, for the provider console. */
export function realtimeStats() {
  let users = 0;
  let publicSockets = 0;
  for (const ws of sockets) ws.meta.kind === "user" ? users++ : publicSockets++;
  return { sockets: sockets.size, users, public: publicSockets };
}
