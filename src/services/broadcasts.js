// Provider broadcasts: the console's own announcements to every tenant, chosen tenants, or individual people, plus the
// automatic "your subscription ends in N days" notices to each tenant's admins.
//
// A broadcast reaches a person when it is published (publish_at <= now), not retracted, not expired, and targets them:
//   audience all      every tenant;      recipients admins = owners + holders of workspace.users.manage, or everyone
//   audience tenants  target rows with tenant_id and user_id null (same recipients rule)
//   audience users    target rows with user_id (recipients is ignored: those people exactly)
// Deleted tenants can't sign in, so they never see anything. Live updates: "broadcast.published" to the recipients.
//
// Broadcasts and their targets live in the platform database; who read or dismissed one lives with the person, in their
// tenant's database (the platform one, or the tenant's own: services/tenantDatabases.js).
import { getPlatformDb, insertAndGetId } from "../db/connection.js";
import { nowIso } from "../utils/http.js";
import { notifyUsers } from "./notify.js";
import { usersWithPermission } from "./permissions.js";
import { publish } from "./realtime.js";
import { runInTenant, tenantDb } from "./tenantDatabases.js";
import { NOTICE_THRESHOLDS, addDaysTo, subscriptionSummary, utcToday } from "./subscriptionDates.js";

export const ADMIN_PERMISSION = "workspace.users.manage";
export const BROADCAST_KINDS = Object.freeze(["announcement", "maintenance"]);
export const SEVERITIES = Object.freeze(["info", "warning", "critical"]);

/** Owners and people who manage users count as the tenant's admins. */
export const isTenantAdmin = access => Boolean(access?.isOwner || access?.permissions?.includes(ADMIN_PERMISSION));

/** Restricts a provider_broadcasts query (aliased b) to the ones live at `now`. */
export function whereLive(query, now = nowIso()) {
  return query
    .where("b.publish_at", "<=", now)
    .whereNull("b.retracted_at")
    .where(inner => inner.whereNull("b.expires_at").orWhere("b.expires_at", ">", now));
}

/** Restricts a provider_broadcasts query (aliased b) to the ones addressed to this person. */
export function whereAddressedTo(db, query, { tenantId, userId, isAdmin }) {
  const targets = () => db("provider_broadcast_targets as bt").whereRaw("bt.broadcast_id = b.id");
  return query.where(inner =>
    inner
      .where(all => {
        all.where("b.audience", "all");
        if (!isAdmin) all.where("b.recipients", "everyone");
      })
      .orWhere(tenants => {
        tenants.where("b.audience", "tenants").whereExists(targets().where("bt.tenant_id", tenantId).whereNull("bt.user_id"));
        if (!isAdmin) tenants.where("b.recipients", "everyone");
      })
      // The tenant too: tenants with their own database number their people independently.
      .orWhere(users => users.where("b.audience", "users").whereExists(targets().where("bt.user_id", userId).where("bt.tenant_id", tenantId)))
  );
}

/** The tenant app's view of a broadcast. */
export const toInboxItem = row => ({
  id: row.id,
  kind: row.kind,
  severity: row.severity,
  title: row.title,
  body: row.body,
  publishAt: row.publish_at,
  expiresAt: row.expires_at ?? null,
  isRead: Boolean(row.read_at),
  dismissed: Boolean(row.dismissed),
});

/**
 * Live broadcasts for one person, newest first, with their read / dismissed state.
 * @param {import("knex").Knex} db the person's database (where their read state is)
 */
export async function inboxFor(db, person, now = nowIso()) {
  const platform = getPlatformDb();
  const query = platform("provider_broadcasts as b").select("b.*").orderBy("b.publish_at", "desc").orderBy("b.id", "desc").limit(50);
  const rows = await whereAddressedTo(platform, whereLive(query, now), person);
  const ids = rows.map(row => row.id);
  const reads = ids.length ? await db("provider_broadcast_reads").where("user_id", person.userId).whereIn("broadcast_id", ids).select("broadcast_id", "read_at", "dismissed") : [];
  const readOf = new Map(reads.map(read => [Number(read.broadcast_id), read]));
  return rows.map(row => toInboxItem({ ...row, read_at: readOf.get(row.id)?.read_at ?? null, dismissed: readOf.get(row.id)?.dismissed ?? false }));
}

/**
 * Who a broadcast reaches right now (active people of tenants that aren't deleted), per tenant: tenantId -> user ids.
 * Each tenant's people are read from that tenant's database.
 */
export async function recipientsByTenant(broadcast) {
  const platform = getPlatformDb();
  const live = new Set((await platform("tenants").whereNull("deleted_at").select("id")).map(row => Number(row.id)));
  const result = new Map();
  if (broadcast.audience === "users") {
    const targets = await platform("provider_broadcast_targets").where({ broadcast_id: broadcast.id }).whereNotNull("user_id").select("tenant_id", "user_id");
    const byTenant = new Map();
    for (const target of targets) {
      const tenantId = Number(target.tenant_id);
      if (live.has(tenantId)) byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), Number(target.user_id)]);
    }
    for (const [tenantId, ids] of byTenant) {
      const rows = await tenantDb(tenantId)("users").where({ tenant_id: tenantId, is_active: true }).whereIn("id", ids).select("id");
      if (rows.length) result.set(tenantId, rows.map(row => Number(row.id)));
    }
    return result;
  }
  const tenantIds =
    broadcast.audience === "all"
      ? [...live]
      : (await platform("provider_broadcast_targets").where("broadcast_id", broadcast.id).whereNull("user_id").distinct("tenant_id")).map(row => Number(row.tenant_id)).filter(id => live.has(id));
  for (const tenantId of tenantIds) {
    const db = tenantDb(tenantId);
    const ids = broadcast.recipients === "everyone" ? (await db("users").where({ tenant_id: tenantId, is_active: true }).select("id")).map(row => Number(row.id)) : await usersWithPermission(db, tenantId, ADMIN_PERMISSION);
    if (ids.length) result.set(tenantId, ids);
  }
  return result;
}

/** How many people a broadcast reaches right now. */
export async function recipientCount(broadcast) {
  let count = 0;
  for (const ids of (await recipientsByTenant(broadcast)).values()) count += ids.length;
  return count;
}

// ---- Publishing: "publish now" broadcasts are announced when created; scheduled ones by the scheduler. ----
/** Broadcasts already announced over realtime, id -> publish_at (pruned as the check window moves on). */
const announced = new Map();
let lastCheck = nowIso();

/** Tells the recipients' browsers to refresh their inbox (best-effort; they also poll). */
export async function announceBroadcast(db, broadcast) {
  announced.set(broadcast.id, broadcast.publish_at);
  let count = 0;
  for (const [tenantId, users] of await recipientsByTenant(broadcast)) {
    // Inside the tenant's database context: live updates match people by id within that database.
    runInTenant(tenantId, () => publish({ users }, "broadcast.published", { id: broadcast.id }));
    count += users.length;
  }
  return count;
}

/** Announces scheduled broadcasts whose time has come since the last check. Returns how many. */
export async function publishDueBroadcasts(now = nowIso()) {
  const db = getPlatformDb();
  const since = lastCheck;
  lastCheck = now;
  const due = await whereLive(db("provider_broadcasts as b").select("b.*"), now).where("b.publish_at", ">", since);
  let count = 0;
  for (const broadcast of due) {
    if (announced.has(broadcast.id)) continue;
    await announceBroadcast(db, broadcast);
    count++;
  }
  for (const [id, publishAt] of announced) if (publishAt <= since) announced.delete(id);
  return count;
}

// ---- Subscription notices ----
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const formatDay = day => dayFormat.format(new Date(`${day}T00:00:00Z`));

/** Which automatic notice is due: the tightest threshold the days left fall under, "expired" after the end date. */
export function thresholdFor(daysLeft) {
  if (daysLeft == null) return null;
  if (daysLeft < 0) return "expired";
  const hit = [...NOTICE_THRESHOLDS].sort((a, b) => a - b).find(days => daysLeft <= days);
  return hit === undefined ? null : `d${hit}`;
}

/** Title, body, and severity of a subscription notice. */
export function subscriptionMessage(summary, today = utcToday()) {
  const plan = summary.plan ? `${summary.plan} plan` : "subscription";
  const ends = formatDay(summary.endsOn);
  const grace = summary.graceDays > 0 ? ` After that you have ${summary.graceDays} grace day${summary.graceDays === 1 ? "" : "s"} before sign-in stops.` : " After that nobody can sign in.";
  const renew = " Contact your provider to renew.";
  const days = summary.daysLeft;
  if (days < 0) {
    const inGrace = today <= summary.graceEndsOn;
    return {
      severity: "critical",
      title: inGrace ? "Your subscription has ended" : "Your subscription has expired",
      body: inGrace
        ? `Your ${plan} ended on ${ends}. Everyone can keep working until ${formatDay(summary.graceEndsOn)}; after that nobody can sign in.${renew}`
        : `Your ${plan} ended on ${ends} and the grace period is over.${renew}`,
    };
  }
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return {
    severity: days <= 1 ? "critical" : days <= 7 ? "warning" : "info",
    title: `Your subscription ends ${when}`,
    body: `Your ${plan} ends on ${ends}.${grace}${renew}`,
  };
}

/** Earlier subscription notices of a tenant stop showing (a newer one replaces them, or the dates changed). */
export async function expireSubscriptionNotices(_db, tenantId, now = nowIso()) {
  await getPlatformDb()("provider_broadcasts")
    .where("kind", "subscription")
    .whereNull("retracted_at")
    .where(inner => inner.whereNull("expires_at").orWhere("expires_at", ">", now))
    .whereIn("id", sub => sub.select("broadcast_id").from("provider_broadcast_targets").where("tenant_id", tenantId))
    .update({ expires_at: now, updated_at: now });
}

/**
 * Sends a subscription notice to a tenant's admins now: a broadcast (banner + provider panel) and an in-app notification.
 * @returns {Promise<{ broadcastId: number, recipients: number } | null>} null when the tenant has no end date
 */
export async function sendSubscriptionNotice(_db, tenant, { createdBy = "system", today = utcToday() } = {}) {
  const db = getPlatformDb();
  const summary = subscriptionSummary(tenant, today);
  if (!summary.endsOn) return null;
  const message = subscriptionMessage(summary, today);
  const now = nowIso();
  await expireSubscriptionNotices(db, tenant.id, now);
  const broadcastId = await insertAndGetId(db, "provider_broadcasts", {
    kind: "subscription",
    severity: message.severity,
    title: message.title,
    body: message.body,
    audience: "tenants",
    recipients: "admins",
    created_by: createdBy,
    publish_at: now,
    expires_at: `${addDaysTo(summary.graceEndsOn, 1)}T00:00:00.000Z`, // once access has stopped, nobody can read it anyway
    retracted_at: null,
    created_at: now,
    updated_at: now,
  });
  await db("provider_broadcast_targets").insert({ broadcast_id: broadcastId, tenant_id: tenant.id, user_id: null });
  // The tenant's admins, their notifications, and live updates: in the tenant's own database.
  const admins = await runInTenant(tenant.id, async () => {
    const people = tenantDb(tenant.id);
    const ids = await usersWithPermission(people, tenant.id, ADMIN_PERMISSION);
    await notifyUsers(people, ids, { title: message.title, body: message.body });
    if (ids.length) publish({ users: ids }, "broadcast.published", { id: broadcastId });
    return ids;
  });
  announced.set(broadcastId, now);
  return { broadcastId, recipients: admins.length };
}

/** Records that a notice was sent; false when it already was (the unique index on tenant, end date, threshold decides). */
async function claimNotice(db, tenantId, endsOn, threshold) {
  try {
    return await insertAndGetId(db, "subscription_notices", { tenant_id: tenantId, ends_on: endsOn, threshold, broadcast_id: null, created_at: nowIso() });
  } catch {
    return null;
  }
}

let noticesRunning = false;

/**
 * Sends the automatic notices that are due (30, 14, 7, 3, 1, 0 days before the end date, and once after it), once each
 * per tenant and end date. Active, non-deleted tenants only. Safe to run often. Returns how many were sent.
 */
export async function processSubscriptionNotices(today = utcToday()) {
  if (noticesRunning) return 0;
  noticesRunning = true;
  let sent = 0;
  try {
    const db = getPlatformDb();
    const tenants = await db("tenants").whereNull("deleted_at").where("status", "active").whereNotNull("subscription_ends_on");
    for (const tenant of tenants) {
      const threshold = thresholdFor(subscriptionSummary(tenant, today).daysLeft);
      if (!threshold) continue;
      const noticeId = await claimNotice(db, tenant.id, tenant.subscription_ends_on, threshold);
      if (!noticeId) continue;
      const result = await sendSubscriptionNotice(db, tenant, { today });
      if (result) await db("subscription_notices").where({ id: noticeId }).update({ broadcast_id: result.broadcastId });
      sent++;
    }
    return sent;
  } catch (error) {
    console.error("[subscriptions]", error.message);
    return sent;
  } finally {
    noticesRunning = false;
  }
}

// ---- Scheduler: scheduled broadcasts every minute, subscription notices about hourly ----
const TICK_MS = 60_000;
const NOTICES_MS = 60 * 60_000;
let timer = null;
let lastNotices = 0;

async function tick() {
  try {
    await publishDueBroadcasts();
  } catch (error) {
    console.error("[broadcasts]", error.message);
  }
  if (Date.now() - lastNotices >= NOTICES_MS) {
    lastNotices = Date.now();
    await processSubscriptionNotices();
  }
}

export function startBroadcastScheduler() {
  if (timer) return;
  lastCheck = nowIso();
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

export function stopBroadcastScheduler() {
  clearInterval(timer);
  timer = null;
}
