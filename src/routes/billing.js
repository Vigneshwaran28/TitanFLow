// Billing: quotes and invoices with priced lines, payments against invoices, and what's outstanding.
// Invoice: draft -> sent -> partially_paid -> paid, or void. Quote: draft -> sent -> accepted | declined, accepted -> converted.
// Only drafts can be edited or deleted; numbers (INV-0001, QT-0001) are allocated per tenant and kind when a draft is created.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { requirePermission } from "../middleware/auth.js";
import { addDays, daysBetween, isUniqueViolation, nextNumber, priceLines, round2, todayIso } from "../services/billing.js";
import { notifyUsers } from "../services/notify.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

export const KINDS = ["invoice", "quote"];
export const INVOICE_STATUSES = ["draft", "sent", "partially_paid", "paid", "void"];
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "converted"];
/** Invoices that are issued and still owe money. */
const OPEN_STATUSES = ["sent", "partially_paid"];

const settingsOf = req => req.tenant.settings.billing;
const prefixFor = (req, kind) => (kind === "quote" ? settingsOf(req).quotePrefix : settingsOf(req).invoicePrefix);
const invalid = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { errors: { [field]: message } });
const conflict = (code, message) => new HttpError(409, message, { code });
const label = kind => (kind === "quote" ? "quote" : "invoice");

const money = z.coerce.number().min(0, "Can't be negative.").max(1e12).transform(round2);
const percent = z.coerce.number().min(0, "Use 0 to 100.").max(100, "Use 0 to 100.");
const optionalText = max => z.string().trim().max(max).nullable().default(null);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.");

const lineSchema = z.object({
  productId: z.number().int().positive().nullable().default(null),
  description: z.string().trim().max(300).default(""),
  quantity: z.coerce.number().positive("Enter a quantity above zero.").max(1e7),
  unit: z.string().trim().max(20).nullable().default(null),
  unitPrice: money.optional(), // falls back to the product's sale price
  discountPct: percent.default(0),
  taxRate: percent.optional(), // falls back to the workspace's default tax rate
});

const billToSchema = z.object({
  name: z.string().trim().min(1, "Enter who the document is for.").max(160),
  email: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable().default(null),
  phone: optionalText(40),
  address: optionalText(500),
  taxId: optionalText(40),
});

const documentSchema = z.object({
  kind: z.enum(KINDS).default("invoice"),
  customerId: z.number().int().positive().nullable().default(null),
  billTo: billToSchema.nullable().default(null),
  issueDate: dateOnly.nullable().default(null),
  dueDate: dateOnly.nullable().default(null),
  notes: z.string().trim().max(5000).nullable().optional(), // left out = the workspace default
  terms: z.string().trim().max(5000).nullable().optional(),
  items: z.array(lineSchema).min(1, "Add at least one line.").max(200, "At most 200 lines."),
});

const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(160),
  company: optionalText(160),
  email: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable().default(null),
  phone: optionalText(40),
  address: optionalText(300),
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive("Enter an amount above zero.").max(1e12).transform(round2),
  method: z.string().trim().min(1, "Pick a payment method.").max(20),
  paidOn: dateOnly,
  reference: optionalText(120),
  notes: optionalText(300),
});

/** True when an issued invoice is past its due date and still owes money. */
const isOverdue = (row, today = todayIso()) => row.kind === "invoice" && OPEN_STATUSES.includes(row.status) && Boolean(row.due_date) && row.due_date < today;

// ---- Mapping ----
const toLine = row => ({
  id: row.id,
  productId: row.product_id,
  sku: row.sku ?? null,
  position: row.position,
  description: row.description,
  quantity: Number(row.quantity),
  unit: row.unit,
  unitPrice: Number(row.unit_price),
  discountPct: Number(row.discount_pct),
  taxRate: Number(row.tax_rate),
  lineSubtotal: Number(row.line_subtotal),
  lineTax: Number(row.line_tax),
  lineTotal: Number(row.line_total),
});

const toPayment = row => ({
  id: row.id,
  amount: Number(row.amount),
  method: row.method,
  paidOn: row.paid_on,
  reference: row.reference,
  notes: row.notes,
  recordedBy: row.recorded_by ? { id: row.recorded_by, name: row.recorded_by_name } : null,
  createdAt: row.created_at,
});

const toDocument = (row, today = todayIso()) => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  status: row.status,
  customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, company: row.customer_company } : null,
  billTo: { name: row.bill_to_name, email: row.bill_to_email, phone: row.bill_to_phone, address: row.bill_to_address, taxId: row.bill_to_tax_id },
  issueDate: row.issue_date,
  dueDate: row.due_date,
  currency: row.currency,
  subtotal: Number(row.subtotal),
  discountTotal: Number(row.discount_total),
  taxTotal: Number(row.tax_total),
  total: Number(row.total),
  amountPaid: Number(row.amount_paid),
  balance: row.kind === "invoice" && row.status !== "void" ? round2(Number(row.total) - Number(row.amount_paid)) : 0,
  isOverdue: isOverdue(row, today),
  isExpired: row.kind === "quote" && row.status === "sent" && Boolean(row.due_date) && row.due_date < today,
  notes: row.notes,
  terms: row.terms,
  sourceQuoteId: row.source_quote_id,
  orderId: row.order_id,
  itemCount: Number(row.item_count ?? 0),
  createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
  sentAt: row.sent_at,
  paidAt: row.paid_at,
  voidedAt: row.voided_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function documentsQuery(db, tenantId) {
  const itemCount = db("invoice_items").count("*").whereRaw("invoice_items.invoice_id = i.id").as("item_count");
  return db("invoices as i")
    .leftJoin("customers as c", "c.id", "i.customer_id")
    .leftJoin("users as u", "u.id", "i.created_by")
    .where("i.tenant_id", tenantId)
    .select("i.*", "c.name as customer_name", "c.company as customer_company", "u.name as created_by_name", itemCount);
}

async function findDocument(db, tenantId, id) {
  const row = await db("invoices").where({ id, tenant_id: tenantId }).first();
  if (!row) throw new HttpError(404, "Invoice or quote not found.");
  return row;
}

/** Everything the detail screen and the printable document need. */
async function loadDocument(db, req, id) {
  const tenantId = req.user.tenant_id;
  const row = await documentsQuery(db, tenantId).where("i.id", id).first();
  if (!row) throw new HttpError(404, "Invoice or quote not found.");
  const [items, payments, customer, sourceQuote, converted] = await Promise.all([
    db("invoice_items as l").leftJoin("products as p", "p.id", "l.product_id").where("l.invoice_id", id).select("l.*", "p.sku").orderBy("l.position").orderBy("l.id"),
    db("invoice_payments as p").leftJoin("users as u", "u.id", "p.recorded_by").where("p.invoice_id", id).select("p.*", "u.name as recorded_by_name").orderBy("p.paid_on").orderBy("p.id"),
    row.customer_id ? db("customers").where({ id: row.customer_id, tenant_id: tenantId }).first() : null,
    row.source_quote_id ? db("invoices").where({ id: row.source_quote_id, tenant_id: tenantId }).select("id", "number").first() : null,
    row.kind === "quote" ? db("invoices").where({ tenant_id: tenantId, source_quote_id: id }).orderBy("id", "desc").select("id", "number").first() : null,
  ]);
  const company = req.tenant.settings.company;
  return {
    ...toDocument(row),
    customer: customer ? { id: customer.id, name: customer.name, company: customer.company, email: customer.email, phone: customer.phone, address: customer.address } : null,
    items: items.map(toLine),
    payments: payments.map(toPayment),
    sourceQuote: sourceQuote ? { id: sourceQuote.id, number: sourceQuote.number } : null,
    convertedInvoice: converted ? { id: converted.id, number: converted.number } : null,
    order: row.order_id ? { id: row.order_id, key: `SO-${String(row.order_id).padStart(4, "0")}` } : null,
    taxLabel: settingsOf(req).taxLabel,
    company: { ...company, legalName: company.legalName || req.tenant.name },
  };
}

// ---- Building documents ----
/** Customer snapshot for bill_to_*, with any explicit billTo fields on top. */
async function resolveBillTo(db, tenantId, customerId, billTo) {
  let customer = null;
  if (customerId != null) {
    customer = await db("customers").where({ id: customerId, tenant_id: tenantId }).first();
    if (!customer) throw invalid("customerId", "Choose an existing customer.");
  }
  const name = billTo?.name || customer?.name;
  if (!name) throw invalid("billTo", "Choose a customer or enter who the document is for.");
  return {
    customer_id: customer?.id ?? null,
    bill_to_name: name,
    bill_to_email: billTo?.email || customer?.email || null,
    bill_to_phone: billTo?.phone || customer?.phone || null,
    bill_to_address: billTo?.address || customer?.address || null,
    bill_to_tax_id: billTo?.taxId || null,
  };
}

/** Resolves lines against the tenant's products (name, price, and unit fill in blanks) and prices them. */
async function buildLines(db, req, items) {
  const tenantId = req.user.tenant_id;
  const ids = [...new Set(items.map(item => item.productId).filter(Boolean))];
  const products = ids.length ? await db("products").where("tenant_id", tenantId).whereIn("id", ids) : [];
  const byId = new Map(products.map(product => [product.id, product]));
  const resolved = items.map((item, index) => {
    const product = item.productId ? byId.get(item.productId) : null;
    if (item.productId && !product) throw invalid("items", `Line ${index + 1}: that product no longer exists.`);
    const description = item.description || product?.name;
    if (!description) throw invalid("items", `Line ${index + 1}: add a description or pick a product.`);
    return {
      product_id: product?.id ?? null,
      description,
      quantity: item.quantity,
      unit: item.unit || product?.unit || null,
      unit_price: item.unitPrice ?? round2(product?.sale_price ?? 0),
      discount_pct: item.discountPct,
      tax_rate: item.taxRate ?? settingsOf(req).defaultTaxRate,
    };
  });
  return priceLines(resolved);
}

const lineColumns = line => ({
  product_id: line.product_id,
  position: line.position,
  description: line.description,
  quantity: line.quantity,
  unit: line.unit,
  unit_price: line.unit_price,
  discount_pct: line.discount_pct,
  tax_rate: line.tax_rate,
  line_subtotal: line.line_subtotal,
  line_tax: line.line_tax,
  line_total: line.line_total,
});

/** Copies stored lines (for duplicates, conversions) in the shape priceLines expects. */
const copyLines = rows =>
  priceLines(
    rows.map(row => ({
      product_id: row.product_id,
      description: row.description,
      quantity: Number(row.quantity),
      unit: row.unit,
      unit_price: Number(row.unit_price),
      discount_pct: Number(row.discount_pct),
      tax_rate: Number(row.tax_rate),
    }))
  );

/** Default due date (invoice) or valid-until date (quote) for an issue date. */
const defaultDueDate = (req, kind, issueDate) => addDays(issueDate, kind === "quote" ? settingsOf(req).quoteValidityDays : settingsOf(req).paymentTermsDays);

/**
 * Inserts a draft with the next number for its kind. The number is picked inside the transaction;
 * if another request took it first (unique violation) the whole insert is retried once.
 * @param {(trx: import("knex").Knex.Transaction, id: number) => Promise<void>} [after] - extra writes in the same transaction
 */
async function insertDraft(db, req, fields, priced, after) {
  const tenantId = req.user.tenant_id;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async trx => {
        const now = nowIso();
        const id = await insertAndGetId(trx, "invoices", {
          tenant_id: tenantId,
          ...fields,
          number: await nextNumber(trx, tenantId, fields.kind, prefixFor(req, fields.kind)),
          status: "draft",
          currency: req.tenant.settings.company.currency,
          ...priced.totals,
          amount_paid: 0,
          created_by: req.user.id,
          created_at: now,
          updated_at: now,
        });
        await trx("invoice_items").insert(priced.lines.map(line => ({ ...lineColumns(line), invoice_id: id })));
        if (after) await after(trx, id);
        return id;
      });
    } catch (error) {
      if (attempt > 0 || !isUniqueViolation(error)) throw error;
    }
  }
}

function assertDates(issueDate, dueDate) {
  if (dueDate && dueDate < issueDate) throw invalid("dueDate", "The due date can't be before the issue date.");
}

/** 409 unless the document is in one of the given statuses. */
function assertStatus(doc, allowed, action) {
  if (allowed.includes(doc.status)) return;
  const names = allowed.map(status => status.replace("_", " "));
  throw conflict("INVALID_STATUS", `This ${label(doc.kind)} is ${doc.status.replace("_", " ")}. Only ${names.join(" or ")} ${label(doc.kind)}s can be ${action}.`);
}

function assertKind(doc, kind, action) {
  if (doc.kind !== kind) throw conflict("WRONG_KIND", `Only ${kind}s can be ${action}.`);
}

// ---- Summary ----
router.get("/summary", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const [open, paidMonth, drafts, recent, top] = await Promise.all([
    db("invoices").where({ tenant_id: tenantId, kind: "invoice" }).whereIn("status", OPEN_STATUSES).select("due_date", "total", "amount_paid"),
    db("invoice_payments").where("tenant_id", tenantId).where("paid_on", ">=", monthStart).select(db.raw("coalesce(sum(amount), 0) as amount")),
    db("invoices").where({ tenant_id: tenantId, status: "draft" }).count({ count: "*" }),
    db("invoice_payments as p")
      .join("invoices as i", "i.id", "p.invoice_id")
      .leftJoin("users as u", "u.id", "p.recorded_by")
      .where("p.tenant_id", tenantId)
      .select("p.*", "i.number", "i.bill_to_name", "u.name as recorded_by_name")
      .orderBy("p.paid_on", "desc")
      .orderBy("p.id", "desc")
      .limit(5),
    db("invoices as i")
      .join("customers as c", "c.id", "i.customer_id")
      .where({ "i.tenant_id": tenantId, "i.kind": "invoice" })
      .whereNotIn("i.status", ["draft", "void"])
      .where("i.issue_date", ">=", yearStart)
      .groupBy("c.id", "c.name")
      .select("c.id", "c.name")
      .count({ count: "i.id" })
      .sum({ total: "i.total" })
      .orderBy("total", "desc")
      .limit(5),
  ]);

  // Aging buckets by days past due; invoices not yet due (or without a due date) are current.
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const overdue = { count: 0, amount: 0 };
  let outstanding = 0;
  for (const row of open) {
    const balance = round2(Number(row.total) - Number(row.amount_paid));
    outstanding += balance;
    const late = row.due_date ? daysBetween(row.due_date, today) : 0;
    const bucket = late <= 0 ? "current" : late <= 30 ? "d1_30" : late <= 60 ? "d31_60" : late <= 90 ? "d61_90" : "d90_plus";
    aging[bucket] = round2(aging[bucket] + balance);
    if (late > 0) {
      overdue.count += 1;
      overdue.amount = round2(overdue.amount + balance);
    }
  }

  res.json({
    currency: req.tenant.settings.company.currency,
    outstanding: round2(outstanding),
    overdue,
    paidThisMonth: round2(Number(paidMonth[0].amount)),
    draftCount: Number(drafts[0].count),
    aging,
    recentPayments: recent.map(row => ({ ...toPayment(row), invoice: { id: row.invoice_id, number: row.number, billToName: row.bill_to_name } })),
    topCustomers: top.map(row => ({ id: row.id, name: row.name, invoiceCount: Number(row.count), total: round2(Number(row.total)) })),
  });
});

// ---- Documents ----
const listSchema = z.object({
  kind: z.enum(KINDS).optional(),
  status: z.enum([...new Set([...INVOICE_STATUSES, ...QUOTE_STATUSES])]).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  overdue: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Applies the list filters shared by the list and the CSV export. */
function filterDocuments(query, q) {
  if (q.kind) query.where("i.kind", q.kind);
  if (q.status) query.where("i.status", q.status);
  if (q.customerId) query.where("i.customer_id", q.customerId);
  if (q.from) query.where("i.issue_date", ">=", q.from);
  if (q.to) query.where("i.issue_date", "<=", q.to);
  if (q.overdue === "true") query.where("i.kind", "invoice").whereIn("i.status", OPEN_STATUSES).whereNotNull("i.due_date").where("i.due_date", "<", todayIso());
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner =>
      inner.whereRaw("lower(i.number) like ?", [term]).orWhereRaw("lower(i.bill_to_name) like ?", [term]).orWhereRaw("lower(coalesce(i.bill_to_email, '')) like ?", [term])
    );
  }
  return query;
}

router.get("/documents", async (req, res) => {
  const q = validate(listSchema, req.query);
  const query = filterDocuments(documentsQuery(getDb(), req.user.tenant_id), q);
  const [{ total }] = await query.clone().clearSelect().count({ total: "i.id" });
  const rows = await query.orderBy("i.issue_date", "desc").orderBy("i.id", "desc").limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const today = todayIso();
  res.json({ items: rows.map(row => toDocument(row, today)), page: q.page, pageSize: q.pageSize, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / q.pageSize)) });
});

router.get("/documents/:id", async (req, res) => {
  res.json(await loadDocument(getDb(), req, parseId(req.params.id)));
});

router.post("/documents", requirePermission("billing.edit"), async (req, res) => {
  const input = validate(documentSchema, req.body);
  const db = getDb();
  const settings = settingsOf(req);
  const issueDate = input.issueDate ?? todayIso();
  const dueDate = input.dueDate ?? defaultDueDate(req, input.kind, issueDate);
  assertDates(issueDate, dueDate);
  const billTo = await resolveBillTo(db, req.user.tenant_id, input.customerId, input.billTo);
  const priced = await buildLines(db, req, input.items);
  const id = await insertDraft(db, req, {
    kind: input.kind,
    ...billTo,
    issue_date: issueDate,
    due_date: dueDate,
    notes: input.notes === undefined ? settings.defaultNotes || null : input.notes || null,
    terms: input.terms === undefined ? settings.defaultTerms || null : input.terms || null,
  }, priced);
  res.status(201).json(await loadDocument(db, req, id));
});

router.patch("/documents/:id", requirePermission("billing.edit"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findDocument(db, tenantId, id);
  if (current.status !== "draft") throw conflict("NOT_DRAFT", `Only draft ${label(current.kind)}s can be edited.`);
  const input = validate(documentSchema.omit({ kind: true }).partial(), req.body ?? {});
  const body = req.body ?? {};

  const changes = { updated_at: nowIso() };
  if ("customerId" in body || "billTo" in body) {
    const customerId = "customerId" in body ? input.customerId : current.customer_id;
    Object.assign(changes, await resolveBillTo(db, tenantId, customerId ?? null, input.billTo ?? null));
  }
  if ("issueDate" in body && input.issueDate) changes.issue_date = input.issueDate;
  if ("dueDate" in body) changes.due_date = input.dueDate ?? defaultDueDate(req, current.kind, changes.issue_date ?? current.issue_date);
  assertDates(changes.issue_date ?? current.issue_date, changes.due_date ?? current.due_date);
  if ("notes" in body) changes.notes = input.notes || null;
  if ("terms" in body) changes.terms = input.terms || null;
  const priced = "items" in body ? await buildLines(db, req, input.items) : null;
  if (priced) Object.assign(changes, priced.totals);

  await db.transaction(async trx => {
    await trx("invoices").where({ id }).update(changes);
    if (priced) {
      await trx("invoice_items").where({ invoice_id: id }).delete();
      await trx("invoice_items").insert(priced.lines.map(line => ({ ...lineColumns(line), invoice_id: id })));
    }
  });
  res.json(await loadDocument(db, req, id));
});

router.delete("/documents/:id", requirePermission("billing.delete"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const doc = await findDocument(db, req.user.tenant_id, id);
  if (doc.status !== "draft") throw conflict("NOT_DRAFT", `Only draft ${label(doc.kind)}s can be deleted.${doc.kind === "invoice" ? " Void it instead." : ""}`);
  await db("invoices").where({ id }).delete();
  await recordTenantAudit(db, req, `${doc.kind}.delete`, doc.number, { billTo: doc.bill_to_name, total: Number(doc.total) });
  res.status(204).end();
});

router.post("/documents/:id/send", requirePermission("billing.issue"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const doc = await findDocument(db, req.user.tenant_id, id);
  assertStatus(doc, ["draft"], "sent");
  const now = nowIso();
  await db("invoices").where({ id }).update({ status: "sent", sent_at: now, updated_at: now });
  await recordTenantAudit(db, req, `${doc.kind}.send`, doc.number, { billTo: doc.bill_to_name, total: Number(doc.total) });
  res.json(await loadDocument(db, req, id));
});

router.post("/documents/:id/void", requirePermission("billing.issue"), async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(z.object({ reason: z.string().trim().min(1, "Say why the invoice is being voided.").max(300) }), req.body);
  const db = getDb();
  const doc = await findDocument(db, req.user.tenant_id, id);
  assertKind(doc, "invoice", "voided");
  const payments = await db("invoice_payments").where({ invoice_id: id }).count({ count: "*" });
  if (Number(payments[0].count) > 0) throw conflict("HAS_PAYMENTS", "This invoice has payments recorded. Remove them before voiding it.");
  assertStatus(doc, ["draft", "sent"], "voided");
  const now = nowIso();
  await db("invoices").where({ id }).update({ status: "void", voided_at: now, updated_at: now });
  await recordTenantAudit(db, req, "invoice.void", doc.number, { reason, billTo: doc.bill_to_name, total: Number(doc.total) });
  res.json(await loadDocument(db, req, id));
});

router.post("/documents/:id/quote-status", requirePermission("billing.issue"), async (req, res) => {
  const id = parseId(req.params.id);
  const { status } = validate(z.object({ status: z.enum(["accepted", "declined"]) }), req.body);
  const db = getDb();
  const doc = await findDocument(db, req.user.tenant_id, id);
  assertKind(doc, "quote", `marked ${status}`);
  assertStatus(doc, ["sent"], `marked ${status}`);
  await db("invoices").where({ id }).update({ status, updated_at: nowIso() });
  await recordTenantAudit(db, req, status === "accepted" ? "quote.accept" : "quote.decline", doc.number, { billTo: doc.bill_to_name, total: Number(doc.total) });
  res.json(await loadDocument(db, req, id));
});

router.post("/documents/:id/convert", requirePermission("billing.issue"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const quote = await findDocument(db, tenantId, id);
  assertKind(quote, "quote", "converted to invoices");
  assertStatus(quote, ["sent", "accepted"], "converted");
  const priced = copyLines(await db("invoice_items").where({ invoice_id: id }).orderBy("position").orderBy("id"));
  const issueDate = todayIso();
  const invoiceId = await insertDraft(
    db,
    req,
    {
      kind: "invoice",
      customer_id: quote.customer_id,
      bill_to_name: quote.bill_to_name,
      bill_to_email: quote.bill_to_email,
      bill_to_phone: quote.bill_to_phone,
      bill_to_address: quote.bill_to_address,
      bill_to_tax_id: quote.bill_to_tax_id,
      issue_date: issueDate,
      due_date: defaultDueDate(req, "invoice", issueDate),
      notes: quote.notes,
      terms: quote.terms,
      source_quote_id: id,
    },
    priced,
    // Guarded on the status so two conversions at once can't both succeed.
    async trx => {
      const updated = await trx("invoices").where({ id, tenant_id: tenantId }).whereIn("status", ["sent", "accepted"]).update({ status: "converted", updated_at: nowIso() });
      if (!updated) throw conflict("INVALID_STATUS", "This quote has already been converted.");
    }
  );
  const invoice = await loadDocument(db, req, invoiceId);
  await recordTenantAudit(db, req, "quote.convert", quote.number, { invoice: invoice.number, total: invoice.total });
  res.status(201).json(invoice);
});

router.post("/documents/:id/duplicate", requirePermission("billing.edit"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const doc = await findDocument(db, req.user.tenant_id, id);
  const priced = copyLines(await db("invoice_items").where({ invoice_id: id }).orderBy("position").orderBy("id"));
  const issueDate = todayIso();
  const copyId = await insertDraft(db, req, {
    kind: doc.kind,
    customer_id: doc.customer_id,
    bill_to_name: doc.bill_to_name,
    bill_to_email: doc.bill_to_email,
    bill_to_phone: doc.bill_to_phone,
    bill_to_address: doc.bill_to_address,
    bill_to_tax_id: doc.bill_to_tax_id,
    issue_date: issueDate,
    due_date: defaultDueDate(req, doc.kind, issueDate),
    notes: doc.notes,
    terms: doc.terms,
  }, priced);
  res.status(201).json(await loadDocument(db, req, copyId));
});

/** A draft invoice from a confirmed or fulfilled sales order; lines get the default tax rate unless one is given. */
router.post("/from-order/:orderId", requirePermission("billing.edit"), async (req, res) => {
  const orderId = parseId(req.params.orderId);
  const input = validate(z.object({ taxRate: percent.optional(), billTo: billToSchema.nullable().default(null) }), req.body ?? {});
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const order = await db("orders").where({ id: orderId, tenant_id: tenantId }).first();
  if (!order) throw new HttpError(404, "Order not found.");
  if (!["confirmed", "fulfilled"].includes(order.status)) throw conflict("INVALID_STATUS", `This order is ${order.status}. Only confirmed or fulfilled orders can be invoiced.`);
  const existing = await db("invoices").where({ tenant_id: tenantId, kind: "invoice", order_id: orderId }).whereNot("status", "void").first();
  if (existing) throw conflict("ALREADY_INVOICED", `This order is already invoiced on ${existing.number}.`);

  const orderItems = await db("order_items as i").leftJoin("products as p", "p.id", "i.product_id").where("i.order_id", orderId).select("i.*", "p.unit").orderBy("i.id");
  if (!orderItems.length) throw conflict("EMPTY_ORDER", "This order has no lines to invoice.");
  const taxRate = input.taxRate ?? settingsOf(req).defaultTaxRate;
  const priced = priceLines(
    orderItems.map(item => ({
      product_id: item.product_id,
      description: item.description,
      quantity: Number(item.quantity),
      unit: item.unit ?? null,
      unit_price: Number(item.unit_price),
      discount_pct: 0,
      tax_rate: taxRate,
    }))
  );
  const billTo = await resolveBillTo(db, tenantId, order.customer_id, input.billTo);
  const issueDate = todayIso();
  const id = await insertDraft(db, req, {
    kind: "invoice",
    ...billTo,
    issue_date: issueDate,
    due_date: defaultDueDate(req, "invoice", issueDate),
    notes: settingsOf(req).defaultNotes || null,
    terms: settingsOf(req).defaultTerms || null,
    order_id: orderId,
  }, priced);
  res.status(201).json(await loadDocument(db, req, id));
});

// ---- Payments ----
/** Status and paid_at that follow from an invoice's paid amount. */
function paymentState(total, amountPaid) {
  if (amountPaid <= 0) return { status: "sent", paid_at: null };
  if (amountPaid >= round2(total)) return { status: "paid", paid_at: nowIso() };
  return { status: "partially_paid", paid_at: null };
}

router.post("/documents/:id/payments", requirePermission("billing.payments.record"), async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(paymentSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  if (!settingsOf(req).paymentMethods.includes(input.method)) throw invalid("method", "Pick one of your workspace's payment methods.");
  // A day of slack covers time zones ahead of UTC.
  if (input.paidOn > addDays(todayIso(), 1)) throw invalid("paidOn", "The payment date can't be in the future.");

  const { doc, state } = await db.transaction(async trx => {
    const lockedDoc = await trx("invoices").where({ id, tenant_id: tenantId }).forUpdate().first();
    if (!lockedDoc) throw new HttpError(404, "Invoice or quote not found.");
    assertKind(lockedDoc, "invoice", "paid");
    assertStatus(lockedDoc, OPEN_STATUSES, "paid");

    const currentPaid = Number(lockedDoc.amount_paid ?? 0);
    const docTotal = Number(lockedDoc.total ?? 0);
    const balance = round2(docTotal - currentPaid);
    if (input.amount > balance) throw invalid("amount", `Only ${balance.toFixed(2)} is outstanding on this invoice.`);

    await trx("invoice_payments").insert({
      tenant_id: tenantId,
      invoice_id: id,
      amount: input.amount,
      method: input.method,
      paid_on: input.paidOn,
      reference: input.reference || null,
      notes: input.notes || null,
      recorded_by: req.user.id,
      created_at: nowIso(),
    });
    const amountPaid = round2(currentPaid + input.amount);
    const next = paymentState(docTotal, amountPaid);
    await trx("invoices").where({ id }).update({ ...next, amount_paid: amountPaid, updated_at: nowIso() });
    if (next.status === "paid") {
      await notifyUsers(trx, [lockedDoc.created_by], { title: `Invoice ${lockedDoc.number} paid in full`, body: `${lockedDoc.bill_to_name} paid ${docTotal.toFixed(2)} ${lockedDoc.currency}`, actorId: req.user.id });
    }
    return { doc: lockedDoc, state: next };
  });
  await recordTenantAudit(db, req, "invoice.payment", doc.number, { amount: input.amount, method: input.method, paidOn: input.paidOn, status: state.status });
  res.status(201).json(await loadDocument(db, req, id));
});

router.delete("/documents/:id/payments/:paymentId", requirePermission("billing.payments.record"), async (req, res) => {
  const id = parseId(req.params.id);
  const paymentId = parseId(req.params.paymentId);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const doc = await findDocument(db, tenantId, id);
  const payment = await db("invoice_payments").where({ id: paymentId, invoice_id: id, tenant_id: tenantId }).first();
  if (!payment) throw new HttpError(404, "Payment not found.");

  await db.transaction(async trx => {
    await trx("invoice_payments").where({ id: paymentId }).delete();
    const [{ amount }] = await trx("invoice_payments").where({ invoice_id: id }).select(trx.raw("coalesce(sum(amount), 0) as amount"));
    const amountPaid = round2(Number(amount));
    await trx("invoices").where({ id }).update({ ...paymentState(Number(doc.total), amountPaid), amount_paid: amountPaid, updated_at: nowIso() });
  });
  await recordTenantAudit(db, req, "invoice.payment.remove", doc.number, { amount: Number(payment.amount), method: payment.method, paidOn: payment.paid_on });
  res.json(await loadDocument(db, req, id));
});

// ---- Pickers ----
const toCustomer = row => ({ id: row.id, name: row.name, company: row.company, email: row.email, phone: row.phone, address: row.address });

router.get("/customers", async (req, res) => {
  const q = validate(z.object({ search: z.string().trim().max(100).optional() }), req.query);
  const query = getDb()("customers").where("tenant_id", req.user.tenant_id).orderByRaw("lower(name)");
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner => inner.whereRaw("lower(name) like ?", [term]).orWhereRaw("lower(coalesce(company, '')) like ?", [term]).orWhereRaw("lower(coalesce(email, '')) like ?", [term]));
  }
  res.json((await query.limit(500)).map(toCustomer));
});

router.post("/customers", requirePermission("billing.edit"), async (req, res) => {
  const input = validate(customerSchema, req.body);
  const db = getDb();
  const now = nowIso();
  const id = await insertAndGetId(db, "customers", {
    tenant_id: req.user.tenant_id,
    name: input.name,
    company: input.company || null,
    email: input.email || null,
    phone: input.phone || null,
    address: input.address || null,
    owner_id: req.user.id,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(toCustomer(await db("customers").where({ id }).first()));
});

router.get("/products", async (req, res) => {
  const q = validate(z.object({ search: z.string().trim().max(100).optional() }), req.query);
  const query = getDb()("products").where({ tenant_id: req.user.tenant_id, is_active: true }).orderByRaw("lower(name)");
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner => inner.whereRaw("lower(name) like ?", [term]).orWhereRaw("lower(sku) like ?", [term]));
  }
  res.json((await query.limit(500)).map(row => ({ id: row.id, sku: row.sku, name: row.name, unit: row.unit, salePrice: Number(row.sale_price) })));
});

// ---- Export ----
const csvCell = value => {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get("/export", async (req, res) => {
  const q = validate(listSchema.pick({ kind: true, status: true, customerId: true, from: true, to: true, overdue: true, search: true }), req.query);
  const rows = await filterDocuments(documentsQuery(getDb(), req.user.tenant_id), q).orderBy("i.issue_date").orderBy("i.id").limit(20000);
  const lines = [
    "number,kind,customer,issue_date,due_date,status,subtotal,discount,tax,total,paid,balance",
    ...rows.map(row => {
      const doc = toDocument(row);
      return [doc.number, doc.kind, doc.billTo.name, doc.issueDate, doc.dueDate, doc.status, doc.subtotal, doc.discountTotal, doc.taxTotal, doc.total, doc.amountPaid, doc.balance].map(csvCell).join(",");
    }),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${q.kind ?? "billing"}-${todayIso()}.csv"`);
  res.send(lines.join("\r\n"));
});

export default router;
