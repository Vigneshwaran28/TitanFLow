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

  let meetingCount = 0;
  if (await db.schema.hasTable("meetings")) {
    const windowStart = new Date(Date.now() - 10 * 60_000).toISOString();
    const windowEnd = new Date(Date.now() + 5 * 60_000 + 30_000).toISOString();

    const dueMeetings = await db("meetings")
      .where("reminder_sent", false)
      .where("start_at", "<=", windowEnd)
      .where("start_at", ">=", windowStart)
      .limit(100);

    for (const meeting of dueMeetings) {
      const participants = await db("meeting_participants").where("meeting_id", meeting.id).select("user_id");
      let recipientIds = participants.map(p => p.user_id);

      // If no explicit participants specified, it's a workspace-wide meeting
      if (recipientIds.length === 0) {
        const activeUsers = await db("users").where({ tenant_id: meeting.tenant_id, is_active: true }).select("id");
        recipientIds = activeUsers.map(u => u.id);
      }

      await db.transaction(async trx => {
        if (recipientIds.length > 0) {
          const hasMeetingCol = await trx.schema.hasColumn("notifications", "meeting_id");
          await trx("notifications").insert(
            recipientIds.map(userId => ({
              user_id: userId,
              task_id: null,
              ticket_id: null,
              ...(hasMeetingCol ? { meeting_id: meeting.id } : {}),
              title: `Upcoming meeting: ${meeting.title}`,
              body: `Starts in 5 minutes (${meeting.platform.replace(/_/g, " ")}). Click to join.`,
              is_read: false,
              created_at: now,
            }))
          );
        }
        await trx("meetings").where({ id: meeting.id }).update({ reminder_sent: true });
      });

      // Broadcast meeting.reminder to participants with direct URL & title for toaster + sound
      publish({ users: recipientIds, tenantId: meeting.tenant_id }, "meeting.reminder", {
        meetingId: meeting.id,
        title: meeting.title,
        platform: meeting.platform,
        url: meeting.url,
        startAt: meeting.start_at,
        reminderMinutes: meeting.reminder_minutes || 5,
      });

      if (recipientIds.length > 0) {
        publish({ users: recipientIds }, "notification.created", { title: meeting.title, meetingId: meeting.id });
      }
      meetingCount += 1;
    }
  }

  return due.length + meetingCount;
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
