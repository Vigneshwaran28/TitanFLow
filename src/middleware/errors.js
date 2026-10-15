import { isConfigured } from "../config/store.js";
import { currentDatabase } from "../db/context.js";
import { syncTables } from "../db/schemaCatalog.js";
import { platformSwitchInProgress } from "../services/platformDatabase.js";
import { missingTableName } from "../services/tenantDatabases.js";
import { HttpError } from "../utils/http.js";

/** Blocks app routes until the setup wizard has run. */
export function requireSetup(req, res, next) {
  if (!isConfigured()) throw new HttpError(503, "Setup is not complete.", { code: "SETUP_REQUIRED" });
  // The provider is moving the platform database: workspaces wait (nothing may be written to the old copy meanwhile).
  if (platformSwitchInProgress() && !req.path.startsWith("/bunny") && !req.path.startsWith("/public/status")) {
    throw new HttpError(503, "TaskFlow is moving to a new database. This usually takes a minute; please try again shortly.", { code: "DATABASE_SWITCH" });
  }
  next();
}

export function notFound(req, res) {
  res.status(404).json({ message: "Not found.", code: "NOT_FOUND" });
}

/** Converts every error into `{ message, code, errors? }`. Unknown errors never leak details. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ ...error.data, message: error.message, code: error.code, errors: error.errors });
  }
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body.", code: "BAD_JSON" });
  }
  // A dedicated tenant database without a table this request needed (a module's table, or one added by an update):
  // create it now and ask the browser to try again (the app retries failed loads).
  const missing = missingTableName(error);
  const current = currentDatabase();
  if (missing && current?.key.startsWith("tenant:")) {
    console.warn(`[tenant-db] tenant ${current.tenantId}: adding missing table ${missing}`);
    syncTables(current.db, [missing]).catch(problem => console.error("[tenant-db] could not add", missing, problem.message));
    return res.status(503).json({ message: "This workspace's storage was just updated. Please try again.", code: "SCHEMA_UPDATED" });
  }
  console.error("[error]", req.method, req.originalUrl, error);
  res.status(500).json({ message: "Something went wrong. Please try again.", code: "INTERNAL" });
}
