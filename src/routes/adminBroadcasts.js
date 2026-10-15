// Provider console: announcements to tenants (mounted by admin.js at /api/bunny/broadcasts, behind requireAdmin).
//   GET    /               sent, scheduled, and automatic (subscription) broadcasts with read counts
//   POST   /               compose: publish now or at a time, optional expiry
//   PATCH  /:id            edit, only before it is published
//   POST   /:id/retract    stop showing it
import { Router } from "express";
import { z } from "zod";
import { getPlatformDb as getDb, insertAndGetId } from "../db/connection.js";
import { announceBroadcast, BROADCAST_KINDS, recipientCount, SEVERITIES } from "../services/broadcasts.js";
import { forEachDatabase, tenantDb } from "../services/tenantDatabases.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const isoTime = z
  .string()
  .trim()
  .refine(value => !Number.isNaN(Date.parse(value)), "Enter a valid date and time.")
  .transform(value => new Date(value).toISOString());

const broadcastSchema = z.object({
  kind: z.enum(BROADCAST_KINDS).default("announcement"),
  severity: z.enum(SEVERITIES).default("info"),
  title: z.string().trim().min(1, "Title is required.").max(160, "Use at most 160 characters."),
  body: z.string().trim().min(1, "Message is required.").max(5000, "Use at most 5000 characters."),
  audience: z.enum(["all", "tenants", "users"]).default("all"),
  recipients: z.enum(["admins", "everyone"]).default("admins"),
  tenantIds: z.array(z.number().int().positive()).max(1000).default([]),
  userIds: z.array(z.number().int().positive()).max(1000).default([]),
  /** People by tenant: needed for tenants with their own database (their user ids are only unique inside it) */
  users: z.array(z.object({ tenantId: z.number().int().positive(), userId: z.number().int().positive() })).max(1000).default([]),
  /** null = publish now */
  publishAt: isoTime.nullable().default(null),
  expiresAt: isoTime.nullable().default(null),
});

const listSchema = z.object({ kind: z.enum(["all", "subscription", "provider"]).default("provider") });

const fieldError = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { [field]: message } });

/** Checks the audience and returns the target rows ({ tenant_id, user_id }) to store. */
async function resolveTargets(db, input) {
  if (input.audience === "all") return [];
  if (input.audience === "tenants") {
    const ids = [...new Set(input.tenantIds)];
    if (!ids.length) throw fieldError("tenantIds", "Choose at least one tenant.");
    const found = await db("tenants").whereIn("id", ids).whereNull("deleted_at").select("id");
    if (found.length !== ids.length) throw fieldError("tenantIds", "A chosen tenant no longer exists or is in the recycle bin.");
    return ids.map(id => ({ tenant_id: id, user_id: null }));
  }
  const gone = () => fieldError("userIds", "A chosen person no longer exists or their tenant is in the recycle bin.");
  if (input.users.length) {
    const byTenant = new Map();
    for (const { tenantId, userId } of input.users) byTenant.set(tenantId, new Set([...(byTenant.get(tenantId) ?? []), userId]));
    const live = new Set((await db("tenants").whereIn("id", [...byTenant.keys()]).whereNull("deleted_at").select("id")).map(row => Number(row.id)));
    const rows = [];
    for (const [tenantId, ids] of byTenant) {
      if (!live.has(tenantId)) throw gone();
      const found = await tenantDb(tenantId)("users").where("tenant_id", tenantId).whereIn("id", [...ids]).select("id");
      if (found.length !== ids.size) throw gone();
      rows.push(...found.map(user => ({ tenant_id: tenantId, user_id: user.id })));
    }
    return rows;
  }
  const ids = [...new Set(input.userIds)];
  if (!ids.length) throw fieldError("userIds", "Choose at least one person.");
  // Plain user ids: people in the platform database (tenants with their own database are chosen by tenant and person).
  const found = await db("users as u").join("tenants as t", "t.id", "u.tenant_id").whereIn("u.id", ids).whereNull("t.deleted_at").whereNull("t.database").select("u.id", "u.tenant_id");
  if (found.length !== ids.length) throw gone();
  return found.map(user => ({ tenant_id: user.tenant_id, user_id: user.id }));
}

/** Publish time (now when empty or past) and expiry, checked against each other. */
function schedule(input, now) {
  const publishAt = input.publishAt && input.publishAt > now ? input.publishAt : now;
  if (input.expiresAt && input.expiresAt <= publishAt) throw fieldError("expiresAt", "The expiry must be after the publish time.");
  return { publishAt, expiresAt: input.expiresAt };
}

function stateOf(row, now) {
  if (row.retracted_at) return "retracted";
  if (row.publish_at > now) return "scheduled";
  if (row.expires_at && row.expires_at <= now) return "expired";
  return "live";
}

/** @param {{ requireAdmin: import("express").RequestHandler, audit: Function }} deps */
export function consoleBroadcastsRouter({ requireAdmin, audit }) {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res) => {
    const { kind } = validate(listSchema, req.query);
    const db = getDb();
    const now = nowIso();
    const query = db("provider_broadcasts").orderBy("publish_at", "desc").orderBy("id", "desc").limit(100);
    if (kind === "subscription") query.where("kind", "subscription");
    if (kind === "provider") query.whereNot("kind", "subscription");
    const rows = await query;
    const ids = rows.map(row => row.id);
    const targets = await db("provider_broadcast_targets as bt")
      .leftJoin("tenants as t", "t.id", "bt.tenant_id")
      .whereIn("bt.broadcast_id", ids)
      .select("bt.broadcast_id", "bt.tenant_id", "bt.user_id", "t.name as tenant_name");
    // People's names, and who read what, live in each tenant's database.
    const people = new Map();
    for (const tenantId of new Set(targets.filter(target => target.user_id).map(target => Number(target.tenant_id)))) {
      const userIds = targets.filter(target => target.user_id && Number(target.tenant_id) === tenantId).map(target => target.user_id);
      for (const user of await tenantDb(tenantId)("users").whereIn("id", userIds).select("id", "name", "email")) people.set(`${tenantId}:${user.id}`, user);
    }
    const readsOf = new Map();
    if (ids.length) {
      await forEachDatabase(
        async knex => {
          const rows = await knex("provider_broadcast_reads")
            .whereIn("broadcast_id", ids)
            .select("broadcast_id")
            .count({ reads: "*" })
            .sum({ dismissed: knex.raw("case when dismissed then 1 else 0 end") })
            .groupBy("broadcast_id");
          for (const row of rows) {
            const before = readsOf.get(Number(row.broadcast_id)) ?? { reads: 0, dismissed: 0 };
            readsOf.set(Number(row.broadcast_id), { reads: before.reads + Number(row.reads), dismissed: before.dismissed + Number(row.dismissed ?? 0) });
          }
        },
        { label: "broadcast reads" }
      );
    }
    const items = [];
    for (const row of rows) {
      const state = stateOf(row, now);
      items.push({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        body: row.body,
        audience: row.audience,
        recipients: row.recipients,
        targets: targets
          .filter(target => target.broadcast_id === row.id)
          .map(target => {
            const person = target.user_id ? people.get(`${Number(target.tenant_id)}:${target.user_id}`) : null;
            return { tenantId: target.tenant_id, tenantName: target.tenant_name ?? null, userId: target.user_id ?? null, userName: person?.name ?? null, userEmail: person?.email ?? null };
          }),
        createdBy: row.created_by,
        publishAt: row.publish_at,
        expiresAt: row.expires_at ?? null,
        retractedAt: row.retracted_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        state,
        reads: readsOf.get(row.id)?.reads ?? 0,
        dismissed: readsOf.get(row.id)?.dismissed ?? 0,
        // Who it reaches now; retracted and expired ones don't reach anyone any more.
        recipientCount: state === "live" || state === "scheduled" ? await recipientCount(row) : null,
      });
    }
    res.json({ items });
  });

  router.post("/", async (req, res) => {
    const input = validate(broadcastSchema, req.body ?? {});
    const db = getDb();
    const now = nowIso();
    const { publishAt, expiresAt } = schedule(input, now);
    const targets = await resolveTargets(db, input);
    const id = await db.transaction(async trx => {
      const broadcastId = await insertAndGetId(trx, "provider_broadcasts", {
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        audience: input.audience,
        recipients: input.recipients,
        created_by: req.admin.username,
        publish_at: publishAt,
        expires_at: expiresAt,
        retracted_at: null,
        created_at: now,
        updated_at: now,
      });
      if (targets.length) await trx("provider_broadcast_targets").insert(targets.map(target => ({ broadcast_id: broadcastId, ...target })));
      return broadcastId;
    });
    const row = await db("provider_broadcasts").where({ id }).first();
    const recipients = publishAt <= now ? await announceBroadcast(db, row) : await recipientCount(row);
    await audit(req, "create_broadcast", `broadcasts#${id}`, { title: input.title, audience: input.audience, recipients: input.recipients, scheduled: publishAt > now ? publishAt : undefined });
    res.status(201).json({ id, state: stateOf(row, nowIso()), recipientCount: recipients });
  });

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const db = getDb();
    const existing = await db("provider_broadcasts").where({ id }).first();
    if (!existing || existing.kind === "subscription") throw new HttpError(404, "Not found.");
    const now = nowIso();
    if (existing.retracted_at || existing.publish_at <= now) {
      throw new HttpError(409, "This announcement is already published. Retract it and send a new one instead.", { code: "ALREADY_PUBLISHED" });
    }
    const input = validate(broadcastSchema, req.body ?? {});
    const { publishAt, expiresAt } = schedule(input, now);
    const targets = await resolveTargets(db, input);
    await db.transaction(async trx => {
      await trx("provider_broadcasts").where({ id }).update({
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        audience: input.audience,
        recipients: input.recipients,
        publish_at: publishAt,
        expires_at: expiresAt,
        updated_at: now,
      });
      await trx("provider_broadcast_targets").where({ broadcast_id: id }).del();
      if (targets.length) await trx("provider_broadcast_targets").insert(targets.map(target => ({ broadcast_id: id, ...target })));
    });
    const row = await db("provider_broadcasts").where({ id }).first();
    if (publishAt <= now) await announceBroadcast(db, row); // edited to "publish now"
    await audit(req, "update_broadcast", `broadcasts#${id}`, { title: input.title, audience: input.audience, publishAt });
    res.json({ id, state: stateOf(row, nowIso()) });
  });

  router.post("/:id/retract", async (req, res) => {
    const id = parseId(req.params.id);
    const db = getDb();
    const existing = await db("provider_broadcasts").where({ id }).first();
    if (!existing) throw new HttpError(404, "Not found.");
    if (existing.retracted_at) throw new HttpError(409, "This broadcast is already retracted.", { code: "ALREADY_RETRACTED" });
    const now = nowIso();
    await db("provider_broadcasts").where({ id }).update({ retracted_at: now, updated_at: now });
    await audit(req, "retract_broadcast", `broadcasts#${id}`, { title: existing.title });
    res.json({ id, state: "retracted" });
  });

  return router;
}
