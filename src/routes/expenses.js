// Expense claims: employees submit, admins approve or reject, then mark approved claims paid.
// Categories and the per-claim limit are module settings.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can, requirePermission } from "../middleware/auth.js";
import { notifyUsers } from "../services/notify.js";
import { usersWithPermission } from "../services/permissions.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const MAX_AGE_DAYS = 90;
const settingsOf = req => req.tenant.settings.expenses;
/** People who review or pay claims see everyone's. */
const reviewer = req => can(req, "expenses.approve") || can(req, "expenses.pay");
const round2 = value => Math.round(value * 100) / 100;
const invalid = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { errors: { [field]: message } });

const claimSchema = z.object({
  title: z.string().trim().min(1, "Describe the expense.").max(160),
  category: z.string().trim().min(1, "Pick a category.").max(60),
  amount: z.coerce.number().positive("Enter an amount above zero.").max(1e12).transform(round2),
  spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31."),
  notes: z.string().trim().max(1000).nullable().default(null),
});

const toClaim = row => ({
  id: row.id,
  key: `EXP-${String(row.id).padStart(4, "0")}`,
  user: { id: row.user_id, name: row.user_name, jobTitle: row.user_job_title ?? null },
  title: row.title,
  category: row.category,
  amount: Number(row.amount),
  spentOn: row.spent_on,
  notes: row.notes,
  status: row.status,
  reviewer: row.reviewer_id ? { id: row.reviewer_id, name: row.reviewer_name } : null,
  reviewNote: row.review_note,
  reviewedAt: row.reviewed_at,
  paidAt: row.paid_at,
  createdAt: row.created_at,
});

function baseQuery(db, tenantId) {
  return db("expenses as e")
    .join("users as u", "u.id", "e.user_id")
    .leftJoin("users as r", "r.id", "e.reviewer_id")
    .where("e.tenant_id", tenantId)
    .select("e.*", "u.name as user_name", "u.job_title as user_job_title", "r.name as reviewer_name");
}

/** Validates a claim against the workspace's expense rules. */
function assertClaimRules(req, input) {
  const settings = settingsOf(req);
  if (!settings.categories.includes(input.category)) throw invalid("category", "Pick one of your workspace's categories.");
  if (settings.maxAmount != null && input.amount > settings.maxAmount) throw invalid("amount", `Claims are limited to ${settings.maxAmount} each in your workspace.`);
  const today = new Date().toISOString().slice(0, 10);
  // A day of slack covers time zones ahead of UTC.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (input.spentOn > tomorrow) throw invalid("spentOn", "The date can't be in the future.");
  const age = (new Date(`${today}T00:00:00Z`) - new Date(`${input.spentOn}T00:00:00Z`)) / 86_400_000;
  if (age > MAX_AGE_DAYS) throw invalid("spentOn", `Claims must be submitted within ${MAX_AGE_DAYS} days of the expense.`);
}

router.get("/", async (req, res) => {
  const q = validate(z.object({ scope: z.enum(["mine", "all"]).default("mine"), status: z.enum(["pending", "approved", "rejected", "paid", "cancelled"]).optional() }), req.query);
  const query = baseQuery(getDb(), req.user.tenant_id).orderBy("e.created_at", "desc").limit(300);
  if (q.scope === "mine" || !reviewer(req)) query.where("e.user_id", req.user.id);
  if (q.status) query.where("e.status", q.status);
  res.json((await query).map(toClaim));
});

router.get("/summary", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const total = (query, status) => query.clone().where("status", status).select(db.raw("count(*) as count"), db.raw("coalesce(sum(amount), 0) as amount"));
  const mine = db("expenses").where({ tenant_id: tenantId, user_id: req.user.id });
  const all = db("expenses").where({ tenant_id: tenantId });
  const pick = rows => ({ count: Number(rows[0].count), amount: round2(Number(rows[0].amount)) });
  const [myPending, myApproved, myPaid] = await Promise.all([total(mine, "pending"), total(mine, "approved"), total(mine, "paid")]);
  const result = { mine: { pending: pick(myPending), approved: pick(myApproved), paid: pick(myPaid) } };
  if (reviewer(req)) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const [pending, toPay, paidMonth] = await Promise.all([
      total(all, "pending"),
      total(all, "approved"),
      all.clone().where("status", "paid").where("paid_at", ">=", monthStart).select(db.raw("count(*) as count"), db.raw("coalesce(sum(amount), 0) as amount")),
    ]);
    result.team = { pending: pick(pending), toPay: pick(toPay), paidThisMonth: pick(paidMonth) };
  }
  res.json(result);
});

router.post("/", requirePermission("expenses.submit"), async (req, res) => {
  const input = validate(claimSchema, req.body);
  assertClaimRules(req, input);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const id = await db.transaction(async trx => {
    const claimId = await insertAndGetId(trx, "expenses", {
      tenant_id: tenantId,
      user_id: req.user.id,
      title: input.title,
      category: input.category,
      amount: input.amount,
      spent_on: input.spentOn,
      notes: input.notes || null,
      status: "pending",
      created_at: nowIso(),
    });
    await notifyUsers(trx, await usersWithPermission(trx, tenantId, "expenses.approve"), { title: "Expense claim to review", body: `${req.user.name} claimed ${input.amount} for "${input.title}"`, actorId: req.user.id });
    return claimId;
  });
  res.status(201).json(toClaim(await baseQuery(db, tenantId).where("e.id", id).first()));
});

// pending -> approved | rejected (admin, not own) | cancelled (owner); approved -> paid (admin)
router.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(z.object({ status: z.enum(["approved", "rejected", "paid", "cancelled"]), reviewNote: z.string().trim().max(300).nullable().default(null) }), req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const claim = await db("expenses").where({ id, tenant_id: tenantId }).first();
  if (!claim) throw new HttpError(404, "Expense claim not found.");
  const now = nowIso();
  const changes = { status: input.status };

  if (input.status === "cancelled") {
    if (claim.user_id !== req.user.id) throw new HttpError(403, "Only the person who submitted a claim can cancel it.", { code: "FORBIDDEN" });
    if (claim.status !== "pending") throw new HttpError(422, "Only pending claims can be cancelled.", { code: "INVALID_TRANSITION" });
  } else {
    const needed = input.status === "paid" ? "expenses.pay" : "expenses.approve";
    if (!can(req, needed)) throw new HttpError(403, input.status === "paid" ? "You don't have permission to pay claims." : "You don't have permission to approve claims.", { code: "FORBIDDEN" });
    if (claim.user_id === req.user.id) throw new HttpError(422, "Another admin must review your own claim.", { code: "SELF_APPROVAL" });
    if (input.status === "paid") {
      if (claim.status !== "approved") throw new HttpError(422, "Only approved claims can be marked paid.", { code: "INVALID_TRANSITION" });
      changes.paid_at = now;
    } else {
      if (claim.status !== "pending") throw new HttpError(422, "This claim has already been reviewed.", { code: "INVALID_TRANSITION" });
      Object.assign(changes, { reviewer_id: req.user.id, review_note: input.reviewNote || null, reviewed_at: now });
    }
  }

  await db.transaction(async trx => {
    await trx("expenses").where({ id }).update(changes);
    if (input.status !== "cancelled") {
      const verb = input.status === "paid" ? "paid" : input.status;
      await notifyUsers(trx, [claim.user_id], {
        title: `Expense ${verb}: ${claim.title}`,
        body: `${req.user.name} ${verb} your claim of ${Number(claim.amount)}${input.reviewNote ? `: ${input.reviewNote}` : ""}`,
        actorId: req.user.id,
      });
    }
  });
  if (input.status !== "cancelled") {
    const person = await db("users").where({ id: claim.user_id }).first();
    await recordTenantAudit(db, req, `expense.${input.status === "approved" ? "approve" : input.status === "rejected" ? "reject" : "pay"}`, person?.name, { title: claim.title, amount: Number(claim.amount) });
  }
  res.json(toClaim(await baseQuery(db, tenantId).where("e.id", id).first()));
});

export default router;
