// The tenant app's inbox of provider broadcasts (mounted at /api/broadcasts behind requireAuth).
//   GET  /                 live broadcasts addressed to me, plus my workspace's subscription (admins only)
//   POST /:id/read         mark one read
//   POST /:id/dismiss      hide it from the banner (also marks it read)
import { Router } from "express";
import { getDb, getPlatformDb } from "../db/connection.js";
import { inboxFor, isTenantAdmin, whereAddressedTo, whereLive } from "../services/broadcasts.js";
import { subscriptionSummary } from "../services/subscriptionDates.js";
import { HttpError, nowIso, parseId } from "../utils/http.js";

const router = Router();

const personOf = req => ({ tenantId: req.user.tenant_id, userId: req.user.id, isAdmin: isTenantAdmin(req.access) });

router.get("/", async (req, res) => {
  const db = getDb();
  const person = personOf(req);
  const items = await inboxFor(db, person);
  let subscription = null;
  if (person.isAdmin) {
    const tenant = await db("tenants").where({ id: person.tenantId }).first("plan", "subscription_starts_on", "subscription_ends_on", "grace_days");
    if (tenant) subscription = subscriptionSummary(tenant);
  }
  res.json({ items, unread: items.filter(item => !item.isRead).length, subscription });
});

async function markRead(req, dismissed) {
  const id = parseId(req.params.id);
  const db = getDb();
  // The broadcast is the provider's (platform database); the read state is the person's (their tenant's database).
  const platform = getPlatformDb();
  const query = whereAddressedTo(platform, whereLive(platform("provider_broadcasts as b").where("b.id", id)), personOf(req));
  if (!(await query.first("b.id"))) throw new HttpError(404, "Not found.");
  const row = { broadcast_id: id, user_id: req.user.id, read_at: nowIso(), dismissed };
  const insert = db("provider_broadcast_reads").insert(row).onConflict(["broadcast_id", "user_id"]);
  await (dismissed ? insert.merge({ dismissed: true }) : insert.ignore()); // the first read time is kept
  return id;
}

router.post("/:id/read", async (req, res) => {
  const id = await markRead(req, false);
  res.json({ id, isRead: true });
});

router.post("/:id/dismiss", async (req, res) => {
  const id = await markRead(req, true);
  res.json({ id, isRead: true, dismissed: true });
});

export default router;
