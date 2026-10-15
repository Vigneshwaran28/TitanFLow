// The tenant's own audit log: who changed access, settings, and approvals. Never blocks the action itself.
import { nowIso } from "../utils/http.js";

/**
 * @param {import("knex").Knex | import("knex").Knex.Transaction} db
 * @param {import("express").Request} req
 * @param {string} action - e.g. "user.create", "role.update", "leave.approve"
 * @param {string | null} [target] - e.g. "Asha Rao" or "Warehouse staff"
 * @param {Object | null} [details]
 */
export async function recordTenantAudit(db, req, action, target = null, details = null) {
  try {
    await db("tenant_audit").insert({
      tenant_id: req.user.tenant_id,
      actor_id: req.user.id,
      action,
      target: target ? String(target).slice(0, 160) : null,
      details: details ? JSON.stringify(details) : null,
      created_at: nowIso(),
    });
  } catch (error) {
    console.error("[tenant-audit] failed to record", action, error.message);
  }
}
