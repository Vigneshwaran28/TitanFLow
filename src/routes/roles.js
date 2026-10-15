// Roles and permissions (IAM) for a tenant. The Owner role is fixed; Admin, Agent, and Member start with
// sensible permissions that can be tuned; custom roles can be created. Nobody can put a permission into a
// role that they don't hold themselves (owners excepted).
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { requirePermission } from "../middleware/auth.js";
import { ACTIVE_PERMISSIONS, isLicensed, parsePermissions, PERMISSION_KEYS, PERMISSIONS, RETIRED_PERMISSION_KEYS } from "../services/permissions.js";
import { disconnectUser } from "../services/realtime.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const roleSchema = z.object({
  name: z.string().trim().min(1, "Name the role.").max(60, "Keep the name under 60 characters."),
  description: z.string().trim().max(300).nullable().default(null),
  permissions: z
    .array(z.string())
    .max(200)
    .refine(keys => keys.every(key => PERMISSION_KEYS.has(key)), "Unknown permission.")
    .transform(keys => keys.filter(key => !RETIRED_PERMISSION_KEYS.has(key))), // accepted from older clients, never stored
});

const forbidden = message => new HttpError(403, message, { code: "FORBIDDEN" });

/** Roles with their licensed permissions (unlicensed ones stay stored, but grant nothing and aren't shown). */
async function listRoles(db, tenantId, features) {
  const [roles, counts] = await Promise.all([
    db("roles").where("tenant_id", tenantId).orderBy("is_system", "desc").orderBy("id"),
    db("user_roles as ur").join("users as u", "u.id", "ur.user_id").where({ "u.tenant_id": tenantId, "u.is_active": true }).groupBy("ur.role_id").select("ur.role_id").count({ count: "*" }),
  ]);
  const countBy = new Map(counts.map(row => [row.role_id, Number(row.count)]));
  return roles.map(role => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: Boolean(role.is_system),
    locked: role.key === "owner", // every permission, always
    permissions: (role.key === "owner" ? ACTIVE_PERMISSIONS.map(permission => permission.key) : parsePermissions(role.permissions)).filter(key => isLicensed(key, features)),
    members: countBy.get(role.id) ?? 0,
    updatedAt: role.updated_at,
  }));
}

async function findRole(db, tenantId, id) {
  const role = await db("roles").where({ id, tenant_id: tenantId }).first();
  if (!role) throw new HttpError(404, "Role not found.");
  return role;
}

/** Live sockets of the role's holders carry the old access: close them so their tabs reload the session. */
async function disconnectHolders(db, roleId) {
  for (const row of await db("user_roles").where({ role_id: roleId }).select("user_id")) disconnectUser(row.user_id, "Access changed");
}

/** Only permissions of licensed modules, and only ones the editor holds (owners may grant anything). */
function cleanPermissions(req, keys) {
  const licensed = [...new Set(keys)].filter(key => isLicensed(key, req.tenant.features));
  if (!req.access.isOwner) {
    const missing = licensed.filter(key => !req.access.permissions.includes(key));
    if (missing.length) {
      const labels = missing.map(key => PERMISSIONS.find(permission => permission.key === key)?.label ?? key);
      throw forbidden(`You can't grant access you don't have yourself: ${labels.join(", ")}.`);
    }
  }
  return licensed;
}

async function assertUniqueName(db, tenantId, name, exceptId) {
  const query = db("roles").where("tenant_id", tenantId).whereRaw("lower(name) = ?", [name.toLowerCase()]);
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { name: "Another role already has this name." } });
}

// Reading roles is needed to assign them, so user managers can list them too.
router.get("/", requirePermission("workspace.roles.manage", "workspace.users.manage"), async (req, res) => {
  const catalog = ACTIVE_PERMISSIONS.filter(permission => isLicensed(permission.key, req.tenant.features));
  res.json({ roles: await listRoles(getDb(), req.user.tenant_id, req.tenant.features), catalog, mine: req.access.permissions, isOwner: req.access.isOwner });
});

router.post("/", requirePermission("workspace.roles.manage"), async (req, res) => {
  const input = validate(roleSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertUniqueName(db, tenantId, input.name);
  const permissions = cleanPermissions(req, input.permissions);
  const now = nowIso();
  const id = await insertAndGetId(db, "roles", { tenant_id: tenantId, key: null, name: input.name, description: input.description || null, permissions: JSON.stringify(permissions), is_system: false, created_at: now, updated_at: now });
  await recordTenantAudit(db, req, "role.create", input.name, { permissions: permissions.length });
  res.status(201).json((await listRoles(db, tenantId, req.tenant.features)).find(role => role.id === id));
});

router.patch("/:id", requirePermission("workspace.roles.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const role = await findRole(db, tenantId, id);
  if (role.key === "owner") throw forbidden("The Owner role always has full access and can't be changed.");
  const input = validate(roleSchema.partial(), req.body ?? {});
  const changes = {};
  if (input.name !== undefined && input.name !== role.name) {
    if (role.is_system) throw new HttpError(422, "Built-in roles can't be renamed.", { code: "SYSTEM_ROLE" });
    await assertUniqueName(db, tenantId, input.name, id);
    changes.name = input.name;
  }
  if (input.description !== undefined) changes.description = input.description || null;
  let before = null;
  if (input.permissions !== undefined) {
    before = parsePermissions(role.permissions);
    // Unlicensed permissions already in the role are kept, so they return if the module is licensed again.
    const kept = before.filter(key => !isLicensed(key, req.tenant.features));
    const added = input.permissions.filter(key => !before.includes(key));
    const removed = before.filter(key => isLicensed(key, req.tenant.features) && !input.permissions.includes(key));
    cleanPermissions(req, [...added, ...removed]); // you can only add or remove access you hold
    changes.permissions = JSON.stringify([...new Set([...kept, ...cleanPermissionsUnchecked(req, input.permissions)])]);
  }
  if (Object.keys(changes).length) await db("roles").where({ id }).update({ ...changes, updated_at: nowIso() });
  if (changes.permissions !== undefined && changes.permissions !== role.permissions) await disconnectHolders(db, id);
  const after = (await listRoles(db, tenantId, req.tenant.features)).find(item => item.id === id);
  if (before) {
    const added = after.permissions.filter(key => !before.includes(key));
    const removed = before.filter(key => isLicensed(key, req.tenant.features) && !after.permissions.includes(key));
    await recordTenantAudit(db, req, "role.permissions", after.name, { added: added.join(" ") || null, removed: removed.join(" ") || null });
  } else if (Object.keys(changes).length) {
    await recordTenantAudit(db, req, "role.update", after.name);
  }
  res.json(after);
});

/** Licensed permission keys without the holder check (used after the check passed for the changes). */
const cleanPermissionsUnchecked = (req, keys) => [...new Set(keys)].filter(key => isLicensed(key, req.tenant.features));

router.delete("/:id", requirePermission("workspace.roles.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const role = await findRole(db, tenantId, id);
  if (role.is_system) throw new HttpError(422, "Built-in roles can't be deleted.", { code: "SYSTEM_ROLE" });
  // Nobody may be left without any role.
  const holders = await db("user_roles").where({ role_id: id }).select("user_id");
  if (holders.length) {
    const others = await db("user_roles").whereIn("user_id", holders.map(row => row.user_id)).whereNot("role_id", id).distinct("user_id");
    if (others.length < holders.length) {
      const stranded = holders.length - others.length;
      throw new HttpError(422, `${stranded} ${stranded === 1 ? "person has" : "people have"} only this role. Give them another role first.`, { code: "ROLE_IN_USE" });
    }
  }
  await db("roles").where({ id }).delete();
  holders.forEach(row => disconnectUser(row.user_id, "Access changed")); // after the delete, so reconnects see the new access
  await recordTenantAudit(db, req, "role.delete", role.name);
  res.status(204).end();
});

export default router;
