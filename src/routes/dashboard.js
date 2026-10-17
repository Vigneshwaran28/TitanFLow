// Dashboard stats + notifications. Day boundaries come from the client so "today" matches the user's timezone.
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { nowIso, parseId, validate } from "../utils/http.js";
import { toTask } from "./tasks.js";

export const statsRouter = Router();
export const notificationsRouter = Router();

const isoDate = z.iso.datetime({ offset: true });

const statsQuery = z.object({
  todayStart: isoDate,
  todayEnd: isoDate,
  weekStart: isoDate,
});

statsRouter.get("/", async (req, res) => {
  const q = validate(statsQuery, req.query);
  const todayStart = new Date(q.todayStart).toISOString();
  const todayEnd = new Date(q.todayEnd).toISOString();
  const weekStart = new Date(q.weekStart).toISOString();
  const now = nowIso();
  const db = getDb();
  const mine = () => db("tasks").where("user_id", req.user.id);
  const count = async query => Number((await query.count({ n: "id" }))[0].n);

  const [open, dueToday, overdue, completedThisWeek, byPriorityRows, completedRecent, upcomingRows] = await Promise.all([
    count(mine().whereNot("status", "done")),
    count(mine().whereNot("status", "done").whereBetween("due_at", [todayStart, todayEnd])),
    count(mine().whereNot("status", "done").where("due_at", "<", now)),
    count(mine().where("status", "done").where("completed_at", ">=", weekStart)),
    mine().whereNot("status", "done").groupBy("priority").select("priority").count({ n: "id" }),
    mine().where("status", "done").where("completed_at", ">=", weekStart).select("completed_at"),
    db("tasks as t")
      .leftJoin("lists as l", "l.id", "t.list_id")
      .where("t.user_id", req.user.id)
      .whereNot("t.status", "done")
      .whereNotNull("t.due_at")
      .orderBy("t.due_at", "asc")
      .limit(6)
      .select("t.*", "l.name as list_name", "l.color as list_color"),
  ]);

  const byPriority = { low: 0, medium: 0, high: 0, urgent: 0 };
  for (const row of byPriorityRows) byPriority[row.priority] = Number(row.n);

  res.json({
    open,
    dueToday,
    overdue,
    completedThisWeek,
    byPriority,
    completedAt: completedRecent.map(row => row.completed_at), // client buckets these by local day
    nextUp: upcomingRows.map(toTask),
  });
});

notificationsRouter.get("/", async (req, res) => {
  const db = getDb();
  // Task reminders show the task's due date; a workspace without the tasks module may have no tasks table.
  const items = req.tenant.features.includes("tasks")
    ? await db("notifications as n").leftJoin("tasks as t", "t.id", "n.task_id").where("n.user_id", req.user.id).orderBy("n.created_at", "desc").limit(30).select("n.*", "t.due_at as task_due_at")
    : await db("notifications as n").where("n.user_id", req.user.id).orderBy("n.created_at", "desc").limit(30).select("n.*");
  const [{ n }] = await db("notifications").where({ user_id: req.user.id, is_read: false }).count({ n: "id" });
  res.json({
    unreadCount: Number(n),
    items: items.map(row => ({
      id: row.id,
      taskId: row.task_id,
      ticketId: row.ticket_id ?? null,
      meetingId: row.meeting_id ?? null,
      title: row.title,
      body: row.body,
      dueAt: row.task_due_at ?? null,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at,
    })),
  });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await getDb()("notifications").where({ user_id: req.user.id, is_read: false }).update({ is_read: true });
  res.status(204).end();
});

notificationsRouter.post("/:id/read", async (req, res) => {
  await getDb()("notifications").where({ id: parseId(req.params.id), user_id: req.user.id }).update({ is_read: true });
  res.status(204).end();
});

notificationsRouter.delete("/", async (req, res) => {
  await getDb()("notifications").where({ user_id: req.user.id }).delete();
  res.status(204).end();
});
