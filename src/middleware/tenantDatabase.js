// Routes each API request to the database of the workspace it is for (services/tenantDatabases.js). The workspace
// comes from the X-Workspace header (or ?ws=), a public page's address, the request body's `workspace`, or the
// workspace of the session cookie. Tenants without a database of their own, and requests that name no workspace, use
// the platform database. Nothing is looked up when no tenant has a dedicated database.
import jwt from "jsonwebtoken";
import { runWithDatabase } from "../db/context.js";
import { databaseEntryFor, hasDedicatedDatabases, tenantIdForSlug } from "../services/tenantDatabases.js";
import { requestedWorkspace, sessionToken } from "./auth.js";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** The workspace address a request is about, or null. Only used to pick a database: access is checked later. */
export function workspaceOfRequest(req) {
  const named = requestedWorkspace(req);
  if (named) return named;
  const path = req.path ?? "";
  const publicPage = path.match(/^\/public\/workspaces\/([a-z0-9-]+)/i);
  if (publicPage) return publicPage[1].toLowerCase();
  if (path.startsWith("/public/status") && SLUG.test(String(req.query?.workspace ?? "").toLowerCase())) return String(req.query.workspace).toLowerCase();
  const fromBody = typeof req.body?.workspace === "string" ? req.body.workspace.trim().toLowerCase() : "";
  if (SLUG.test(fromBody)) return fromBody;
  // The session's own workspace (signed; the signature is checked by requireAuth).
  const found = sessionToken(req.cookies, null);
  const ws = found ? jwt.decode(found.token)?.ws : null;
  return typeof ws === "string" && SLUG.test(ws) ? ws : null;
}

export function tenantDatabaseContext(req, res, next) {
  // The provider console picks a tenant per call (routes/admin.js).
  if (!hasDedicatedDatabases() || req.path.startsWith("/bunny")) return next();
  const slug = workspaceOfRequest(req);
  const tenantId = slug ? tenantIdForSlug(slug) : null;
  if (!tenantId) return next();
  return runWithDatabase(databaseEntryFor(tenantId), next);
}
