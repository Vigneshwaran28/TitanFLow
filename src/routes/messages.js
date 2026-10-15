// Messaging: direct chats between two people and group chats, all inside one tenant.
// Only members can read or post in a conversation. Clients poll; unread counts come from each
// member's last_read_at.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can } from "../middleware/auth.js";
import { avatarUrlOf } from "../services/avatars.js";
import { publish } from "../services/realtime.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const memberIdsOf = async (db, conversationId) => (await db("conversation_members").where({ conversation_id: conversationId }).select("user_id")).map(row => row.user_id);

/** Live hint to the conversation's members (plus `extra`, e.g. someone just removed). Call after the transaction commits. */
async function publishToMembers(db, conversationId, type, data, extra = []) {
  try {
    const users = [...new Set([...(await memberIdsOf(db, conversationId)), ...extra])];
    publish({ users }, type, { conversationId, ...data });
  } catch (error) {
    console.warn("[realtime] messaging publish failed:", error.message);
  }
}

const PAGE = 50;
const settingsOf = req => req.tenant.settings.messaging;
const directKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

const groupSchema = z.object({
  name: z.string().trim().min(1, "Name the group.").max(80, "Keep the name under 80 characters."),
  memberIds: z.array(z.number().int().positive()).min(1, "Add at least one person.").max(200),
});

async function activeTenantUsers(db, tenantId, ids) {
  const unique = [...new Set(ids)];
  const rows = await db("users").where({ tenant_id: tenantId, is_active: true }).whereIn("id", unique).select("id", "name");
  if (rows.length !== unique.length) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { memberIds: "Pick active people from your workspace." } });
  }
  return rows;
}

/** The conversation, if the signed-in user is a member of it. */
async function findMembership(db, req, id) {
  const row = await db("conversations as c")
    .join("conversation_members as m", "m.conversation_id", "c.id")
    .where({ "c.id": id, "c.tenant_id": req.user.tenant_id, "m.user_id": req.user.id })
    .select("c.*", "m.role as my_role", "m.last_read_at")
    .first();
  if (!row) throw new HttpError(404, "Conversation not found.");
  return row;
}

const canManage = (req, conversation) => conversation.type === "group" && (conversation.my_role === "owner" || can(req, "workspace.users.manage"));

async function systemMessage(db, conversationId, body, at = nowIso()) {
  await db("messages").insert({ conversation_id: conversationId, sender_id: null, body, kind: "system", created_at: at });
  await db("conversations").where({ id: conversationId }).update({ last_message_at: at });
}

const toMessage = row => ({
  id: row.id,
  conversationId: row.conversation_id,
  kind: row.kind,
  body: row.deleted_at ? null : row.body,
  deleted: Boolean(row.deleted_at),
  sender: row.sender_id ? { id: row.sender_id, name: row.sender_name } : null,
  createdAt: row.created_at,
});

/** Every conversation the user is in, newest activity first, with members, last message, and unread count. */
async function listConversations(db, req, onlyId) {
  const me = req.user.id;
  const query = db("conversations as c")
    .join("conversation_members as m", function joinMine() {
      this.on("m.conversation_id", "c.id").andOnVal("m.user_id", me);
    })
    .where("c.tenant_id", req.user.tenant_id)
    .select("c.*", "m.role as my_role", "m.last_read_at");
  if (onlyId) query.where("c.id", onlyId);
  const conversations = await query;
  if (!conversations.length) return [];
  const ids = conversations.map(row => row.id);

  const [members, lastMessages, unread] = await Promise.all([
    db("conversation_members as m").join("users as u", "u.id", "m.user_id").whereIn("m.conversation_id", ids).select("m.conversation_id", "m.role", "u.id", "u.name", "u.job_title", "u.is_active", "u.preferences"),
    db("messages as x")
      .leftJoin("users as u", "u.id", "x.sender_id")
      .whereIn("x.id", db("messages").whereIn("conversation_id", ids).groupBy("conversation_id").max("id"))
      .select("x.*", "u.name as sender_name"),
    db("messages as x")
      .join("conversation_members as m", function joinReader() {
        this.on("m.conversation_id", "x.conversation_id").andOnVal("m.user_id", me);
      })
      .whereIn("x.conversation_id", ids)
      .where("x.kind", "text")
      .whereNull("x.deleted_at")
      .where(inner => inner.whereNull("x.sender_id").orWhereNot("x.sender_id", me))
      .where(inner => inner.whereNull("m.last_read_at").orWhereRaw("x.created_at > m.last_read_at"))
      .groupBy("x.conversation_id")
      .select("x.conversation_id")
      .count({ count: "*" }),
  ]);
  const unreadBy = new Map(unread.map(row => [row.conversation_id, Number(row.count)]));
  const lastBy = new Map(lastMessages.map(row => [row.conversation_id, row]));

  return conversations
    .map(row => {
      const people = members.filter(member => member.conversation_id === row.id);
      const other = row.type === "direct" ? people.find(person => person.id !== me) : null;
      const last = lastBy.get(row.id);
      return {
        id: row.id,
        type: row.type,
        name: row.type === "direct" ? (other?.name ?? "Former colleague") : row.name,
        // Direct chats show the other person's picture.
        avatarUrl: other ? avatarUrlOf(other.preferences) : null,
        myRole: row.my_role,
        canManage: canManage(req, row),
        members: people.map(person => ({ id: person.id, name: person.name, jobTitle: person.job_title, avatarUrl: avatarUrlOf(person.preferences), role: person.role, isActive: Boolean(person.is_active) })),
        lastMessage: last ? toMessage(last) : null,
        unread: unreadBy.get(row.id) ?? 0,
        lastActivityAt: row.last_message_at ?? row.created_at,
        createdAt: row.created_at,
      };
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

router.get("/conversations", async (req, res) => {
  res.json(await listConversations(getDb(), req));
});

router.get("/unread", async (req, res) => {
  const list = await listConversations(getDb(), req);
  res.json({ total: list.reduce((sum, item) => sum + item.unread, 0), conversations: list.filter(item => item.unread).length });
});

router.post("/conversations/direct", async (req, res) => {
  const { userId } = validate(z.object({ userId: z.number().int().positive() }), req.body);
  if (userId === req.user.id) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { userId: "Pick someone other than yourself." } });
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await activeTenantUsers(db, tenantId, [userId]);

  const key = directKey(req.user.id, userId);
  let conversation = await db("conversations").where({ tenant_id: tenantId, direct_key: key }).first();
  if (!conversation) {
    const now = nowIso();
    const id = await db.transaction(async trx => {
      const conversationId = await insertAndGetId(trx, "conversations", { tenant_id: tenantId, type: "direct", direct_key: key, created_by: req.user.id, created_at: now });
      await trx("conversation_members").insert([req.user.id, userId].map(memberId => ({ conversation_id: conversationId, user_id: memberId, role: "member", joined_at: now })));
      return conversationId;
    });
    conversation = { id };
    await publishToMembers(db, id, "conversation.updated", { actorId: req.user.id });
  }
  res.status(201).json((await listConversations(db, req, conversation.id))[0]);
});

router.post("/conversations/group", async (req, res) => {
  const settings = settingsOf(req);
  if (!settings.allowGroups) throw new HttpError(403, "Group chats are turned off in your workspace.", { code: "FORBIDDEN" });
  if (!can(req, "messaging.groups.create")) throw new HttpError(403, "You don't have permission to create group chats.", { code: "FORBIDDEN" });
  const input = validate(groupSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await activeTenantUsers(db, tenantId, input.memberIds);

  const now = nowIso();
  const id = await db.transaction(async trx => {
    const conversationId = await insertAndGetId(trx, "conversations", { tenant_id: tenantId, type: "group", name: input.name, created_by: req.user.id, created_at: now });
    const memberIds = [...new Set([req.user.id, ...input.memberIds])];
    await trx("conversation_members").insert(
      memberIds.map(memberId => ({ conversation_id: conversationId, user_id: memberId, role: memberId === req.user.id ? "owner" : "member", joined_at: now, last_read_at: memberId === req.user.id ? now : null }))
    );
    await systemMessage(trx, conversationId, `${req.user.name} created the group "${input.name}"`, now);
    return conversationId;
  });
  await publishToMembers(db, id, "conversation.updated", { actorId: req.user.id });
  res.status(201).json((await listConversations(db, req, id))[0]);
});

router.patch("/conversations/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const { name } = validate(groupSchema.pick({ name: true }), req.body);
  const db = getDb();
  const conversation = await findMembership(db, req, id);
  if (!canManage(req, conversation)) throw new HttpError(403, "Only the group owner or an admin can rename it.", { code: "FORBIDDEN" });
  if (name !== conversation.name) {
    await db.transaction(async trx => {
      await trx("conversations").where({ id }).update({ name });
      await systemMessage(trx, id, `${req.user.name} renamed the group to "${name}"`);
    });
    await publishToMembers(db, id, "conversation.updated", { actorId: req.user.id });
  }
  res.json((await listConversations(db, req, id))[0]);
});

router.post("/conversations/:id/members", async (req, res) => {
  const id = parseId(req.params.id);
  const { userIds } = validate(z.object({ userIds: z.array(z.number().int().positive()).min(1).max(200) }), req.body);
  const db = getDb();
  const conversation = await findMembership(db, req, id);
  if (!canManage(req, conversation)) throw new HttpError(403, "Only the group owner or an admin can add people.", { code: "FORBIDDEN" });
  const users = await activeTenantUsers(db, req.user.tenant_id, userIds);
  const existing = new Set((await db("conversation_members").where({ conversation_id: id }).select("user_id")).map(row => row.user_id));
  const added = users.filter(user => !existing.has(user.id));
  if (added.length) {
    const now = nowIso();
    await db.transaction(async trx => {
      await trx("conversation_members").insert(added.map(user => ({ conversation_id: id, user_id: user.id, role: "member", joined_at: now })));
      await systemMessage(trx, id, `${req.user.name} added ${added.map(user => user.name).join(", ")}`, now);
    });
    await publishToMembers(db, id, "conversation.updated", { actorId: req.user.id });
  }
  res.json((await listConversations(db, req, id))[0]);
});

router.delete("/conversations/:id/members/:userId", async (req, res) => {
  const id = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  const db = getDb();
  const conversation = await findMembership(db, req, id);
  if (conversation.type !== "group") throw new HttpError(422, "You can't leave a direct conversation.", { code: "INVALID_TRANSITION" });
  const leaving = userId === req.user.id;
  if (!leaving && !canManage(req, conversation)) throw new HttpError(403, "Only the group owner or an admin can remove people.", { code: "FORBIDDEN" });
  const target = await db("conversation_members as m").join("users as u", "u.id", "m.user_id").where({ "m.conversation_id": id, "m.user_id": userId }).select("m.role", "u.name").first();
  if (!target) throw new HttpError(404, "That person isn't in this group.");

  await db.transaction(async trx => {
    await trx("conversation_members").where({ conversation_id: id, user_id: userId }).delete();
    const rest = await trx("conversation_members").where({ conversation_id: id }).orderBy("joined_at").select("user_id", "role");
    if (!rest.length) {
      await trx("conversations").where({ id }).delete();
      return;
    }
    // A group always keeps an owner: the longest-standing member takes over.
    if (target.role === "owner" && !rest.some(member => member.role === "owner")) {
      await trx("conversation_members").where({ conversation_id: id, user_id: rest[0].user_id }).update({ role: "owner" });
    }
    await systemMessage(trx, id, leaving ? `${target.name} left the group` : `${req.user.name} removed ${target.name}`);
  });
  await publishToMembers(db, id, "conversation.updated", { actorId: req.user.id }, [userId]);
  res.status(204).end();
});

router.get("/conversations/:id/messages", async (req, res) => {
  const id = parseId(req.params.id);
  const q = validate(z.object({ after: z.coerce.number().int().min(0).optional(), before: z.coerce.number().int().positive().optional() }), req.query);
  const db = getDb();
  await findMembership(db, req, id);
  const query = db("messages as x").leftJoin("users as u", "u.id", "x.sender_id").where("x.conversation_id", id).select("x.*", "u.name as sender_name");
  if (q.after !== undefined) {
    // New messages since the last poll, oldest first.
    const rows = await query.where("x.id", ">", q.after).orderBy("x.id").limit(200);
    return res.json({ messages: rows.map(toMessage), hasMore: false });
  }
  if (q.before) query.where("x.id", "<", q.before);
  const rows = await query.orderBy("x.id", "desc").limit(PAGE + 1);
  res.json({ messages: rows.slice(0, PAGE).reverse().map(toMessage), hasMore: rows.length > PAGE });
});

router.post("/conversations/:id/messages", async (req, res) => {
  const id = parseId(req.params.id);
  const { body } = validate(z.object({ body: z.string().trim().min(1, "Write a message first.").max(4000, "Keep messages under 4,000 characters.") }), req.body);
  const db = getDb();
  await findMembership(db, req, id);
  const now = nowIso();
  const messageId = await db.transaction(async trx => {
    const newId = await insertAndGetId(trx, "messages", { conversation_id: id, sender_id: req.user.id, body, kind: "text", created_at: now });
    await trx("conversations").where({ id }).update({ last_message_at: now });
    await trx("conversation_members").where({ conversation_id: id, user_id: req.user.id }).update({ last_read_at: now });
    return newId;
  });
  const row = await db("messages as x").leftJoin("users as u", "u.id", "x.sender_id").where("x.id", messageId).select("x.*", "u.name as sender_name").first();
  // Members can already read the sender's name; it lets the browser say who wrote without another request.
  await publishToMembers(db, id, "message.created", { messageId, senderId: req.user.id, senderName: req.user.name });
  res.status(201).json(toMessage(row));
});

router.post("/conversations/:id/read", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findMembership(db, req, id);
  await db("conversation_members").where({ conversation_id: id, user_id: req.user.id }).update({ last_read_at: nowIso() });
  res.status(204).end();
});

router.delete("/messages/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const message = await db("messages").where({ id }).first();
  if (!message) throw new HttpError(404, "Message not found.");
  await findMembership(db, req, message.conversation_id);
  if (message.sender_id !== req.user.id) throw new HttpError(403, "You can only delete your own messages.", { code: "FORBIDDEN" });
  await db("messages").where({ id }).update({ deleted_at: nowIso() });
  await publishToMembers(db, message.conversation_id, "conversation.updated", { actorId: req.user.id });
  res.status(204).end();
});

export default router;
