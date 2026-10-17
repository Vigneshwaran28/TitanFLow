// Help desk, scoped to the signed-in user's tenant. Anyone can raise a ticket and it can be assigned to anyone
// in the workspace. Staff (admins and agents) and the ticket's assignee work it; requesters follow their own
// tickets and never see internal notes.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can } from "../middleware/auth.js";
import { avatarUrlOf } from "../services/avatars.js";
import { usersWithPermission } from "../services/permissions.js";
import { notifyUsers } from "../services/notify.js";
import { publish } from "../services/realtime.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

/**
 * Live hint after a ticket changed (call once the transaction has committed). Help desk staff always hear about it;
 * the requester and assignee(s) too, except for internal notes, which only the people working the ticket see.
 */
function publishTicket(req, ticketId, { requesterId, assigneeId = null, also = [], internal = false }) {
  const users = (internal ? [assigneeId] : [requesterId, assigneeId, ...also]).filter(Boolean);
  // The ids let browsers tell "my ticket" apart (for a toast) without fetching it; every recipient may know them.
  publish({ tenantId: req.user.tenant_id, permission: "helpdesk.work", users }, "ticket.updated", { ticketId, actorId: req.user.id, requesterId, assigneeId, internal });
}

export const TICKET_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"];
const ACTIVE = ["open", "in_progress", "waiting"];
const DONE = ["resolved", "closed"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const CATEGORIES = ["it_support", "access", "hardware", "software", "hr", "facilities", "finance", "other"];

/** Response / resolution targets in calendar hours, from the tenant's help desk settings. */
const slaFor = (req, priority) => req.tenant.settings.helpdesk.sla[priority];

/** Categories are a fixed list; each tenant chooses which ones its people can pick. */
function assertCategory(req, category) {
  if (!req.tenant.settings.helpdesk.categories.includes(category)) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { category: "This category isn't used in your workspace." } });
  }
}

const STATUS_LABELS = { open: "Open", in_progress: "In progress", waiting: "Waiting on requester", resolved: "Resolved", closed: "Closed" };

const addHours = (iso, hours) => new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
const ticketKey = id => `TKT-${String(id).padStart(4, "0")}`;

// ---- Schemas ----
const createSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required.").max(200, "Keep the subject under 200 characters."),
  description: z.string().trim().min(1, "Describe the problem or request.").max(10_000, "The description is too long."),
  category: z.enum(CATEGORIES).default("other"),
  priority: z.enum(PRIORITIES).default("medium"),
  teamId: z.number().int().positive().nullable().default(null),
  assigneeId: z.number().int().positive().nullable().default(null),
});

const updateSchema = z
  .object({
    subject: z.string().trim().min(1, "Subject is required.").max(200),
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(PRIORITIES),
    category: z.enum(CATEGORIES),
    assigneeId: z.number().int().positive().nullable(),
    teamId: z.number().int().positive().nullable(),
  })
  .partial();

const commentSchema = z.object({
  body: z.string().trim().min(1, "Write a message first.").max(10_000, "The message is too long."),
  isInternal: z.boolean().default(false),
});

const ratingSchema = z.object({
  rating: z.number().int().min(1, "Choose 1 to 5 stars.").max(5, "Choose 1 to 5 stars."),
  comment: z.string().trim().max(1000).nullable().default(null),
});

const listSchema = z.object({
  scope: z.enum(["mine", "assigned", "unassigned", "team", "all"]).default("mine"),
  status: z.enum(["active", "all", ...TICKET_STATUSES]).default("active"),
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  teamId: z.coerce.number().int().positive().optional(),
  breached: z.enum(["true"]).optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(["updated", "created", "priority", "due"]).default("updated"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ---- Access ----
/** Staff, or the person the ticket is assigned to. */
const canWork = (req, row) => can(req, "helpdesk.work") || row.assignee_id === req.user.id;
const canSee = (req, row) => canWork(req, row) || row.requester_id === req.user.id;

// ---- Mapping ----
function baseQuery(db, tenantId) {
  return db("tickets as k")
    .join("users as r", "r.id", "k.requester_id")
    .leftJoin("users as a", "a.id", "k.assignee_id")
    .leftJoin("teams as t", "t.id", "k.team_id")
    .where("k.tenant_id", tenantId)
    .select(
      "k.*",
      "r.name as requester_name",
      "r.email as requester_email",
      "r.job_title as requester_job_title",
      "r.preferences as requester_preferences",
      "a.name as assignee_name",
      "a.email as assignee_email",
      "a.preferences as assignee_preferences",
      "t.name as team_name",
      "t.color as team_color"
    );
}

function toTicket(row, req) {
  return {
    id: row.id,
    key: ticketKey(row.id),
    subject: row.subject,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    requester: { id: row.requester_id, name: row.requester_name, email: row.requester_email, jobTitle: row.requester_job_title ?? null, avatarUrl: avatarUrlOf(row.requester_preferences) },
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, email: row.assignee_email, avatarUrl: avatarUrlOf(row.assignee_preferences) } : null,
    team: row.team_id ? { id: row.team_id, name: row.team_name, color: row.team_color } : null,
    responseDueAt: row.response_due_at,
    resolutionDueAt: row.resolution_due_at,
    firstResponseAt: row.first_response_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    satisfaction: row.satisfaction ?? null,
    satisfactionComment: row.satisfaction_comment ?? null,
    canWork: req ? canWork(req, row) : false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findTicket(db, tenantId, id) {
  const row = await baseQuery(db, tenantId).where("k.id", id).first();
  if (!row) throw new HttpError(404, "Ticket not found.");
  return row;
}

async function findVisibleTicket(db, req, id) {
  const row = await findTicket(db, req.user.tenant_id, id);
  if (!canSee(req, row)) throw new HttpError(404, "Ticket not found.");
  return row;
}

/** Who to alert about a new or unowned ticket: the team's members, or everyone who works the help desk when it has none. */
async function triageRecipients(db, tenantId, teamId) {
  if (teamId) {
    const rows = await db("team_members as m").join("users as u", "u.id", "m.user_id").where({ "m.team_id": teamId, "u.is_active": true }).select("u.id");
    if (rows.length) return rows.map(row => row.id);
  }
  return (await usersWithPermission(db, tenantId, "helpdesk.work")).slice(0, 100);
}

async function assertTeam(db, tenantId, teamId) {
  if (teamId == null) return null;
  const team = await db("teams").where({ id: teamId, tenant_id: tenantId }).first();
  if (!team) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { teamId: "Choose an existing team." } });
  return team;
}

async function assertAssignee(db, tenantId, assigneeId) {
  if (assigneeId == null) return null;
  const user = await db("users").where({ id: assigneeId, tenant_id: tenantId, is_active: true }).first();
  if (!user) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { assigneeId: "Choose an active person in your workspace." } });
  const [users, workers] = await Promise.all([usersWithPermission(db, tenantId, "helpdesk.use"), usersWithPermission(db, tenantId, "helpdesk.work")]);
  if (!users.includes(user.id) && !workers.includes(user.id)) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { assigneeId: `${user.name} doesn't have access to the help desk.` } });
  }
  return user;
}

const event = (ticketId, actorId, type, from = null, to = null, createdAt = nowIso()) => ({
  ticket_id: ticketId,
  actor_id: actorId,
  type,
  from_value: from == null ? null : String(from).slice(0, 120),
  to_value: to == null ? null : String(to).slice(0, 120),
  created_at: createdAt,
});

// ---- Routes ----
router.get("/stats", async (req, res) => {
  const db = getDb();
  const now = nowIso();
  const tenantId = req.user.tenant_id;
  const count = query => query.count({ count: "*" }).then(rows => Number(rows[0].count));
  const tickets = () => db("tickets").where("tenant_id", tenantId);
  const active = () => tickets().whereIn("status", ACTIVE);

  if (!can(req, "helpdesk.work")) {
    const mine = () => tickets().where("requester_id", req.user.id);
    const [open, waiting, resolved, assignedToMe] = await Promise.all([
      count(mine().whereIn("status", ACTIVE)),
      count(mine().where("status", "waiting")),
      count(mine().whereIn("status", DONE)),
      count(active().where("assignee_id", req.user.id)),
    ]);
    return res.json({ staff: false, myOpen: open, waitingOnMe: waiting, resolved, assignedToMe });
  }

  const myTeams = db("team_members").select("team_id").where("user_id", req.user.id);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const [open, unassigned, assignedToMe, myTeamsOpen, breached, resolvedToday, ratings] = await Promise.all([
    count(active()),
    count(active().whereNull("assignee_id")),
    count(active().where("assignee_id", req.user.id)),
    count(active().whereIn("team_id", myTeams)),
    count(active().where("resolution_due_at", "<", now)),
    count(tickets().where("resolved_at", ">=", todayStart)),
    tickets().whereNotNull("satisfaction").where("resolved_at", ">=", monthAgo).select(db.raw("avg(satisfaction) as avg"), db.raw("count(*) as count")),
  ]);

  res.json({
    staff: true,
    open,
    unassigned,
    assignedToMe,
    myTeamsOpen,
    breached,
    resolvedToday,
    satisfaction: { average: ratings[0]?.avg == null ? null : Number(Number(ratings[0].avg).toFixed(1)), count: Number(ratings[0]?.count ?? 0) },
  });
});

router.get("/", async (req, res) => {
  const q = validate(listSchema, req.query);
  const staff = can(req, "helpdesk.work");
  const db = getDb();
  const query = baseQuery(db, req.user.tenant_id);

  // Everyone has "my requests" and "assigned to me"; the wider queues are for staff.
  const scope = staff || q.scope === "assigned" ? q.scope : "mine";
  if (scope === "mine") query.where("k.requester_id", req.user.id);
  if (scope === "assigned") query.where("k.assignee_id", req.user.id);
  if (scope === "unassigned") query.whereNull("k.assignee_id");
  if (scope === "team") query.whereIn("k.team_id", db("team_members").select("team_id").where("user_id", req.user.id));

  if (q.status === "active") query.whereIn("k.status", ACTIVE);
  else if (q.status !== "all") query.where("k.status", q.status);
  if (q.priority) query.where("k.priority", q.priority);
  if (q.category) query.where("k.category", q.category);
  if (staff && q.assigneeId) query.where("k.assignee_id", q.assigneeId);
  if (staff && q.teamId) query.where("k.team_id", q.teamId);
  if (q.breached) query.whereIn("k.status", ACTIVE).where("k.resolution_due_at", "<", nowIso());
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    const keyId = Number(q.search.replace(/^tkt-?/i, ""));
    query.where(inner => {
      inner.whereRaw("lower(k.subject) like ?", [term]).orWhereRaw("lower(k.description) like ?", [term]);
      if (Number.isInteger(keyId) && keyId > 0) inner.orWhere("k.id", keyId);
    });
  }

  const [{ total }] = await query.clone().clearSelect().clearOrder().count({ total: "k.id" });

  if (q.sort === "updated") query.orderBy("k.updated_at", "desc");
  if (q.sort === "created") query.orderBy("k.created_at", "desc");
  if (q.sort === "priority") query.orderByRaw("case k.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end").orderBy("k.resolution_due_at");
  if (q.sort === "due") query.orderBy("k.resolution_due_at", "asc");
  query.orderBy("k.id", "desc");

  const rows = await query.limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const totalCount = Number(total);
  res.json({
    items: rows.map(row => toTicket(row, req)),
    page: q.page,
    pageSize: q.pageSize,
    total: totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / q.pageSize)),
  });
});

router.get("/:id", async (req, res) => {
  const db = getDb();
  const row = await findVisibleTicket(db, req, parseId(req.params.id));

  const commentsQuery = db("ticket_comments as c")
    .leftJoin("users as u", "u.id", "c.author_id")
    .where("c.ticket_id", row.id)
    .select("c.*", "u.name as author_name")
    .orderBy("c.created_at")
    .orderBy("c.id");
  if (!canWork(req, row)) commentsQuery.where("c.is_internal", false);

  const [comments, events, workers] = await Promise.all([
    commentsQuery,
    db("ticket_events as e").leftJoin("users as u", "u.id", "e.actor_id").where("e.ticket_id", row.id).select("e.*", "u.name as actor_name").orderBy("e.created_at").orderBy("e.id"),
    usersWithPermission(db, req.user.tenant_id, "helpdesk.work").then(ids => new Set(ids)),
  ]);

  res.json({
    ...toTicket(row, req),
    comments: comments.map(comment => ({
      id: comment.id,
      body: comment.body,
      isInternal: Boolean(comment.is_internal),
      author: comment.author_id
        ? { id: comment.author_id, name: comment.author_name, isStaff: workers.has(comment.author_id) || comment.author_id === row.assignee_id }
        : null,
      createdAt: comment.created_at,
    })),
    events: events.map(item => ({
      id: item.id,
      type: item.type,
      from: item.from_value,
      to: item.to_value,
      actor: item.actor_id ? { id: item.actor_id, name: item.actor_name } : null,
      createdAt: item.created_at,
    })),
  });
});

router.post("/", async (req, res) => {
  const input = validate(createSchema, req.body);
  assertCategory(req, input.category);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertTeam(db, tenantId, input.teamId);
  const assignee = await assertAssignee(db, tenantId, input.assigneeId);

  const now = nowIso();
  const sla = slaFor(req, input.priority);
  const id = await db.transaction(async trx => {
    const ticketId = await insertAndGetId(trx, "tickets", {
      tenant_id: tenantId,
      requester_id: req.user.id,
      team_id: input.teamId,
      assignee_id: assignee?.id ?? null,
      subject: input.subject,
      description: input.description,
      category: input.category,
      priority: input.priority,
      status: "open",
      response_due_at: addHours(now, sla.response),
      resolution_due_at: addHours(now, sla.resolution),
      created_at: now,
      updated_at: now,
    });
    await trx("ticket_events").insert(event(ticketId, req.user.id, "created", null, input.priority, now));
    if (assignee) {
      await trx("ticket_events").insert(event(ticketId, req.user.id, "assignee", null, assignee.name, now));
      await notifyUsers(trx, [assignee.id], { title: input.subject, body: `${req.user.name} assigned you ${ticketKey(ticketId)}`, ticketId, actorId: req.user.id });
    } else {
      await notifyUsers(trx, await triageRecipients(trx, tenantId, input.teamId), {
        title: input.subject,
        body: `New ${input.priority} ticket ${ticketKey(ticketId)} from ${req.user.name}`,
        ticketId,
        actorId: req.user.id,
      });
    }
    return ticketId;
  });

  publishTicket(req, id, { requesterId: req.user.id, assigneeId: assignee?.id ?? null });
  if (assignee && assignee.id !== req.user.id) {
    publish({ users: [assignee.id] }, "ticket.assigned", {
      ticketId: id,
      ticketKey: ticketKey(id),
      subject: input.subject,
      actorId: req.user.id,
      actorName: req.user.name,
      priority: input.priority,
    });
  }
  res.status(201).json(toTicket(await findTicket(db, tenantId, id), req));
});

router.patch("/:id", async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id);
  const tenantId = req.user.tenant_id;
  const current = await findVisibleTicket(db, req, id);
  const input = validate(updateSchema, req.body ?? {});
  const worker = canWork(req, current);

  // Requesters may only close their ticket, or reopen it once it's resolved or closed.
  if (!worker) {
    const allowed = Object.keys(input).every(key => key === "status") && (input.status === "closed" || (input.status === "open" && DONE.includes(current.status)));
    if (!allowed) throw new HttpError(403, "You can only close or reopen your own ticket.", { code: "FORBIDDEN" });
  }
  if ("teamId" in input) await assertTeam(db, tenantId, input.teamId);
  if ("assigneeId" in input) await assertAssignee(db, tenantId, input.assigneeId);

  const now = nowIso();
  const changes = {};
  const events = [];
  const alerts = [];
  const label = ticketKey(id);

  if (input.subject !== undefined && input.subject !== current.subject) {
    changes.subject = input.subject;
    events.push(event(id, req.user.id, "subject", current.subject, input.subject, now));
  }

  if (input.priority && input.priority !== current.priority) {
    // Deadlines follow the new priority, measured from when the ticket was raised.
    const sla = slaFor(req, input.priority);
    changes.priority = input.priority;
    changes.response_due_at = addHours(current.created_at, sla.response);
    changes.resolution_due_at = addHours(current.created_at, sla.resolution);
    events.push(event(id, req.user.id, "priority", current.priority, input.priority, now));
  }

  if (input.category && input.category !== current.category) {
    assertCategory(req, input.category);
    changes.category = input.category;
    events.push(event(id, req.user.id, "category", current.category, input.category, now));
  }

  if ("teamId" in input && input.teamId !== current.team_id) {
    changes.team_id = input.teamId;
    const team = input.teamId ? await db("teams").where({ id: input.teamId }).first() : null;
    events.push(event(id, req.user.id, "team", current.team_name, team?.name ?? null, now));
    if (input.teamId && !current.assignee_id) {
      alerts.push({ to: await triageRecipients(db, tenantId, input.teamId), body: `${label} was routed to ${team.name}` });
    }
  }

  if ("assigneeId" in input && input.assigneeId !== current.assignee_id) {
    changes.assignee_id = input.assigneeId;
    const assignee = input.assigneeId ? await db("users").where({ id: input.assigneeId }).first() : null;
    events.push(event(id, req.user.id, "assignee", current.assignee_name, assignee?.name ?? null, now));
    if (assignee) alerts.push({ to: [assignee.id], body: `${label} was assigned to you by ${req.user.name}` });
    // Picking up an open ticket starts work on it.
    if (assignee && current.status === "open" && !input.status) input.status = "in_progress";
  }

  if (input.status && input.status !== current.status) {
    changes.status = input.status;
    events.push(event(id, req.user.id, "status", current.status, input.status, now));
    if (input.status === "resolved") changes.resolved_at = now;
    if (input.status === "closed") {
      changes.closed_at = now;
      if (!current.resolved_at) changes.resolved_at = now;
    }
    if (ACTIVE.includes(input.status) && DONE.includes(current.status)) {
      // Reopened: clear the outcome so it can be resolved and rated again.
      Object.assign(changes, { resolved_at: null, closed_at: null, satisfaction: null, satisfaction_comment: null });
    }
    const statusText = `${label} is now ${STATUS_LABELS[input.status].toLowerCase()}`;
    alerts.push({ to: [current.requester_id], body: input.status === "waiting" ? `${label} needs your reply` : statusText });
    if (!worker) alerts.push({ to: [current.assignee_id], body: `${statusText} (by ${req.user.name})` });
  }

  if (!events.length) return res.json(toTicket(current, req));

  await db.transaction(async trx => {
    await trx("tickets").where({ id }).update({ ...changes, updated_at: now });
    await trx("ticket_events").insert(events);
    for (const alert of alerts) await notifyUsers(trx, alert.to, { title: changes.subject ?? current.subject, body: alert.body, ticketId: id, actorId: req.user.id });
  });

  // The previous assignee hears about it too, so the ticket drops out of their list.
  publishTicket(req, id, { requesterId: current.requester_id, assigneeId: "assignee_id" in changes ? changes.assignee_id : current.assignee_id, also: [current.assignee_id] });
  if ("assignee_id" in changes && changes.assignee_id && changes.assignee_id !== req.user.id && changes.assignee_id !== current.assignee_id) {
    publish({ users: [changes.assignee_id] }, "ticket.assigned", {
      ticketId: id,
      ticketKey: label,
      subject: changes.subject ?? current.subject,
      actorId: req.user.id,
      actorName: req.user.name,
      priority: changes.priority ?? current.priority,
    });
  }
  res.json(toTicket(await findTicket(db, tenantId, id), req));
});

router.post("/:id/comments", async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id);
  const ticket = await findVisibleTicket(db, req, id);
  const input = validate(commentSchema, req.body);
  const worker = canWork(req, ticket);
  if (input.isInternal && !worker) throw new HttpError(403, "Only the people working this ticket can add internal notes.", { code: "FORBIDDEN" });

  const now = nowIso();
  const fromRequester = ticket.requester_id === req.user.id;
  const label = ticketKey(id);

  await db.transaction(async trx => {
    await trx("ticket_comments").insert({ ticket_id: id, author_id: req.user.id, body: input.body, is_internal: input.isInternal, created_at: now });
    const changes = { updated_at: now };

    if (input.isInternal) {
      await notifyUsers(trx, [ticket.assignee_id], { title: ticket.subject, body: `${req.user.name} added an internal note on ${label}`, ticketId: id, actorId: req.user.id });
    } else if (fromRequester) {
      // The requester answered: put the ticket back in the queue and tell whoever owns it.
      if (ticket.status === "waiting") {
        changes.status = "open";
        await trx("ticket_events").insert(event(id, req.user.id, "status", "waiting", "open", now));
      }
      const owners = ticket.assignee_id ? [ticket.assignee_id] : await triageRecipients(trx, ticket.tenant_id, ticket.team_id);
      await notifyUsers(trx, owners, { title: ticket.subject, body: `${req.user.name} replied on ${label}`, ticketId: id, actorId: req.user.id });
    } else {
      if (!ticket.first_response_at) changes.first_response_at = now;
      await notifyUsers(trx, [ticket.requester_id], { title: ticket.subject, body: `${req.user.name} replied on ${label}`, ticketId: id, actorId: req.user.id });
    }
    await trx("tickets").where({ id }).update(changes);
  });

  // Internal notes: staff and the assignee (who works the ticket) only, never the requester.
  publishTicket(req, id, { requesterId: ticket.requester_id, assigneeId: ticket.assignee_id, internal: input.isInternal });
  res.status(201).json({ ok: true });
});

router.post("/:id/rating", async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id);
  const ticket = await findVisibleTicket(db, req, id);
  if (ticket.requester_id !== req.user.id) throw new HttpError(403, "Only the person who raised the ticket can rate it.", { code: "FORBIDDEN" });
  if (!DONE.includes(ticket.status)) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { rating: "You can rate a ticket once it's resolved." } });

  const input = validate(ratingSchema, req.body);
  const now = nowIso();
  await db.transaction(async trx => {
    await trx("tickets").where({ id }).update({ satisfaction: input.rating, satisfaction_comment: input.comment || null, updated_at: now });
    await trx("ticket_events").insert(event(id, req.user.id, "rating", ticket.satisfaction, input.rating, now));
    await notifyUsers(trx, [ticket.assignee_id], { title: ticket.subject, body: `${req.user.name} rated ${ticketKey(id)} ${input.rating}/5`, ticketId: id, actorId: req.user.id });
  });
  publishTicket(req, id, { requesterId: ticket.requester_id, assigneeId: ticket.assignee_id });
  res.json(toTicket(await findTicket(db, req.user.tenant_id, id), req));
});

export default router;
