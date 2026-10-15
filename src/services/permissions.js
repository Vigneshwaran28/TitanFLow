// Access control (IAM) inside a tenant. Every action is guarded by a permission; people get permissions
// through roles, and a person can hold several roles (their access is the union). Each tenant has four
// built-in roles and can create its own. Only permissions of modules the tenant is licensed for apply.

/** module "workspace" is always licensed; the rest match FEATURES in tenants.js. */
export const PERMISSIONS = Object.freeze([
  { key: "workspace.users.manage", module: "workspace", label: "Manage users", description: "Create accounts, deactivate people, reset passwords, and assign roles." },
  { key: "workspace.roles.manage", module: "workspace", label: "Manage roles", description: "Create and edit roles and what each one can do." },
  { key: "workspace.settings.manage", module: "workspace", label: "Manage module settings", description: "Change working days, service targets, currency, and other settings." },
  { key: "workspace.audit.view", module: "workspace", label: "View audit log", description: "See who changed access, settings, and approvals." },

  { key: "tasks.use", module: "tasks", label: "Use tasks", description: "Personal tasks, lists, reminders, and calendar." },

  { key: "helpdesk.use", module: "helpdesk", label: "Raise tickets", description: "Raise tickets, follow their own, and work tickets assigned to them." },
  { key: "helpdesk.work", module: "helpdesk", label: "Work the help desk", description: "See every queue, assign, change any ticket, and add internal notes." },

  { key: "directory.view", module: "directory", label: "View people and teams", description: "Open the people directory and team pages." },
  { key: "directory.teams.manage", module: "directory", label: "Manage teams", description: "Create, edit, and delete teams and their members." },

  { key: "messaging.use", module: "messaging", label: "Send messages", description: "Direct messages with colleagues." },
  { key: "messaging.groups.create", module: "messaging", label: "Create group chats", description: "Start group chats and invite people." },

  // Retired: everyone can read announcements addressed to them (everyone, or one of their roles). The key stays
  // known so older role JSON and API clients keep working, but it is ignored and hidden from the role editor.
  { key: "announcements.view", module: "announcements", label: "Read announcements", description: "No longer needed: everyone can read announcements addressed to them.", retired: true },
  { key: "announcements.post", module: "announcements", label: "Post announcements", description: "Post to everyone or to chosen roles, and edit their own posts." },
  { key: "announcements.manage", module: "announcements", label: "Manage all announcements", description: "Edit, pin, or delete anyone's announcement." },

  { key: "inventory.view", module: "inventory", label: "View inventory", description: "See products, stock levels, and movement history." },
  { key: "inventory.products.edit", module: "inventory", label: "Edit products", description: "Add and edit products and prices." },
  { key: "inventory.stock.move", module: "inventory", label: "Record stock movements", description: "Record stock in, stock out, and counts." },
  { key: "inventory.products.delete", module: "inventory", label: "Delete products", description: "Delete products and their history." },

  { key: "sales.view", module: "sales", label: "View sales", description: "See customers, the pipeline, and orders." },
  { key: "sales.edit", module: "sales", label: "Edit sales records", description: "Add and edit customers, deals, and draft orders." },
  { key: "sales.orders.confirm", module: "sales", label: "Confirm and fulfil orders", description: "Confirm (takes stock), fulfil, and cancel orders." },
  { key: "sales.delete", module: "sales", label: "Delete sales records", description: "Delete customers and any deal." },

  { key: "billing.view", module: "billing", label: "View invoices and quotes", description: "See invoices, quotes, payments, and what's outstanding." },
  { key: "billing.edit", module: "billing", label: "Prepare invoices and quotes", description: "Create and edit drafts." },
  { key: "billing.issue", module: "billing", label: "Issue and void", description: "Send invoices and quotes, convert accepted quotes, and void invoices." },
  { key: "billing.payments.record", module: "billing", label: "Record payments", description: "Record and remove payments against invoices." },
  { key: "billing.delete", module: "billing", label: "Delete drafts", description: "Delete draft invoices and quotes." },

  { key: "logistics.view", module: "logistics", label: "View shipments", description: "See shipments, tracking history, carriers, and the fleet." },
  { key: "logistics.edit", module: "logistics", label: "Book shipments", description: "Create and edit shipments." },
  { key: "logistics.dispatch", module: "logistics", label: "Dispatch", description: "Assign carriers, vehicles, and drivers, and update any shipment's status." },
  { key: "logistics.deliver", module: "logistics", label: "Deliver", description: "Update the status of shipments assigned to them as the driver." },
  { key: "logistics.fleet.manage", module: "logistics", label: "Manage carriers and fleet", description: "Add and edit carriers and vehicles." },

  { key: "clinic.schedule.view", module: "clinic", label: "View the appointment book", description: "See the clinic's schedule and patient names." },
  { key: "clinic.appointments.manage", module: "clinic", label: "Manage appointments", description: "Book, reschedule, cancel, and check patients in." },
  { key: "clinic.patients.manage", module: "clinic", label: "Register patients", description: "Add patients and edit their contact and insurance details." },
  { key: "clinic.practitioner", module: "clinic", label: "Practitioner", description: "Can be booked, and records visits and prescriptions for their patients." },
  { key: "clinic.records.view", module: "clinic", label: "View medical records", description: "Read every patient's visit notes and prescriptions." },
  { key: "clinic.providers.manage", module: "clinic", label: "Manage practitioners", description: "Set up practitioners, their specialties, and their weekly schedules." },
  { key: "clinic.vitals.record", module: "clinic", label: "Record vitals", description: "Record vitals and the chief complaint for checked-in patients before the doctor sees them." },

  { key: "notes.use", module: "notes", label: "Use notes", description: "Write sticky notes and share them with colleagues or the whole workspace." },
  { key: "notes.manage", module: "notes", label: "Manage all notes", description: "See, edit, reassign, and delete any note in the workspace, including private ones." },

  { key: "attendance.self", module: "attendance", label: "Own attendance and leave", description: "Check in and out, and request leave." },
  { key: "attendance.team.view", module: "attendance", label: "View team attendance", description: "See who's in today and the monthly report." },
  { key: "attendance.leave.approve", module: "attendance", label: "Approve leave", description: "Approve or reject leave requests." },
  { key: "attendance.holidays.manage", module: "attendance", label: "Manage holidays", description: "Add, import, and remove holidays, and set weekend rules." },

  { key: "expenses.submit", module: "expenses", label: "Submit expense claims", description: "Claim expenses and follow their status." },
  { key: "expenses.approve", module: "expenses", label: "Approve expense claims", description: "Approve or reject other people's claims." },
  { key: "expenses.pay", module: "expenses", label: "Pay expense claims", description: "Mark approved claims as paid." },
]);

export const PERMISSION_KEYS = new Set(PERMISSIONS.map(permission => permission.key));
/** Keys that are accepted for compatibility but grant nothing and are not offered in the role editor. */
export const RETIRED_PERMISSION_KEYS = new Set(PERMISSIONS.filter(permission => permission.retired).map(permission => permission.key));
/** The permissions the role editor offers. */
export const ACTIVE_PERMISSIONS = Object.freeze(PERMISSIONS.filter(permission => !permission.retired));
const ALL = ACTIVE_PERMISSIONS.map(permission => permission.key);

const MEMBER = [
  "tasks.use",
  "helpdesk.use",
  "directory.view",
  "messaging.use",
  "messaging.groups.create",
  "inventory.view",
  "inventory.products.edit",
  "inventory.stock.move",
  "sales.view",
  "sales.edit",
  "sales.orders.confirm",
  "billing.view",
  "logistics.view",
  "logistics.deliver",
  "clinic.schedule.view",
  "notes.use",
  "attendance.self",
  "expenses.submit",
];

/** Built-in roles every tenant starts with. `owner` always has every permission and can't be edited. */
export const SYSTEM_ROLES = Object.freeze([
  { key: "owner", name: "Owner", description: "Full control, including who else is an owner. Can't be edited or deleted.", permissions: ALL },
  { key: "admin", name: "Admin", description: "Runs the workspace day to day: users, roles, settings, and every approval.", permissions: ALL },
  { key: "agent", name: "Agent", description: "Everything a member can do, plus working the whole help desk queue.", permissions: [...MEMBER, "helpdesk.work"] },
  { key: "member", name: "Member", description: "Everyday use of the workspace's modules.", permissions: MEMBER },
]);

/** Keys from stored JSON, keeping only known, current permissions (retired ones are dropped). */
export function parsePermissions(json) {
  try {
    const list = JSON.parse(json || "[]");
    return Array.isArray(list) ? list.filter(key => PERMISSION_KEYS.has(key) && !RETIRED_PERMISSION_KEYS.has(key)) : [];
  } catch {
    return [];
  }
}

/** Permissions that serve more than one module (teams route help desk tickets too). */
const LICENSED_BY = Object.freeze({ "directory.teams.manage": ["directory", "helpdesk"] });

/** A permission applies only when its module (or one it serves) is licensed to the tenant. */
export const isLicensed = (key, features) => {
  const module = key.split(".")[0];
  return module === "workspace" || (LICENSED_BY[key] ?? [module]).some(feature => features.includes(feature));
};

/** Effective permissions for a set of role rows, limited to licensed modules. */
export function effectivePermissions(roleRows, features, rules = []) {
  const keys = new Set();
  for (const role of roleRows) {
    const list = role.key === "owner" ? ALL : parsePermissions(role.permissions);
    list.forEach(key => keys.add(key));
  }
  const isOwner = roleRows.some(role => role.key === "owner");
  return applyRules([...keys], rules, isOwner).filter(key => isLicensed(key, features));
}

// ---- Access rules: access given to (grant) or capped for (limit) chosen people, on top of their roles ----
// A rule sets each module to a level (none, read, write, manage) or to a custom list of its permissions. Levels add up:
// write includes read, manage includes write. A grant rule adds the permissions it covers; a limit rule caps the modules
// it names at its level (wins over roles and grants). Owners are never limited. Rules may start and end on a date.

export const ACCESS_LEVELS = Object.freeze(["none", "read", "write", "manage"]);
const LEVEL_RANK = Object.freeze({ none: 0, read: 1, write: 2, manage: 3 });

/** The level each permission belongs to. Sensitive reads (medical records, the audit log) count as manage. */
export const PERMISSION_LEVEL = Object.freeze({
  "workspace.users.manage": "manage",
  "workspace.roles.manage": "manage",
  "workspace.settings.manage": "manage",
  "workspace.audit.view": "manage",
  "tasks.use": "write",
  "helpdesk.use": "write",
  "helpdesk.work": "manage",
  "directory.view": "read",
  "directory.teams.manage": "manage",
  "messaging.use": "write",
  "messaging.groups.create": "write",
  "announcements.view": "read",
  "announcements.post": "write",
  "announcements.manage": "manage",
  "inventory.view": "read",
  "inventory.products.edit": "write",
  "inventory.stock.move": "write",
  "inventory.products.delete": "manage",
  "sales.view": "read",
  "sales.edit": "write",
  "sales.orders.confirm": "write",
  "sales.delete": "manage",
  "billing.view": "read",
  "billing.edit": "write",
  "billing.payments.record": "write",
  "billing.issue": "manage",
  "billing.delete": "manage",
  "logistics.view": "read",
  "logistics.edit": "write",
  "logistics.deliver": "write",
  "logistics.dispatch": "manage",
  "logistics.fleet.manage": "manage",
  "clinic.schedule.view": "read",
  "clinic.appointments.manage": "write",
  "clinic.patients.manage": "write",
  "clinic.practitioner": "write",
  "clinic.vitals.record": "write",
  "clinic.records.view": "manage",
  "clinic.providers.manage": "manage",
  "notes.use": "write",
  "notes.manage": "manage",
  "attendance.team.view": "read",
  "attendance.self": "write",
  "attendance.leave.approve": "manage",
  "attendance.holidays.manage": "manage",
  "expenses.submit": "write",
  "expenses.approve": "manage",
  "expenses.pay": "manage",
});

export const levelOf = key => PERMISSION_LEVEL[key] ?? "manage";
const moduleOf = key => key.split(".")[0];

/** Every module a rule can name: "workspace" plus each licensable module that has permissions. */
export const RULE_MODULES = Object.freeze([...new Set(ACTIVE_PERMISSIONS.map(permission => permission.module))]);

/** The permissions of one module that a level (or a custom list) allows. */
export function keysForLevel(module, level, custom = []) {
  if (level === "custom") return custom.filter(key => moduleOf(key) === module && PERMISSION_KEYS.has(key) && !RETIRED_PERMISSION_KEYS.has(key));
  const rank = LEVEL_RANK[level] ?? 0;
  return ACTIVE_PERMISSIONS.filter(permission => permission.module === module && LEVEL_RANK[levelOf(permission.key)] <= rank).map(permission => permission.key);
}

/** A stored rule as { mode, modules: Map(module -> allowed keys) }. */
export function compileRule(rule) {
  const parse = text => {
    try {
      const value = typeof text === "string" ? JSON.parse(text || "null") : text;
      return value ?? null;
    } catch {
      return null;
    }
  };
  const levels = parse(rule.levels) ?? {};
  const custom = parse(rule.permissions) ?? [];
  const modules = new Map();
  for (const [module, level] of Object.entries(levels)) {
    if (!RULE_MODULES.includes(module) || !(level in LEVEL_RANK || level === "custom")) continue;
    modules.set(module, keysForLevel(module, level, Array.isArray(custom) ? custom : []));
  }
  return { id: rule.id, name: rule.name, mode: rule.mode === "limit" ? "limit" : "grant", modules };
}

/** Role permissions with a person's active rules applied: grants first, then limits (owners are never limited). */
export function applyRules(keys, rules = [], isOwner = false) {
  if (!rules.length) return keys;
  const compiled = rules.map(rule => (rule.modules ? rule : compileRule(rule)));
  const result = new Set(keys);
  for (const rule of compiled) if (rule.mode === "grant") for (const allowed of rule.modules.values()) allowed.forEach(key => result.add(key));
  if (!isOwner) {
    for (const rule of compiled) {
      if (rule.mode !== "limit") continue;
      for (const key of [...result]) {
        const allowed = rule.modules.get(moduleOf(key));
        if (allowed && !allowed.includes(key)) result.delete(key);
      }
    }
  }
  return [...result];
}

/** Today as YYYY-MM-DD (UTC), for rule start and end dates. */
const today = () => new Date().toISOString().slice(0, 10);

/** Restricts an access_rules query (aliased r) to rules in effect today. */
export function whereRuleActive(query, day = today()) {
  return query
    .where("r.is_active", true)
    .where(inner => inner.whereNull("r.starts_on").orWhere("r.starts_on", "<=", day))
    .where(inner => inner.whereNull("r.ends_on").orWhere("r.ends_on", ">=", day));
}

/**
 * Active rules per person: userId -> rule rows. A database without the rules tables yet (mid-upgrade) has no rules.
 * @param {import("knex").Knex} db
 * @param {number | null} tenantId - null: any (the people named are in one tenant anyway)
 * @param {number[]} [userIds] - limit to these people
 */
export async function activeRulesByUser(db, tenantId, userIds) {
  const query = whereRuleActive(db("access_rule_users as ru").join("access_rules as r", "r.id", "ru.rule_id"));
  if (tenantId) query.where("r.tenant_id", tenantId);
  if (userIds) query.whereIn("ru.user_id", userIds);
  let rows;
  try {
    rows = await query.select("ru.user_id", "r.id", "r.name", "r.mode", "r.levels", "r.permissions");
  } catch (error) {
    if (/access_rule/i.test(String(error.message))) return new Map();
    throw error;
  }
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push(row);
  }
  return map;
}

/** Creates the built-in roles for a new tenant; returns { owner: id, admin: id, agent: id, member: id }. */
export async function seedTenantRoles(db, tenantId, now = new Date().toISOString()) {
  const ids = {};
  for (const role of SYSTEM_ROLES) {
    const [row] = await db("roles")
      .insert({ tenant_id: tenantId, key: role.key, name: role.name, description: role.description, permissions: JSON.stringify(role.permissions), is_system: true, created_at: now, updated_at: now })
      .returning("id");
    ids[role.key] = typeof row === "object" ? row.id : row;
  }
  return ids;
}

/** Everyday access for staff roles a module adds: their own tasks, chat, directory, notes, and attendance. */
const STAFF_BASICS = ["tasks.use", "messaging.use", "directory.view", "notes.use", "attendance.self"];

/**
 * Starter roles a module brings, by FEATURES key. Unlike the built-in roles they are ordinary roles (not system):
 * the tenant may rename, edit, or delete them. `key` keeps them recognisable so they're created only once.
 * Permissions of modules the tenant isn't licensed for are stored but grant nothing until it is (effectivePermissions).
 */
export const MODULE_ROLES = Object.freeze({
  clinic: [
    {
      key: "doctor",
      name: "Doctor",
      description: "Sees the appointment book and their queue, writes visits and prescriptions, and reads medical records.",
      permissions: ["clinic.schedule.view", "clinic.practitioner", "clinic.records.view", ...STAFF_BASICS],
    },
    {
      key: "nurse",
      name: "Nurse",
      description: "Sees the appointment book and queues, and records vitals before the doctor.",
      permissions: ["clinic.schedule.view", "clinic.vitals.record", ...STAFF_BASICS],
    },
    {
      key: "receptionist",
      name: "Receptionist",
      description: "Registers patients, books and checks them in, issues tokens, and runs the queues.",
      permissions: ["clinic.schedule.view", "clinic.appointments.manage", "clinic.patients.manage", ...STAFF_BASICS],
    },
  ],
});

/**
 * Creates the starter roles of the tenant's licensed modules (MODULE_ROLES) that it doesn't have yet. Idempotent: a role
 * is matched by its key, and a role the tenant already made with the same name is left alone (names are unique per
 * tenant). Call it when a tenant is created and whenever its modules change.
 * @param {import("knex").Knex | import("knex").Knex.Transaction} db
 * @param {number} tenantId
 * @param {string[]} features - FEATURES keys the tenant is licensed for
 * @param {string} [now]
 * @returns {Promise<Record<string, number>>} role key -> id, for every starter role the tenant has (new or existing)
 */
export async function ensureModuleRoles(db, tenantId, features, now = new Date().toISOString()) {
  const wanted = Object.entries(MODULE_ROLES)
    .filter(([module]) => (features ?? []).includes(module))
    .flatMap(([, roles]) => roles);
  if (!wanted.length) return {};
  const existing = await db("roles").where("tenant_id", tenantId).select("id", "key", "name");
  const ids = {};
  for (const role of wanted) {
    const byKey = existing.find(row => row.key === role.key);
    if (byKey) {
      ids[role.key] = byKey.id;
      continue;
    }
    if (existing.some(row => String(row.name).toLowerCase() === role.name.toLowerCase())) continue;
    const [row] = await db("roles")
      .insert({ tenant_id: tenantId, key: role.key, name: role.name, description: role.description, permissions: JSON.stringify(role.permissions), is_system: false, created_at: now, updated_at: now })
      .returning("id");
    ids[role.key] = typeof row === "object" ? row.id : row;
    existing.push({ id: ids[role.key], key: role.key, name: role.name });
  }
  return ids;
}

/** Ids of active users in a tenant who hold a permission (through any role, owners always). */
export async function usersWithPermission(db, tenantId, permission) {
  const roles = await db("roles").where("tenant_id", tenantId).select("id", "key", "permissions");
  const roleIds = roles.filter(role => role.key === "owner" || parsePermissions(role.permissions).includes(permission)).map(role => role.id);
  const fromRoles = roleIds.length
    ? (
        await db("user_roles as ur")
          .join("users as u", "u.id", "ur.user_id")
          .whereIn("ur.role_id", roleIds)
          .where({ "u.tenant_id": tenantId, "u.is_active": true })
          .distinct("u.id")
      ).map(row => row.id)
    : [];
  // Access rules: grants add people, limits take them away (never owners).
  const rules = await activeRulesByUser(db, tenantId);
  if (!rules.size) return fromRoles;
  const ownerRole = roles.find(role => role.key === "owner")?.id;
  const owners = new Set(ownerRole ? (await db("user_roles").where("role_id", ownerRole).select("user_id")).map(row => row.user_id) : []);
  const result = new Set(fromRoles);
  const active = new Set((await db("users").where({ tenant_id: tenantId, is_active: true }).whereIn("id", [...rules.keys()]).select("id")).map(row => row.id));
  for (const [userId, list] of rules) {
    if (!active.has(userId)) continue;
    const keys = applyRules(result.has(userId) ? [permission] : [], list, owners.has(userId));
    if (keys.includes(permission)) result.add(userId);
    else result.delete(userId);
  }
  return [...result];
}

/** Every role id per user in a tenant (for listing people with their roles). */
export async function rolesByUser(db, tenantId) {
  const rows = await db("user_roles as ur").join("roles as r", "r.id", "ur.role_id").where("r.tenant_id", tenantId).select("ur.user_id", "r.id", "r.key", "r.name");
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push({ id: row.id, key: row.key, name: row.name });
  }
  return map;
}
