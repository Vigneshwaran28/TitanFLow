import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const STATUSES = ["todo", "in_progress", "done"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const REPEATS = ["none", "daily", "weekly", "monthly"];

const isoDate = z.iso.datetime({ offset: true, error: "Enter a valid date and time." });
const nullableIso = isoDate.nullable().transform(value => (value ? new Date(value).toISOString() : null));

const taskSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required.").max(200, "Keep the title under 200 characters."),
    notes: z.string().max(5000, "Notes are too long.").nullable().default(null),
    status: z.enum(STATUSES).default("todo"),
    priority: z.enum(PRIORITIES).default("medium"),
    listId: z.number().int().positive().nullable().default(null),
    dueAt: nullableIso.default(null),
    remindAt: nullableIso.default(null),
    repeat: z.enum(REPEATS).default("none"),
  })
  .refine(task => task.repeat === "none" || task.dueAt, { path: ["dueAt"], message: "Repeating tasks need a due date." });

const querySchema = z.object({
  status: z.enum([...STATUSES, "open"]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  listId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  hasDue: z.enum(["true", "false"]).optional(),
  sort: z.enum(["due", "priority", "created", "title"]).default("due"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
});

export function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    listId: row.list_id,
    list: row.list_name ? { id: row.list_id, name: row.list_name, color: row.list_color } : null,
    dueAt: row.due_at,
    remindAt: row.remind_at,
    reminderSent: Boolean(row.reminder_sent),
    repeat: row.repeat,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input) {
  const row = {};
  if ("title" in input) row.title = input.title;
  if ("notes" in input) row.notes = input.notes || null;
  if ("status" in input) row.status = input.status;
  if ("priority" in input) row.priority = input.priority;
  if ("listId" in input) row.list_id = input.listId;
  if ("dueAt" in input) row.due_at = input.dueAt;
  if ("remindAt" in input) {
    row.remind_at = input.remindAt;
    row.reminder_sent = false; // a changed reminder should fire again
  }
  if ("repeat" in input) row.repeat = input.repeat;
  return row;
}

function baseQuery(db, userId) {
  return db("tasks as t")
    .leftJoin("lists as l", "l.id", "t.list_id")
    .where("t.user_id", userId)
    .select("t.*", "l.name as list_name", "l.color as list_color");
}

async function findOwnedTask(db, userId, id) {
  const row = await baseQuery(db, userId).andWhere("t.id", id).first();
  if (!row) throw new HttpError(404, "Task not found.");
  return row;
}

async function assertListOwned(db, userId, listId) {
  if (listId == null) return;
  const list = await db("lists").where({ id: listId, user_id: userId }).first();
  if (!list) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { listId: "Choose one of your lists." } });
}

/** Next occurrence for a repeating task, keeping the reminder offset relative to the due date. */
function nextOccurrence(row) {
  const shift = iso => {
    if (!iso) return null;
    const date = new Date(iso);
    if (row.repeat === "daily") date.setUTCDate(date.getUTCDate() + 1);
    if (row.repeat === "weekly") date.setUTCDate(date.getUTCDate() + 7);
    if (row.repeat === "monthly") date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString();
  };
  return { dueAt: shift(row.due_at), remindAt: shift(row.remind_at) };
}

router.get("/", async (req, res) => {
  const q = validate(querySchema, req.query);
  const db = getDb();
  const query = baseQuery(db, req.user.id);

  if (q.status === "open") query.andWhere("t.status", "!=", "done");
  else if (q.status) query.andWhere("t.status", q.status);
  if (q.priority) query.andWhere("t.priority", q.priority);
  if (q.listId) query.andWhere("t.list_id", q.listId);
  if (q.dueFrom) query.andWhere("t.due_at", ">=", new Date(q.dueFrom).toISOString());
  if (q.dueTo) query.andWhere("t.due_at", "<=", new Date(q.dueTo).toISOString());
  if (q.hasDue === "true") query.whereNotNull("t.due_at");
  if (q.hasDue === "false") query.whereNull("t.due_at");
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.andWhere(inner => inner.whereRaw("lower(t.title) like ?", [term]).orWhereRaw("lower(coalesce(t.notes, '')) like ?", [term]));
  }

  const [{ total }] = await query.clone().clearSelect().clearOrder().count({ total: "t.id" });

  const dir = q.dir === "desc" ? "desc" : "asc";
  if (q.sort === "due") query.orderByRaw(`t.due_at is null, t.due_at ${dir}`);
  if (q.sort === "priority") {
    query.orderByRaw(`case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end ${dir}`);
  }
  if (q.sort === "created") query.orderBy("t.created_at", dir);
  if (q.sort === "title") query.orderByRaw(`lower(t.title) ${dir}`);
  query.orderBy("t.id", "asc");

  const rows = await query.limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const totalCount = Number(total);
  res.json({
    items: rows.map(toTask),
    page: q.page,
    pageSize: q.pageSize,
    total: totalCount,
    totalPages: Math.ceil(totalCount / q.pageSize),
  });
});

router.get("/:id", async (req, res) => {
  const row = await findOwnedTask(getDb(), req.user.id, parseId(req.params.id));
  res.json(toTask(row));
});

router.post("/", async (req, res) => {
  const input = validate(taskSchema, req.body);
  const db = getDb();
  await assertListOwned(db, req.user.id, input.listId);

  const now = nowIso();
  const id = await insertAndGetId(db, "tasks", {
    ...toRow(input),
    user_id: req.user.id,
    completed_at: input.status === "done" ? now : null,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(toTask(await findOwnedTask(db, req.user.id, id)));
});

router.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const current = await findOwnedTask(db, req.user.id, id);

  const merged = validate(taskSchema, {
    title: current.title,
    notes: current.notes,
    status: current.status,
    priority: current.priority,
    listId: current.list_id,
    dueAt: current.due_at,
    remindAt: current.remind_at,
    repeat: current.repeat,
    ...req.body,
  });
  await assertListOwned(db, req.user.id, merged.listId);

  const changes = toRow(Object.fromEntries(Object.keys(req.body ?? {}).filter(key => key in merged).map(key => [key, merged[key]])));
  if (changes.remind_at === current.remind_at) delete changes.reminder_sent;
  if ("status" in changes && changes.status !== current.status) {
    changes.completed_at = changes.status === "done" ? nowIso() : null;
  }

  await db.transaction(async trx => {
    await trx("tasks").where({ id }).update({ ...changes, updated_at: nowIso() });
    const completedNow = changes.status === "done" && current.status !== "done";
    if (completedNow && current.repeat !== "none") {
      const next = nextOccurrence(current);
      const now = nowIso();
      await trx("tasks").insert({
        user_id: current.user_id,
        list_id: current.list_id,
        title: current.title,
        notes: current.notes,
        priority: current.priority,
        status: "todo",
        repeat: current.repeat,
        due_at: next.dueAt,
        remind_at: next.remindAt,
        reminder_sent: false,
        created_at: now,
        updated_at: now,
      });
    }
  });

  res.json(toTask(await findOwnedTask(db, req.user.id, id)));
});

router.delete("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findOwnedTask(db, req.user.id, id);
  await db("tasks").where({ id }).delete();
  res.status(204).end();
});

export default router;
