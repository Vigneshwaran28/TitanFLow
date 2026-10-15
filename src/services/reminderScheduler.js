// Turns due reminders into notifications. Runs every 30 seconds while the server is up.
import { forEachDatabase } from "./tenantDatabases.js";
import { nowIso } from "../utils/http.js";
import { publish } from "./realtime.js";

const INTERVAL_MS = 30_000;
let timer = null;
let running = false;

export async function processDueReminders() {
  if (running) return 0;
  running = true;
  try {
    // Every database: the platform one and each tenant's own (live updates then reach the right people).
    const results = await forEachDatabase(processDatabase, { label: "reminders" });
    return results.reduce((sum, result) => sum + result.value, 0);
  } catch (error) {
    console.error("[reminders]", error.message);
    return 0;
  } finally {
    running = false;
  }
}

/** Due reminders of one database (a tenant database without the tasks module has no tasks table). */
async function processDatabase(db) {
  if (!(await db.schema.hasTable("tasks"))) return 0;
  const now = nowIso();
  const due = await db("tasks")
    .whereNotNull("remind_at")
    .where("remind_at", "<=", now)
    .where("reminder_sent", false)
    .whereNot("status", "done")
    .limit(200);

  for (const task of due) {
    await db.transaction(async trx => {
      await trx("notifications").insert({
        user_id: task.user_id,
        task_id: task.id,
        title: task.title,
        body: null, // the client formats the due date in the user's timezone
        is_read: false,
        created_at: now,
      });
      await trx("tasks").where({ id: task.id }).update({ reminder_sent: true });
    });
    // After the commit: refresh the owner's bell.
    publish({ users: [task.user_id] }, "notification.created", { title: task.title, ticketId: null });
  }
  return due.length;
}

export function startReminderScheduler() {
  if (timer) return;
  processDueReminders();
  timer = setInterval(processDueReminders, INTERVAL_MS);
  timer.unref();
}

export function stopReminderScheduler() {
  clearInterval(timer);
  timer = null;
}
