// Workspace settings: tenant admins tune their licensed modules (the provider sets which modules exist), set the
// workspace's restrictions (settings.security), and see an overview of their workspace.
import { Router } from "express";
import { getDb } from "../db/connection.js";
import { can, requirePermission } from "../middleware/auth.js";
import { OPEN_STATUSES } from "../services/passwordResets.js";
import { disconnectUser, publish } from "../services/realtime.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { applySettingsPatch, resolveSettings, validateSettings, WORKSPACE_KEYS } from "../services/moduleSettings.js";
import { subscriptionSummary } from "../services/subscriptionDates.js";
import { effectiveFeatures, parseFeatures } from "../services/tenants.js";
import { updateTenantRow } from "../services/tenantDatabases.js";
import { HttpError, nowIso } from "../utils/http.js";

const router = Router();

/** Licensed (by the provider) vs. enabled (licensed minus what the workspace switched off). */
const modulesOf = tenant => ({ licensed: parseFeatures(tenant.features), enabled: effectiveFeatures(tenant.features, resolveSettings(tenant.settings)) });

router.get("/settings", async (req, res) => {
  const tenant = await getDb()("tenants").where({ id: req.user.tenant_id }).first();
  res.json({ features: req.tenant.features, licensed: parseFeatures(tenant.features), settings: req.tenant.settings });
});

router.patch("/settings", requirePermission("workspace.settings.manage"), async (req, res) => {
  const patch = validateSettings(req.body ?? {}); // custom CSS problems report as branding.customCss.login / .app
  const unlicensed = Object.keys(patch).filter(key => !WORKSPACE_KEYS.includes(key) && !req.tenant.features.includes(key));
  if (unlicensed.length) throw new HttpError(403, "That module isn't enabled for your workspace.", { code: "FEATURE_DISABLED" });

  const db = getDb();
  const tenant = await db("tenants").where({ id: req.user.tenant_id }).first();
  const licensed = parseFeatures(tenant.features);
  const disabled = patch.security?.disabledModules;
  if (disabled) {
    if (disabled.some(key => !licensed.includes(key))) {
      throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { security: "Only modules on your plan can be switched off." } });
    }
    if (disabled.length >= licensed.length) {
      throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { security: "Keep at least one module switched on." } });
    }
  }
  const before = resolveSettings(tenant.settings);
  const json = applySettingsPatch(tenant.settings, patch);
  const settings = resolveSettings(json);
  // The registry (platform database) and, for a tenant with its own database, its copy there.
  await updateTenantRow(tenant.id, { settings: json, updated_at: nowIso() });
  await recordTenantAudit(db, req, "settings.update", Object.keys(patch).join(", "), patch.security ? securityChanges(before.security, settings.security) : null);

  // Switching modules off or on changes what everyone may do: their live sockets reconnect with the new access.
  const modulesChanged = disabled && [...disabled].sort().join() !== [...before.security.disabledModules].sort().join();
  if (modulesChanged) for (const member of await db("users").where({ tenant_id: tenant.id }).select("id")) disconnectUser(member.id, "Access changed");
  publish({ tenantId: tenant.id }, "settings.updated", { keys: Object.keys(patch) });
  res.json({ features: effectiveFeatures(tenant.features, settings), licensed, settings });
});

/** "minimum length 8 -> 12" style details for the audit log. */
function securityChanges(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    const from = JSON.stringify(before[key]);
    const to = JSON.stringify(after[key]);
    if (from !== to) changes[key] = `${from} -> ${to}`;
  }
  return Object.keys(changes).length ? changes : null;
}

const ADMIN_PERMISSIONS = ["workspace.users.manage", "workspace.roles.manage", "workspace.settings.manage", "workspace.audit.view"];
const DAY_MS = 86_400_000;

/**
 * The workspace admin's overview: plan and subscription, seats, who is signing in, roles, modules, the
 * restrictions in force, and what needs attention. Sections the admin can't act on are left out.
 */
router.get("/overview", requirePermission(...ADMIN_PERMISSIONS), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const tenant = await db("tenants").where({ id: tenantId }).first();
  const users = await db("users").where({ tenant_id: tenantId }).select("id", "name", "is_active", "must_change_password", "last_login_at", "created_at");
  const active = users.filter(user => user.is_active);
  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const canUsers = can(req, "workspace.users.manage");

  const [roles, members, openResets, audit] = await Promise.all([
    db("roles").where("tenant_id", tenantId).orderBy("is_system", "desc").orderBy("id").select("id", "key", "name", "is_system"),
    db("user_roles as ur").join("users as u", "u.id", "ur.user_id").where({ "u.tenant_id": tenantId, "u.is_active": true }).groupBy("ur.role_id").select("ur.role_id").count({ count: "*" }),
    canUsers ? db("password_resets").where({ tenant_id: tenantId }).whereIn("status", OPEN_STATUSES).count({ count: "*" }) : null,
    can(req, "workspace.audit.view")
      ? db("tenant_audit as a").leftJoin("users as u", "u.id", "a.actor_id").where("a.tenant_id", tenantId).orderBy("a.id", "desc").limit(8).select("a.id", "a.action", "a.target", "a.created_at", "u.name as actor_name")
      : null,
  ]);

  res.json({
    workspace: { name: tenant.name, slug: tenant.slug, status: tenant.status, createdAt: tenant.created_at },
    subscription: subscriptionSummary(tenant),
    seats: { used: active.length, limit: tenant.max_users ?? null },
    people: {
      total: users.length,
      active: active.length,
      deactivated: users.length - active.length,
      temporaryPassword: active.filter(user => user.must_change_password).length,
      neverSignedIn: active.filter(user => !user.last_login_at).length,
      signedInLast7Days: active.filter(user => user.last_login_at && user.last_login_at >= since).length,
    },
    roles: roles.map(role => ({ id: role.id, key: role.key ?? null, name: role.name, isSystem: Boolean(role.is_system), members: Number(members.find(row => row.role_id === role.id)?.count ?? 0) })),
    modules: modulesOf(tenant),
    security: req.tenant.settings.security,
    openPasswordRequests: openResets ? Number(openResets[0]?.count ?? 0) : null,
    recentActivity: audit?.map(entry => ({ id: entry.id, action: entry.action, target: entry.target, actor: entry.actor_name ?? null, createdAt: entry.created_at })) ?? null,
  });
});

export default router;
