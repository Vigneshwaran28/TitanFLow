// Announcements: company notices with pinning and read tracking, scoped to the tenant.
// An announcement goes to everyone ("all") or only to people holding chosen roles ("roles"). Every member reads
// what is addressed to them; no permission is needed for that. Posting and managing are permissions
// ("Post announcements", "Manage all announcements"); authors and managers always see their announcements.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can } from "../middleware/auth.js";
import { notifyUsers } from "../services/notify.js";
import { publish } from "../services/realtime.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const AUDIENCES = ["all", "roles"];
const ROLES_REQUIRED = "Pick at least one role, or send it to everyone.";

const fields = {
  title: z.string().trim().min(1, "Title is required.").max(160, "Keep the title under 160 characters."),
  body: z.string().trim().min(1, "Write the announcement.").max(10_000, "The announcement is too long."),
  pinned: z.boolean(),
  audience: z.enum(AUDIENCES, "Choose everyone or specific roles."),
  roleIds: z.array(z.number().int().positive()).max(50, "Pick at most 50 roles."),
};
const createSchema = z
  .object({ ...fields, pinned: fields.pinned.default(false), audience: fields.audience.default("all"), roleIds: fields.roleIds.default([]) })
  .refine(input => input.audience === "all" || input.roleIds.length > 0, { path: ["roleIds"], message: ROLES_REQUIRED });
const updateSchema = z.object(fields).partial();

const canPost = req => can(req, "announcements.post") || can(req, "announcements.manage");
const canManage = req => can(req, "announcements.manage");
const canEdit = (req, row) => (row.author_id === req.user.id && canPost(req)) || canManage(req);

const fieldError = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { [field]: message } });

/** Limits a query on `announcements as a` to what the signed-in person may see. */
function visibleTo(query, db, req) {
  if (canManage(req)) return query;
  return query.where(function audienceFilter() {
    this.where("a.audience", "all")
      .orWhere("a.author_id", req.user.id)
      .orWhereExists(
        db("announcement_roles as ar")
          .join("user_roles as ur", "ur.role_id", "ar.role_id")
          .whereRaw("ar.announcement_id = a.id")
          .where("ur.user_id", req.user.id)
          .select(db.raw("1"))
      );
  });
}

function baseQuery(db, req) {
  const query = db("announcements as a")
    .leftJoin("users as u", "u.id", "a.author_id")
    .leftJoin("announcement_reads as r", function joinMyRead() {
      this.on("r.announcement_id", "a.id").andOnVal("r.user_id", req.user.id);
    })
    .where("a.tenant_id", req.user.tenant_id)
    .select("a.*", "u.name as author_name", "u.job_title as author_job_title", "r.read_at");
  return visibleTo(query, db, req);
}

/** Roles, audience size (excluding the author), and audience read counts for a page of announcements. */
async function loadDetails(db, req, rows) {
  const ids = rows.map(row => row.id);
  const empty = { roles: new Map(), sizes: new Map(), reads: new Map(), everyone: 0, activeIds: new Set() };
  if (!ids.length) return empty;
  const roleTargeted = rows.filter(row => row.audience === "roles").map(row => row.id);
  const [roleRows, sizeRows, readRows, active] = await Promise.all([
    db("announcement_roles as ar").join("roles as ro", "ro.id", "ar.role_id").whereIn("ar.announcement_id", ids).orderBy("ro.name").select("ar.announcement_id", "ro.id", "ro.name"),
    roleTargeted.length
      ? db("announcement_roles as ar")
          .join("announcements as a", "a.id", "ar.announcement_id")
          .join("user_roles as ur", "ur.role_id", "ar.role_id")
          .join("users as u", "u.id", "ur.user_id")
          .whereIn("ar.announcement_id", roleTargeted)
          .where({ "u.is_active": true, "u.tenant_id": req.user.tenant_id })
          .whereRaw("(a.author_id is null or u.id <> a.author_id)")
          .groupBy("ar.announcement_id")
          .select("ar.announcement_id")
          .countDistinct({ count: "u.id" })
      : [],
    db("announcement_reads as r")
      .join("announcements as a", "a.id", "r.announcement_id")
      .join("users as u", "u.id", "r.user_id")
      .whereIn("r.announcement_id", ids)
      .where({ "u.is_active": true, "u.tenant_id": req.user.tenant_id })
      .whereRaw("(a.author_id is null or r.user_id <> a.author_id)")
      .where(function inAudience() {
        this.where("a.audience", "all").orWhereExists(
          db("announcement_roles as ar2").join("user_roles as ur2", "ur2.role_id", "ar2.role_id").whereRaw("ar2.announcement_id = a.id").whereRaw("ur2.user_id = r.user_id").select(db.raw("1"))
        );
      })
      .groupBy("r.announcement_id")
      .select("r.announcement_id")
      .count({ count: "*" }),
    db("users").where({ tenant_id: req.user.tenant_id, is_active: true }).select("id"),
  ]);
  const roles = new Map();
  for (const row of roleRows) {
    if (!roles.has(row.announcement_id)) roles.set(row.announcement_id, []);
    roles.get(row.announcement_id).push({ id: row.id, name: row.name });
  }
  return {
    roles,
    sizes: new Map(sizeRows.map(row => [row.announcement_id, Number(row.count)])),
    reads: new Map(readRows.map(row => [row.announcement_id, Number(row.count)])),
    everyone: active.length,
    activeIds: new Set(active.map(row => row.id)),
  };
}

const toAnnouncement = (row, req, details) => {
  const showReceipts = row.author_id === req.user.id || canManage(req);
  const audienceSize = row.audience === "roles" ? (details.sizes.get(row.id) ?? 0) : Math.max(details.everyone - (details.activeIds.has(row.author_id) ? 1 : 0), 0);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    pinned: Boolean(row.pinned),
    author: row.author_id ? { id: row.author_id, name: row.author_name, jobTitle: row.author_job_title ?? null } : null,
    audience: row.audience === "roles" ? "roles" : "all",
    roles: details.roles.get(row.id) ?? [],
    isRead: Boolean(row.read_at) || row.author_id === req.user.id,
    // Read receipts and the audience size (not counting the author) are shown to the author and managers.
    readCount: showReceipts ? (details.reads.get(row.id) ?? 0) : null,
    audienceSize: showReceipts ? audienceSize : null,
    canEdit: canEdit(req, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

async function findAnnouncement(db, req, id) {
  const row = await baseQuery(db, req).where("a.id", id).first();
  if (!row) throw new HttpError(404, "Announcement not found.");
  return row;
}

async function present(db, req, id) {
  const row = await findAnnouncement(db, req, id);
  return toAnnouncement(row, req, await loadDetails(db, req, [row]));
}

/** Role ids must be this tenant's; returns them de-duplicated. */
async function checkRoles(db, tenantId, roleIds) {
  const unique = [...new Set(roleIds)];
  if (!unique.length) return unique;
  const found = await db("roles").where("tenant_id", tenantId).whereIn("id", unique).select("id");
  if (found.length !== unique.length) throw fieldError("roleIds", "Pick roles from this workspace.");
  return unique;
}

/** Active people an announcement is addressed to. */
async function audienceUserIds(db, tenantId, audience, roleIds) {
  if (audience === "roles") {
    if (!roleIds.length) return [];
    const rows = await db("user_roles as ur").join("users as u", "u.id", "ur.user_id").whereIn("ur.role_id", roleIds).where({ "u.tenant_id": tenantId, "u.is_active": true }).distinct("u.id");
    return rows.map(row => row.id);
  }
  return (await db("users").where({ tenant_id: tenantId, is_active: true }).select("id")).map(row => row.id);
}

const roleIdsOf = async (db, announcementId) => (await db("announcement_roles").where({ announcement_id: announcementId }).select("role_id")).map(row => row.role_id);

/** Live hint to the audience (and the author), plus everyone who manages announcements. */
const announceChange = (req, announcementId, userIds) =>
  publish({ users: [...userIds, req.user.id], tenantId: req.user.tenant_id, permission: "announcements.manage" }, "announcement.changed", { announcementId, actorId: req.user.id });

router.get("/", async (req, res) => {
  const db = getDb();
  const rows = await baseQuery(db, req).orderBy("a.pinned", "desc").orderBy("a.created_at", "desc").orderBy("a.id", "desc").limit(100);
  const details = await loadDetails(db, req, rows);
  res.json({
    canPost: canPost(req),
    audience: rows.length ? details.everyone : (await audienceUserIds(db, req.user.tenant_id, "all", [])).length, // active people in the workspace
    items: rows.map(row => toAnnouncement(row, req, details)),
    unread: rows.filter(row => !row.read_at && row.author_id !== req.user.id).length,
  });
});

/** Audience picker for people who post: the workspace's roles and how many active people hold each. */
router.get("/roles", async (req, res) => {
  if (!canPost(req)) throw new HttpError(403, "You don't have permission to post announcements.", { code: "FORBIDDEN" });
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const [roles, counts] = await Promise.all([
    db("roles").where("tenant_id", tenantId).orderBy("is_system", "desc").orderBy("id").select("id", "key", "name"),
    db("user_roles as ur").join("users as u", "u.id", "ur.user_id").where({ "u.tenant_id": tenantId, "u.is_active": true }).groupBy("ur.role_id").select("ur.role_id").count({ count: "*" }),
  ]);
  const countBy = new Map(counts.map(row => [row.role_id, Number(row.count)]));
  res.json(roles.map(role => ({ id: role.id, key: role.key, name: role.name, members: countBy.get(role.id) ?? 0 })));
});

router.get("/:id", async (req, res) => {
  res.json(await present(getDb(), req, parseId(req.params.id)));
});

router.post("/", async (req, res) => {
  if (!canPost(req)) throw new HttpError(403, "You don't have permission to post announcements.", { code: "FORBIDDEN" });
  const input = validate(createSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const roleIds = input.audience === "roles" ? await checkRoles(db, tenantId, input.roleIds) : [];
  const now = nowIso();
  let recipients = [];
  const id = await db.transaction(async trx => {
    const announcementId = await insertAndGetId(trx, "announcements", {
      tenant_id: tenantId,
      author_id: req.user.id,
      title: input.title,
      body: input.body,
      pinned: input.pinned,
      audience: input.audience,
      created_at: now,
      updated_at: now,
    });
    if (roleIds.length) await trx("announcement_roles").insert(roleIds.map(roleId => ({ announcement_id: announcementId, role_id: roleId })));
    recipients = (await audienceUserIds(trx, tenantId, input.audience, roleIds)).slice(0, 2000);
    await notifyUsers(trx, recipients, { title: `Announcement: ${input.title}`, body: `${req.user.name} posted an announcement`, actorId: req.user.id });
    return announcementId;
  });
  announceChange(req, id, recipients);
  res.status(201).json(await present(db, req, id));
});

router.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findAnnouncement(db, req, id);
  if (!canEdit(req, current)) throw new HttpError(403, "Only the author or an announcement manager can edit this.", { code: "FORBIDDEN" });
  const body = req.body ?? {};
  const input = validate(updateSchema, body);
  const changes = {};
  for (const key of ["title", "body", "pinned"]) if (key in body) changes[key] = input[key];

  const previousRoleIds = current.audience === "roles" ? await roleIdsOf(db, id) : [];
  const previousAudience = await audienceUserIds(db, tenantId, current.audience, previousRoleIds);
  let nextAudience = null;
  let nextRoleIds = null;
  if ("audience" in body || "roleIds" in body) {
    nextAudience = input.audience ?? current.audience;
    nextRoleIds = nextAudience === "roles" ? await checkRoles(db, tenantId, input.roleIds ?? previousRoleIds) : [];
    if (nextAudience === "roles" && !nextRoleIds.length) throw fieldError("roleIds", ROLES_REQUIRED);
    changes.audience = nextAudience;
  }

  if (!Object.keys(changes).length) return res.json(await present(db, req, id));
  let reached = previousAudience;
  await db.transaction(async trx => {
    await trx("announcements").where({ id }).update({ ...changes, updated_at: nowIso() });
    if (nextRoleIds) {
      await trx("announcement_roles").where({ announcement_id: id }).delete();
      if (nextRoleIds.length) await trx("announcement_roles").insert(nextRoleIds.map(roleId => ({ announcement_id: id, role_id: roleId })));
      const after = await audienceUserIds(trx, tenantId, nextAudience, nextRoleIds);
      // People who can see it for the first time are told about it; people who lost it refresh too.
      const before = new Set(previousAudience);
      const added = after.filter(userId => !before.has(userId) && userId !== current.author_id);
      await notifyUsers(trx, added.slice(0, 2000), { title: `Announcement: ${changes.title ?? current.title}`, body: `${req.user.name} shared an announcement with you`, actorId: req.user.id });
      reached = [...new Set([...previousAudience, ...after])];
    }
  });
  announceChange(req, id, [...reached, current.author_id].filter(Boolean));
  res.json(await present(db, req, id));
});

router.delete("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const current = await findAnnouncement(db, req, id);
  if (!canEdit(req, current)) throw new HttpError(403, "Only the author or an announcement manager can delete this.", { code: "FORBIDDEN" });
  const audience = await audienceUserIds(db, req.user.tenant_id, current.audience, current.audience === "roles" ? await roleIdsOf(db, id) : []);
  await db("announcements").where({ id }).delete();
  announceChange(req, id, [...audience, current.author_id].filter(Boolean));
  res.status(204).end();
});

router.post("/read", async (req, res) => {
  const { ids } = validate(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }), req.body);
  const db = getDb();
  const visible = await visibleTo(db("announcements as a").where("a.tenant_id", req.user.tenant_id).whereIn("a.id", ids), db, req).select("a.id");
  const already = new Set((await db("announcement_reads").where("user_id", req.user.id).whereIn("announcement_id", visible.map(row => row.id)).select("announcement_id")).map(row => row.announcement_id));
  const now = nowIso();
  const fresh = visible.filter(row => !already.has(row.id));
  if (fresh.length) await db("announcement_reads").insert(fresh.map(row => ({ announcement_id: row.id, user_id: req.user.id, read_at: now })));
  res.status(204).end();
});

export default router;
