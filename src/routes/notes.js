// Notes: collaborative sticky notes. Private to the owner by default; shared with chosen people (view or edit)
// or with the whole workspace. "Manage all notes" (notes.manage) sees and controls every note in the tenant.
// Saves use optimistic concurrency: PATCH sends the version it started from and gets 409 NOTE_CONFLICT if stale.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can } from "../middleware/auth.js";
import { notifyUsers } from "../services/notify.js";
import { usersWithPermission } from "../services/permissions.js";
import { publish } from "../services/realtime.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

export const NOTE_COLORS = Object.freeze(["yellow", "pink", "blue", "green", "purple", "orange", "gray"]);
const TITLE_MAX = 160;
const BODY_MAX = 20_000;
const EMPTY_MESSAGE = "Write a title or some text.";

const title = z.string().max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`).transform(value => value.trim());
const body = z.string().max(BODY_MAX, `Keep the note under ${BODY_MAX.toLocaleString("en")} characters.`);
const color = z.enum(NOTE_COLORS, { error: "Pick one of the note colours." });
export const NOTE_FONTS = Object.freeze(["caveat", "patrick", "kalam", "marker", "sans"]);
export const NOTE_TEXT_SIZES = Object.freeze(["sm", "md", "lg", "xl"]);
export const BOARD_BACKGROUNDS = Object.freeze(["cork", "whiteboard", "chalkboard", "grid", "dots", "plain"]);
const font = z.enum(NOTE_FONTS, { error: "Pick one of the note fonts." });
const textSize = z.enum(NOTE_TEXT_SIZES, { error: "Pick a text size." });
const num = z.number({ error: "Send a number." }).finite();
const createSchema = z.object({
  title: title.default(""),
  body: body.default(""),
  color: color.default("yellow"),
  font: font.default("caveat"),
  textSize: textSize.default("md"),
  pinned: z.boolean().default(false),
  // Where to drop it on the creator's board (defaults to a cascade from the top-left).
  x: num.optional(),
  y: num.optional(),
});
const updateSchema = z.object({
  title: title.optional(),
  body: body.optional(),
  color: color.optional(),
  font: font.optional(),
  textSize: textSize.optional(),
  pinned: z.boolean().optional(),
  version: z.number({ error: "Send the version you edited." }).int().positive(),
});
const access = z.enum(["view", "edit"], { error: "Choose view or edit." });
const sharingSchema = z.object({
  shareAll: z.enum(["none", "view", "edit"], { error: "Choose off, view, or edit." }),
  users: z.array(z.object({ userId: z.number().int().positive(), access }), { error: "Send a list of people." }).max(200, "Share with at most 200 people."),
});
const transferSchema = z.object({ userId: z.number({ error: "Choose the new owner." }).int().positive() });
const listSchema = z.object({
  scope: z.enum(["all", "mine", "shared", "archived"]).default("all"),
  search: z.string().trim().max(100).default(""),
  color: z.union([color, z.literal("")]).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
});

// ---- Personal board layout: positions never bump the note version and are never broadcast ----
const POS_LIMITS = { x: [0, 20_000], y: [0, 20_000], width: [160, 800], height: [140, 800], rotation: [-8, 8] };
const DEFAULT_SIZE = { width: 240, height: 220 };
const positionFields = { x: num, y: num, width: num, height: num, z: num.optional(), rotation: num.optional() };
const positionSchema = z.object(positionFields);
const bulkSchema = z.object({
  positions: z
    .array(z.object({ noteId: z.number({ error: "Send the note id." }).int().positive(), ...positionFields }), { error: "Send a list of positions." })
    .min(1, "Send at least one position.")
    .max(200, "Send at most 200 positions at once."),
});
const boardSchema = z.object({
  background: z.enum(BOARD_BACKGROUNDS, { error: "Pick one of the board backgrounds." }).optional(),
  snapToGrid: z.boolean({ error: "Send true or false." }).optional(),
  zoom: num.optional(),
});
const BOARD_DEFAULTS = { background: "cork", snapToGrid: false, zoom: 1 };

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));
/** Clamps a sent position into the board's limits (integers, rotation to 0.1°). */
function clampPosition(input) {
  const out = {};
  for (const key of ["x", "y", "width", "height"]) out[key] = Math.round(clamp(input[key], POS_LIMITS[key]));
  if (input.z !== undefined) out.z = Math.round(clamp(input.z, [0, 1_000_000]));
  if (input.rotation !== undefined) out.rotation = Math.round(clamp(input.rotation, POS_LIMITS.rotation) * 10) / 10;
  return out;
}
const randomTilt = () => Math.round((Math.random() * 6 - 3) * 2) / 2; // −3°…3° in half degrees
const toPosition = row => (row ? { x: row.x, y: row.y, width: row.width, height: row.height, z: row.z, rotation: Number(row.rotation) } : null);
/** The viewer's position from baseQuery's note_positions join. */
const joinedPosition = row =>
  row.pos_x == null ? null : toPosition({ x: row.pos_x, y: row.pos_y, width: row.pos_width, height: row.pos_height, z: row.pos_z, rotation: row.pos_rotation });

async function maxZ(db, userId) {
  const row = await db("note_positions").where("user_id", userId).max({ top: "z" }).first();
  return Number(row?.top ?? 0) || 0;
}
/** Insert-or-update one person's position for one note; missing z/rotation keep the stored value (or get a default). */
async function savePosition(db, userId, noteId, position) {
  const now = nowIso();
  const existing = await db("note_positions").where({ note_id: noteId, user_id: userId }).first();
  if (existing) {
    await db("note_positions").where({ note_id: noteId, user_id: userId }).update({ ...position, updated_at: now });
  } else {
    await db("note_positions").insert({ note_id: noteId, user_id: userId, z: position.z ?? (await maxZ(db, userId)) + 1, rotation: position.rotation ?? randomTilt(), ...position, updated_at: now });
  }
  return toPosition(await db("note_positions").where({ note_id: noteId, user_id: userId }).first());
}
/** Cascade new notes down and right from the top-left, wrapping every 10. */
async function defaultSpot(db, userId) {
  const [{ count }] = await db("note_positions").where("user_id", userId).count({ count: "*" });
  const n = Number(count);
  return { x: 40 + (n % 10) * 32 + Math.floor(n / 10) * 280, y: 40 + (n % 10) * 32 };
}

const isEmpty = (t, b) => !String(t ?? "").trim() && !String(b ?? "").trim();
const canManage = req => can(req, "notes.manage");
const displayTitle = row => row.title?.trim() || (row.body ?? "").trim().split("\n")[0].slice(0, 60) || "Untitled note";

// ---- Access ----
/** "owner" | "manage" | "edit" | "view" | null for one note row (joined with the viewer's own share as my_access). */
function accessOf(row, req) {
  if (row.owner_id === req.user.id) return "owner";
  if (canManage(req)) return "manage";
  if (row.archived_at) return null; // archived notes leave everyone else's board
  const levels = [row.my_access, row.share_all].filter(level => level === "view" || level === "edit");
  if (levels.includes("edit")) return "edit";
  return levels.length ? "view" : null;
}
const canEditAccess = level => level === "owner" || level === "manage" || level === "edit";
const canControl = level => level === "owner" || level === "manage";

function baseQuery(db, req) {
  return db("notes as n")
    .join("users as o", "o.id", "n.owner_id")
    .leftJoin("users as e", "e.id", "n.last_edited_by")
    .leftJoin("note_shares as ms", function joinMyShare() {
      this.on("ms.note_id", "n.id").andOnVal("ms.user_id", req.user.id);
    })
    .leftJoin("note_positions as np", function joinMyPosition() {
      this.on("np.note_id", "n.id").andOnVal("np.user_id", req.user.id);
    })
    .where("n.tenant_id", req.user.tenant_id)
    .select("n.*", "o.name as owner_name", "e.name as editor_name", "ms.access as my_access", "np.x as pos_x", "np.y as pos_y", "np.width as pos_width", "np.height as pos_height", "np.z as pos_z", "np.rotation as pos_rotation");
}

/** Limits a query to notes the viewer may open (same rules as accessOf, in SQL). */
function whereVisible(query, req) {
  if (canManage(req)) return query;
  return query.where(q =>
    q.where("n.owner_id", req.user.id).orWhere(shared => shared.whereNull("n.archived_at").andWhere(s => s.whereNot("n.share_all", "none").orWhereNotNull("ms.user_id")))
  );
}

async function sharesFor(db, noteIds) {
  if (!noteIds.length) return new Map();
  const rows = await db("note_shares as s").join("users as u", "u.id", "s.user_id").whereIn("s.note_id", noteIds).orderBy("u.name").select("s.note_id", "s.user_id", "s.access", "u.name");
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.note_id)) map.set(row.note_id, []);
    map.get(row.note_id).push({ user: { id: row.user_id, name: row.name }, access: row.access });
  }
  return map;
}

function toNote(row, req, shares = []) {
  const level = accessOf(row, req);
  return {
    id: row.id,
    title: row.title ?? "",
    body: row.body ?? "",
    color: row.color,
    font: row.font ?? "caveat",
    textSize: row.text_size ?? "md",
    pinned: Boolean(row.pinned),
    owner: { id: row.owner_id, name: row.owner_name },
    access: level,
    shareAll: row.share_all,
    // Who it's shared with is the owner's (and managers') business; everyone else sees only how many.
    shares: canControl(level) ? shares : null,
    shareCount: shares.length,
    version: row.version,
    lastEditedBy: row.last_edited_by ? { id: row.last_edited_by, name: row.editor_name } : null,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? null,
    // The viewer's own spot on their board (null until they or the server place it).
    position: joinedPosition(row),
  };
}

/** The note with the viewer's access, or 404 (never reveals that a note exists). */
async function loadNote(db, req, id) {
  const row = await baseQuery(db, req).where("n.id", id).first();
  const level = row ? accessOf(row, req) : null;
  if (!level) throw new HttpError(404, "Note not found.", { code: "NOT_FOUND" });
  return { row, level };
}
async function noteResponse(db, req, id) {
  const { row } = await loadNote(db, req, id);
  return toNote(row, req, (await sharesFor(db, [id])).get(id) ?? []);
}

const requireEdit = level => {
  if (!canEditAccess(level)) throw new HttpError(403, "You can view this note but not change it.", { code: "FORBIDDEN" });
};
const requireControl = level => {
  if (!canControl(level)) throw new HttpError(403, "Only the note's owner can do that.", { code: "FORBIDDEN" });
};

// ---- Live updates ----
/** Everyone who can see the note right now: owner, shared people, managers, and the tenant if shared with everyone. */
async function audienceOf(db, req, noteId) {
  const note = await db("notes").where({ id: noteId, tenant_id: req.user.tenant_id }).first("owner_id", "share_all", "archived_at");
  if (!note) return null;
  const shared = await db("note_shares").where("note_id", noteId).pluck("user_id");
  const everyone = note.share_all !== "none" && !note.archived_at;
  return {
    users: [note.owner_id, ...(note.archived_at ? [] : shared)],
    tenantId: req.user.tenant_id,
    permission: everyone ? ["notes.use", "notes.manage"] : "notes.manage",
  };
}
const changed = (to, req, note) => to && publish(to, "note.changed", { noteId: note.id, version: note.version, actorId: req.user.id });
const removed = (to, noteId) => to && publish(to, "note.removed", { noteId });

// ---- Routes ----
router.get("/shareable-people", async (req, res) => {
  const db = getDb();
  const ids = await usersWithPermission(db, req.user.tenant_id, "notes.use");
  const people = ids.length ? await db("users").whereIn("id", ids).where({ tenant_id: req.user.tenant_id, is_active: true }).orderBy("name").select("id", "name", "job_title") : [];
  res.json(people.map(person => ({ id: person.id, name: person.name, jobTitle: person.job_title ?? null })));
});

// ---- My board: settings and layout (personal; no version bump, no realtime) ----
async function boardOf(db, userId) {
  const row = await db("note_boards").where("user_id", userId).first();
  return row ? { background: row.background, snapToGrid: Boolean(row.snap_to_grid), zoom: Number(row.zoom) } : { ...BOARD_DEFAULTS };
}
router.get("/board", async (req, res) => {
  res.json(await boardOf(getDb(), req.user.id));
});
router.put("/board", async (req, res) => {
  const input = validate(boardSchema, req.body ?? {});
  const db = getDb();
  const next = { ...(await boardOf(db, req.user.id)) };
  if (input.background !== undefined) next.background = input.background;
  if (input.snapToGrid !== undefined) next.snapToGrid = input.snapToGrid;
  if (input.zoom !== undefined) next.zoom = Math.round(clamp(input.zoom, [0.5, 2]) * 100) / 100;
  const row = { background: next.background, snap_to_grid: next.snapToGrid, zoom: next.zoom, updated_at: nowIso() };
  const exists = await db("note_boards").where("user_id", req.user.id).first("user_id");
  if (exists) await db("note_boards").where("user_id", req.user.id).update(row);
  else await db("note_boards").insert({ user_id: req.user.id, ...row });
  res.json(next);
});

router.post("/positions/bulk", async (req, res) => {
  const { positions } = validate(bulkSchema, req.body ?? {});
  const ids = [...new Set(positions.map(entry => entry.noteId))];
  if (ids.length !== positions.length) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { positions: "Each note can appear only once." } });
  const db = getDb();
  const rows = await whereVisible(baseQuery(db, req), req).whereIn("n.id", ids);
  const visible = new Set(rows.filter(row => accessOf(row, req)).map(row => row.id));
  if (ids.some(noteId => !visible.has(noteId))) throw new HttpError(404, "Note not found.", { code: "NOT_FOUND" });
  const saved = [];
  await db.transaction(async trx => {
    for (const entry of positions) saved.push({ noteId: entry.noteId, position: await savePosition(trx, req.user.id, entry.noteId, clampPosition(entry)) });
  });
  res.json({ items: saved });
});

router.get("/", async (req, res) => {
  const input = validate(listSchema, req.query ?? {});
  const db = getDb();
  const query = whereVisible(baseQuery(db, req), req);
  if (input.scope === "archived") query.whereNotNull("n.archived_at");
  else query.whereNull("n.archived_at");
  if (input.scope === "mine") query.where("n.owner_id", req.user.id);
  if (input.scope === "shared") query.whereNot("n.owner_id", req.user.id).andWhere(q => q.whereNot("n.share_all", "none").orWhereNotNull("ms.user_id"));
  if (input.color) query.where("n.color", input.color);
  if (input.search) {
    const like = `%${input.search.toLowerCase()}%`;
    query.andWhere(q => q.whereRaw("lower(n.title) like ?", [like]).orWhereRaw("lower(n.body) like ?", [like]));
  }
  const [{ total }] = await query.clone().clearSelect().count({ total: "n.id" });
  const rows = await query
    .orderBy("n.pinned", "desc")
    .orderBy("n.updated_at", "desc")
    .orderBy("n.id", "desc")
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
  const shares = await sharesFor(db, rows.map(row => row.id));
  const count = Number(total);
  res.json({ items: rows.map(row => toNote(row, req, shares.get(row.id) ?? [])), page: input.page, pageSize: input.pageSize, total: count, totalPages: Math.max(1, Math.ceil(count / input.pageSize)) });
});

router.post("/", async (req, res) => {
  if (!can(req, "notes.use") && !canManage(req)) throw new HttpError(403, "You don't have permission to write notes.", { code: "FORBIDDEN" });
  const input = validate(createSchema, req.body ?? {});
  if (isEmpty(input.title, input.body)) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { body: EMPTY_MESSAGE } });
  const db = getDb();
  const now = nowIso();
  const id = await insertAndGetId(db, "notes", {
    tenant_id: req.user.tenant_id,
    owner_id: req.user.id,
    title: input.title,
    body: input.body,
    color: input.color,
    font: input.font,
    text_size: input.textSize,
    pinned: input.pinned,
    share_all: "none",
    version: 1,
    last_edited_by: req.user.id,
    created_at: now,
    updated_at: now,
  });
  const spot = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : await defaultSpot(db, req.user.id);
  await savePosition(db, req.user.id, id, clampPosition({ ...spot, ...DEFAULT_SIZE }));
  const note = await noteResponse(db, req, id);
  changed(await audienceOf(db, req, id), req, note);
  res.status(201).json(note);
});

router.get("/:id", async (req, res) => {
  res.json(await noteResponse(getDb(), req, parseId(req.params.id)));
});

router.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row, level } = await loadNote(db, req, id);
  requireEdit(level);
  if (row.archived_at) throw new HttpError(409, "Restore this note to edit it.", { code: "NOTE_ARCHIVED" });
  const input = validate(updateSchema, req.body ?? {});
  const changes = {};
  for (const key of ["title", "body", "color", "font", "pinned"]) if (input[key] !== undefined) changes[key] = input[key];
  if (input.textSize !== undefined) changes.text_size = input.textSize;
  if (isEmpty(changes.title ?? row.title, changes.body ?? row.body)) {
    throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { body: EMPTY_MESSAGE } });
  }
  // Only the save that started from the current version wins; the version check and the bump are one statement.
  const updated = await db("notes")
    .where({ id, tenant_id: req.user.tenant_id, version: input.version })
    .update({ ...changes, version: input.version + 1, last_edited_by: req.user.id, updated_at: nowIso() });
  if (!updated) {
    const current = await noteResponse(db, req, id);
    return res.status(409).json({ message: "Someone else changed this note.", code: "NOTE_CONFLICT", note: current });
  }
  const note = await noteResponse(db, req, id);
  changed(await audienceOf(db, req, id), req, note);
  res.json(note);
});

router.put("/:id/sharing", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row, level } = await loadNote(db, req, id);
  requireControl(level);
  const input = validate(sharingSchema, req.body ?? {});
  const wanted = new Map();
  for (const entry of input.users) {
    if (wanted.has(entry.userId)) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { users: "Each person can appear only once." } });
    wanted.set(entry.userId, entry.access);
  }
  if (wanted.has(row.owner_id)) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { users: "The owner already has full access." } });
  if (wanted.size) {
    const allowed = new Set(await usersWithPermission(db, req.user.tenant_id, "notes.use"));
    const bad = [...wanted.keys()].filter(userId => !allowed.has(userId));
    if (bad.length) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { users: "Some of these people can't use notes in this workspace." } });
  }

  const before = await db("note_shares").where("note_id", id).select("user_id", "access");
  const beforeIds = new Set(before.map(share => share.user_id));
  const added = [...wanted.keys()].filter(userId => !beforeIds.has(userId));
  const dropped = before.map(share => share.user_id).filter(userId => !wanted.has(userId));
  const now = nowIso();
  await db.transaction(async trx => {
    await trx("note_shares").where("note_id", id).delete();
    if (wanted.size) await trx("note_shares").insert([...wanted].map(([userId, accessLevel]) => ({ note_id: id, user_id: userId, access: accessLevel, created_at: now })));
    // Sharing isn't a content edit: the version stays, so nobody's open editor gets a false conflict.
    await trx("notes").where({ id }).update({ share_all: input.shareAll, updated_at: now });
    for (const level of ["view", "edit"]) {
      const people = added.filter(userId => wanted.get(userId) === level);
      await notifyUsers(trx, people, { title: `${row.owner_name} shared a note with you: ${displayTitle(row)}`, body: level === "edit" ? "You can view and edit it in Notes." : "You can view it in Notes.", actorId: req.user.id });
    }
  });
  await recordTenantAudit(db, req, "note.share", displayTitle(row), { noteId: id, shareAll: input.shareAll, people: wanted.size, added: added.length, removed: dropped.length });

  // People who lost access drop it from their board; workspace-wide sharing switched off reaches the whole tenant.
  if (dropped.length) removed({ users: dropped }, id);
  if (row.share_all !== "none" && input.shareAll === "none") removed({ tenantId: req.user.tenant_id, permission: ["notes.use", "notes.manage"] }, id);
  const note = await noteResponse(db, req, id);
  changed(await audienceOf(db, req, id), req, note);
  res.json(note);
});

async function setArchived(req, res, archived) {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row, level } = await loadNote(db, req, id);
  requireControl(level);
  if (Boolean(row.archived_at) !== archived) {
    const before = await audienceOf(db, req, id);
    await db("notes").where({ id }).update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() });
    const note = await noteResponse(db, req, id);
    if (archived) removed(before, id);
    changed(await audienceOf(db, req, id), req, note);
    return res.json(note);
  }
  res.json(await noteResponse(db, req, id));
}
router.post("/:id/archive", (req, res) => setArchived(req, res, true));
router.post("/:id/restore", (req, res) => setArchived(req, res, false));

router.delete("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row, level } = await loadNote(db, req, id);
  requireControl(level);
  const audience = await audienceOf(db, req, id);
  await db.transaction(async trx => {
    await trx("note_shares").where("note_id", id).delete();
    await trx("note_positions").where("note_id", id).delete();
    await trx("notes").where({ id }).delete();
  });
  await recordTenantAudit(db, req, "note.delete", displayTitle(row), { noteId: id, owner: row.owner_name });
  removed(audience, id);
  res.status(204).end();
});

router.post("/:id/transfer", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row, level } = await loadNote(db, req, id);
  requireControl(level);
  const { userId } = validate(transferSchema, req.body ?? {});
  if (userId === row.owner_id) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { userId: "They already own this note." } });
  const allowed = await usersWithPermission(db, req.user.tenant_id, "notes.use");
  if (!allowed.includes(userId)) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { userId: "Choose someone in this workspace who can use notes." } });
  const target = await db("users").where({ id: userId, tenant_id: req.user.tenant_id }).first("id", "name");
  const now = nowIso();
  await db.transaction(async trx => {
    // The new owner no longer needs a share; the previous owner keeps edit access so the note doesn't vanish on them.
    await trx("note_shares").where({ note_id: id, user_id: userId }).delete();
    await trx("note_shares").where({ note_id: id, user_id: row.owner_id }).delete();
    await trx("note_shares").insert({ note_id: id, user_id: row.owner_id, access: "edit", created_at: now });
    await trx("notes").where({ id }).update({ owner_id: userId, updated_at: now });
    await notifyUsers(trx, [userId], { title: `${req.user.name} gave you a note: ${displayTitle(row)}`, body: `You now own this note (previously ${row.owner_name}'s).`, actorId: req.user.id });
  });
  await recordTenantAudit(db, req, "note.transfer", displayTitle(row), { noteId: id, from: row.owner_name, to: target.name });
  const note = await noteResponse(db, req, id);
  changed(await audienceOf(db, req, id), req, note);
  res.json(note);
});

router.put("/:id/position", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await loadNote(db, req, id); // any access (view or more); 404 otherwise
  const input = validate(positionSchema, req.body ?? {});
  res.json(await savePosition(db, req.user.id, id, clampPosition(input)));
});

router.post("/:id/bring-to-front", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row } = await loadNote(db, req, id);
  const current = joinedPosition(row);
  const top = await maxZ(db, req.user.id);
  if (current && current.z === top && top > 0) {
    const others = await db("note_positions").where({ user_id: req.user.id, z: top }).whereNot("note_id", id).first("note_id");
    if (!others) return res.json(current); // already alone on top
  }
  const base = current ?? { ...(await defaultSpot(db, req.user.id)), ...DEFAULT_SIZE };
  res.json(await savePosition(db, req.user.id, id, { ...clampPosition(base), z: top + 1 }));
});

/** "Asha is editing…": a hint for everyone who can open the note. The client sends it at most every few seconds. */
router.post("/:id/presence", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { level } = await loadNote(db, req, id);
  requireEdit(level);
  const audience = await audienceOf(db, req, id);
  if (audience) publish(audience, "note.editing", { noteId: id, user: { id: req.user.id, name: req.user.name } });
  res.status(204).end();
});

export default router;
