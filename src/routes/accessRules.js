// Access rules (mounted at /api/access-rules behind requireAuth): custom access for chosen people on top of their roles.
//   GET    /                   rules with their people, the module catalogue, and each permission's level
//   POST   /                   create          PATCH /:id   edit          DELETE /:id   delete
//   PUT    /:id/users          the people a rule applies to
//   GET    /explain/:userId    a person's effective access, and the role or rule behind each permission
// Managing rules needs workspace.roles.manage; reading them (and explaining) also workspace.users.manage. Nobody can
// grant access they don't hold themselves (owners excepted), the same as roles.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { requirePermission } from "../middleware/auth.js";
import {
  ACCESS_LEVELS,
  ACTIVE_PERMISSIONS,
  activeRulesByUser,
  compileRule,
  effectivePermissions,
  isLicensed,
  levelOf,
  parsePermissions,
  PERMISSION_KEYS,
  RULE_MODULES,
} from "../services/permissions.js";
import { disconnectUser } from "../services/realtime.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();
const canRead = requirePermission("workspace.roles.manage", "workspace.users.manage");
const canManage = requirePermission("workspace.roles.manage");

const day = z.preprocess(
  value => (value === "" ? null : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-31.")
    .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Enter a valid date.")
    .nullable()
);

const ruleFields = z.object({
    name: z.string().trim().min(1, "Name the rule.").max(80, "Keep the name under 80 characters."),
    description: z.string().trim().max(300).nullable().default(null),
    mode: z.enum(["grant", "limit"]),
    levels: z.partialRecord(z.enum(RULE_MODULES), z.enum([...ACCESS_LEVELS, "custom"])).refine(value => Object.keys(value).length > 0, "Set the access of at least one module."),
    permissions: z
      .array(z.string())
      .max(200)
      .refine(keys => keys.every(key => PERMISSION_KEYS.has(key)), "Unknown permission.")
      .default([]),
    startsOn: day.default(null),
    endsOn: day.default(null),
    isActive: z.boolean().default(true),
    userIds: z.array(z.number().int().positive()).max(1000).optional(),
});

const ruleSchema = ruleFields.superRefine((value, ctx) => {
    if (value.startsOn && value.endsOn && value.endsOn < value.startsOn) ctx.addIssue({ code: "custom", path: ["endsOn"], message: "The end date can't be before the start date." });
  });

const parse = (text, fallback) => {
  try {
    return JSON.parse(text ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};

const today = () => new Date().toISOString().slice(0, 10);

/** "active", "scheduled" (starts later), "expired", or "off". */
const stateOf = row => (!row.is_active ? "off" : row.starts_on && row.starts_on > today() ? "scheduled" : row.ends_on && row.ends_on < today() ? "expired" : "active");

async function listRules(db, tenantId) {
  const rules = await db("access_rules").where("tenant_id", tenantId).orderBy("name");
  const people = rules.length
    ? await db("access_rule_users as ru").join("users as u", "u.id", "ru.user_id").whereIn("ru.rule_id", rules.map(rule => rule.id)).select("ru.rule_id", "u.id", "u.name", "u.email", "u.is_active").orderBy("u.name")
    : [];
  return rules.map(rule => ({
    id: rule.id,
    name: rule.name,
    description: rule.description ?? "",
    mode: rule.mode,
    levels: parse(rule.levels, {}),
    permissions: parse(rule.permissions, []),
    startsOn: rule.starts_on ?? null,
    endsOn: rule.ends_on ?? null,
    isActive: Boolean(rule.is_active),
    state: stateOf(rule),
    users: people.filter(person => person.rule_id === rule.id).map(person => ({ id: person.id, name: person.name, email: person.email, isActive: Boolean(person.is_active) })),
    updatedAt: rule.updated_at,
  }));
}

async function findRule(db, tenantId, id) {
  const rule = await db("access_rules").where({ id, tenant_id: tenantId }).first();
  if (!rule) throw new HttpError(404, "Rule not found.");
  return rule;
}

async function assertUniqueName(db, tenantId, name, exceptId) {
  const query = db("access_rules").where("tenant_id", tenantId).whereRaw("lower(name) = ?", [name.toLowerCase()]);
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { name: "Another rule already has this name." } });
}

/** A grant can only give access the editor holds (owners may give anything). Limits take access away: always allowed. */
function assertCanGrant(req, mode, levels, permissions) {
  if (mode !== "grant" || req.access.isOwner) return;
  const rule = compileRule({ mode, levels, permissions });
  const missing = [...rule.modules.values()].flat().filter(key => isLicensed(key, req.tenant.features) && !req.access.permissions.includes(key));
  if (missing.length) {
    const labels = [...new Set(missing)].map(key => ACTIVE_PERMISSIONS.find(permission => permission.key === key)?.label ?? key);
    throw new HttpError(403, `You can't grant access you don't have yourself: ${labels.join(", ")}.`, { code: "FORBIDDEN" });
  }
}

/** People of this tenant only. */
async function checkUsers(db, tenantId, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await db("users").where("tenant_id", tenantId).whereIn("id", unique).select("id");
  if (found.length !== unique.length) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { userIds: "A chosen person isn't in this workspace." } });
  return unique;
}

/** Live sockets carry the old access: close them so the tabs reload it. */
const reconnect = ids => ids.forEach(id => disconnectUser(id, "Access changed"));

router.get("/", canRead, async (req, res) => {
  const catalog = ACTIVE_PERMISSIONS.filter(permission => isLicensed(permission.key, req.tenant.features)).map(permission => ({ ...permission, level: levelOf(permission.key) }));
  res.json({ rules: await listRules(getDb(), req.user.tenant_id), catalog, modules: RULE_MODULES.filter(module => catalog.some(permission => permission.module === module)), levels: ACCESS_LEVELS, mine: req.access.permissions, isOwner: req.access.isOwner });
});

router.post("/", canManage, async (req, res) => {
  const input = validate(ruleSchema, req.body ?? {});
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertUniqueName(db, tenantId, input.name);
  assertCanGrant(req, input.mode, input.levels, input.permissions);
  const userIds = await checkUsers(db, tenantId, input.userIds ?? []);
  const now = nowIso();
  const id = await db.transaction(async trx => {
    const ruleId = await insertAndGetId(trx, "access_rules", {
      tenant_id: tenantId,
      name: input.name,
      description: input.description || null,
      mode: input.mode,
      levels: JSON.stringify(input.levels),
      permissions: JSON.stringify(input.permissions),
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      is_active: input.isActive,
      created_by: req.user.id,
      created_at: now,
      updated_at: now,
    });
    if (userIds.length) await trx("access_rule_users").insert(userIds.map(userId => ({ rule_id: ruleId, user_id: userId, created_at: now })));
    return ruleId;
  });
  reconnect(userIds);
  await recordTenantAudit(db, req, "access_rule.create", input.name, { mode: input.mode, modules: Object.entries(input.levels).map(([module, level]) => `${module}:${level}`).join(" "), people: userIds.length });
  res.status(201).json((await listRules(db, tenantId)).find(rule => rule.id === id));
});

router.patch("/:id", canManage, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const rule = await findRule(db, tenantId, id);
  const input = validate(ruleFields.partial(), req.body ?? {});
  const startsOn = input.startsOn !== undefined ? input.startsOn : rule.starts_on;
  const endsOn = input.endsOn !== undefined ? input.endsOn : rule.ends_on;
  if (startsOn && endsOn && endsOn < startsOn) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { endsOn: "The end date can't be before the start date." } });
  if (input.name !== undefined && input.name !== rule.name) await assertUniqueName(db, tenantId, input.name, id);
  const mode = input.mode ?? rule.mode;
  const levels = input.levels ?? parse(rule.levels, {});
  const permissions = input.permissions ?? parse(rule.permissions, []);
  if (input.mode !== undefined || input.levels !== undefined || input.permissions !== undefined) assertCanGrant(req, mode, levels, permissions);
  const changes = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.description !== undefined) changes.description = input.description || null;
  if (input.mode !== undefined) changes.mode = input.mode;
  if (input.levels !== undefined) changes.levels = JSON.stringify(input.levels);
  if (input.permissions !== undefined) changes.permissions = JSON.stringify(input.permissions);
  if (input.startsOn !== undefined) changes.starts_on = input.startsOn;
  if (input.endsOn !== undefined) changes.ends_on = input.endsOn;
  if (input.isActive !== undefined) changes.is_active = input.isActive;
  const before = (await db("access_rule_users").where({ rule_id: id }).select("user_id")).map(row => row.user_id);
  let after = before;
  await db.transaction(async trx => {
    if (Object.keys(changes).length) await trx("access_rules").where({ id }).update({ ...changes, updated_at: nowIso() });
    if (input.userIds !== undefined) {
      after = await checkUsers(trx, tenantId, input.userIds);
      await trx("access_rule_users").where({ rule_id: id }).del();
      if (after.length) await trx("access_rule_users").insert(after.map(userId => ({ rule_id: id, user_id: userId, created_at: nowIso() })));
    }
  });
  reconnect([...new Set([...before, ...after])]);
  await recordTenantAudit(db, req, "access_rule.update", changes.name ?? rule.name, { changed: [...Object.keys(changes), ...(input.userIds !== undefined ? ["people"] : [])].join(" ") || null });
  res.json((await listRules(db, tenantId)).find(item => item.id === id));
});

router.put("/:id/users", canManage, async (req, res) => {
  const id = parseId(req.params.id);
  const { userIds } = validate(z.object({ userIds: z.array(z.number().int().positive()).max(1000) }), req.body ?? {});
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const rule = await findRule(db, tenantId, id);
  // Giving people a grant is granting: the same holder check as editing it.
  assertCanGrant(req, rule.mode, parse(rule.levels, {}), parse(rule.permissions, []));
  const users = await checkUsers(db, tenantId, userIds);
  const before = (await db("access_rule_users").where({ rule_id: id }).select("user_id")).map(row => row.user_id);
  await db.transaction(async trx => {
    await trx("access_rule_users").where({ rule_id: id }).del();
    if (users.length) await trx("access_rule_users").insert(users.map(userId => ({ rule_id: id, user_id: userId, created_at: nowIso() })));
  });
  reconnect([...new Set([...before, ...users])]);
  await recordTenantAudit(db, req, "access_rule.people", rule.name, { people: users.length });
  res.json((await listRules(db, tenantId)).find(item => item.id === id));
});

router.delete("/:id", canManage, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const rule = await findRule(db, req.user.tenant_id, id);
  const holders = (await db("access_rule_users").where({ rule_id: id }).select("user_id")).map(row => row.user_id);
  await db("access_rules").where({ id }).del();
  reconnect(holders);
  await recordTenantAudit(db, req, "access_rule.delete", rule.name);
  res.status(204).end();
});

// Why does this person have (or not have) each permission: roles, grants, and the limits that removed some.
router.get("/explain/:userId", canRead, async (req, res) => {
  const userId = parseId(req.params.userId);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await db("users").where({ id: userId, tenant_id: tenantId }).first("id", "name", "email", "is_active");
  if (!user) throw new HttpError(404, "Not found.");
  const features = req.tenant.features;
  const [roles, rules] = await Promise.all([
    db("user_roles as ur").join("roles as r", "r.id", "ur.role_id").where("ur.user_id", userId).select("r.id", "r.key", "r.name", "r.permissions"),
    activeRulesByUser(db, tenantId, [userId]).then(map => map.get(userId) ?? []),
  ]);
  const isOwner = roles.some(role => role.key === "owner");
  const all = ACTIVE_PERMISSIONS.map(permission => permission.key);
  const roleKeys = role => (role.key === "owner" ? all : parsePermissions(role.permissions));
  const compiled = rules.map(compileRule);
  const effective = new Set(effectivePermissions(roles, features, rules));
  const explained = ACTIVE_PERMISSIONS.filter(permission => isLicensed(permission.key, features)).map(permission => {
    const key = permission.key;
    const module = key.split(".")[0];
    const sources = [
      ...roles.filter(role => roleKeys(role).includes(key)).map(role => ({ type: "role", id: role.id, name: role.name })),
      ...compiled.filter(rule => rule.mode === "grant" && rule.modules.get(module)?.includes(key)).map(rule => ({ type: "grant", id: rule.id, name: rule.name })),
    ];
    const limitedBy = isOwner ? [] : compiled.filter(rule => rule.mode === "limit" && rule.modules.has(module) && !rule.modules.get(module).includes(key)).map(rule => ({ id: rule.id, name: rule.name }));
    return { key, label: permission.label, module, level: levelOf(key), granted: effective.has(key), sources, limitedBy };
  });
  // Every rule on the person, including the ones not in effect today (scheduled, expired, switched off).
  const assigned = await db("access_rule_users as ru").join("access_rules as r", "r.id", "ru.rule_id").where({ "ru.user_id": userId, "r.tenant_id": tenantId }).select("r.*");
  res.json({
    user: { id: user.id, name: user.name, email: user.email, isActive: Boolean(user.is_active) },
    isOwner,
    roles: roles.map(role => ({ id: role.id, name: role.name })),
    rules: assigned.map(rule => ({ id: rule.id, name: rule.name, mode: rule.mode, state: stateOf(rule) })),
    permissions: explained,
    total: effective.size,
  });
});

export default router;
