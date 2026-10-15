// In-app notifications for workspace events (tickets today). Reminders have their own scheduler.
import { nowIso } from "../utils/http.js";
import { publish } from "./realtime.js";

/**
 * Sends one notification to each recipient, skipping duplicates, empty ids, and the person who acted.
 * @param {import("knex").Knex | import("knex").Knex.Transaction} db
 * @param {Array<number | null | undefined>} userIds
 * @param {{ title: string, body: string, ticketId?: number, actorId?: number }} message
 */
export async function notifyUsers(db, userIds, { title, body, ticketId = null, actorId }) {
  const recipients = [...new Set(userIds.filter(id => id && id !== actorId))];
  if (!recipients.length) return;
  const createdAt = nowIso();
  await db("notifications").insert(
    recipients.map(userId => ({
      user_id: userId,
      task_id: null,
      ticket_id: ticketId,
      title: title.slice(0, 255),
      body: body.slice(0, 500),
      is_read: false,
      created_at: createdAt,
    }))
  );
  // Callers often notify inside a transaction: tell browsers a moment later, once it has committed.
  setTimeout(() => publish({ users: recipients }, "notification.created", { title: title.slice(0, 255), ticketId }), 150).unref?.();
}
