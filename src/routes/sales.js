// Sales: customers, a deal pipeline, and orders. Confirming an order takes its products out of inventory
// (when the tenant has the inventory module); cancelling a confirmed order puts them back.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can, requirePermission } from "../middleware/auth.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";
import { moveStock } from "./inventory.js";

const router = Router();

export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
const OPEN_STAGES = ["lead", "qualified", "proposal", "negotiation"];
const ORDER_STATUSES = ["draft", "confirmed", "fulfilled", "cancelled"];

const money = z.coerce.number().min(0, "Can't be negative.").max(1e12).transform(value => Math.round(value * 100) / 100);
const optionalText = max => z.string().trim().max(max).nullable().default(null);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.");

const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(160),
  company: optionalText(160),
  email: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable().default(null),
  phone: optionalText(40),
  address: optionalText(300),
  notes: optionalText(5000),
  ownerId: z.number().int().positive().nullable().default(null),
});

const dealSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  customerId: z.number().int().positive().nullable().default(null),
  value: money.default(0),
  stage: z.enum(DEAL_STAGES).default("lead"),
  expectedClose: dateOnly.nullable().default(null),
  ownerId: z.number().int().positive().nullable().default(null),
  notes: optionalText(5000),
});

const itemSchema = z.object({
  productId: z.number().int().positive().nullable().default(null),
  description: z.string().trim().max(200).default(""),
  quantity: z.coerce.number().int().min(1, "At least 1.").max(1e7),
  unitPrice: money.optional(),
});

const orderSchema = z.object({
  customerId: z.number().int().positive().nullable().default(null),
  notes: optionalText(2000),
  items: z.array(itemSchema).min(1, "Add at least one line.").max(200),
});

const round2 = value => Math.round(value * 100) / 100;
const orderKey = id => `SO-${String(id).padStart(4, "0")}`;

/** Keeps only the keys the client actually sent, so schema defaults never overwrite stored values. */
const sentOnly = (input, body, map) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key in (body ?? {}) && map[key])
      .map(([key, value]) => [map[key], value === "" ? null : value])
  );

async function assertCustomer(db, tenantId, customerId) {
  if (customerId == null) return null;
  const customer = await db("customers").where({ id: customerId, tenant_id: tenantId }).first();
  if (!customer) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { customerId: "Choose an existing customer." } });
  return customer;
}

async function assertOwner(db, tenantId, ownerId) {
  if (ownerId == null) return;
  const user = await db("users").where({ id: ownerId, tenant_id: tenantId, is_active: true }).first();
  if (!user) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { ownerId: "Choose an active person in your workspace." } });
}

// ---- Customers ----
const toCustomer = row => ({
  id: row.id,
  name: row.name,
  company: row.company,
  email: row.email,
  phone: row.phone,
  address: row.address,
  notes: row.notes,
  owner: row.owner_id ? { id: row.owner_id, name: row.owner_name } : null,
  openDeals: Number(row.open_deals ?? 0),
  totalOrdered: round2(Number(row.total_ordered ?? 0)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function customersQuery(db, tenantId) {
  const openDeals = db("deals").count("*").whereRaw("deals.customer_id = c.id").whereIn("deals.stage", OPEN_STAGES).as("open_deals");
  const ordered = db("orders").sum("total").whereRaw("orders.customer_id = c.id").whereIn("orders.status", ["confirmed", "fulfilled"]).as("total_ordered");
  return db("customers as c").leftJoin("users as o", "o.id", "c.owner_id").where("c.tenant_id", tenantId).select("c.*", "o.name as owner_name", openDeals, ordered);
}

router.get("/customers", async (req, res) => {
  const q = validate(z.object({ search: z.string().trim().max(100).optional() }), req.query);
  const query = customersQuery(getDb(), req.user.tenant_id).orderByRaw("lower(c.name)");
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner =>
      inner.whereRaw("lower(c.name) like ?", [term]).orWhereRaw("lower(coalesce(c.company, '')) like ?", [term]).orWhereRaw("lower(coalesce(c.email, '')) like ?", [term])
    );
  }
  res.json((await query.limit(500)).map(toCustomer));
});

router.post("/customers", requirePermission("sales.edit"), async (req, res) => {
  const input = validate(customerSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertOwner(db, tenantId, input.ownerId);
  const now = nowIso();
  const id = await insertAndGetId(db, "customers", {
    tenant_id: tenantId,
    name: input.name,
    company: input.company || null,
    email: input.email || null,
    phone: input.phone || null,
    address: input.address || null,
    notes: input.notes || null,
    owner_id: input.ownerId ?? req.user.id,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(toCustomer(await customersQuery(db, tenantId).where("c.id", id).first()));
});

router.patch("/customers/:id", requirePermission("sales.edit"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertCustomer(db, tenantId, id);
  const input = validate(customerSchema.partial(), req.body ?? {});
  if ("ownerId" in (req.body ?? {})) await assertOwner(db, tenantId, input.ownerId);
  const changes = sentOnly(input, req.body, { name: "name", company: "company", email: "email", phone: "phone", address: "address", notes: "notes", ownerId: "owner_id" });
  if (Object.keys(changes).length) await db("customers").where({ id, tenant_id: tenantId }).update({ ...changes, updated_at: nowIso() });
  res.json(toCustomer(await customersQuery(db, tenantId).where("c.id", id).first()));
});

router.delete("/customers/:id", requirePermission("sales.delete"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await assertCustomer(db, req.user.tenant_id, id);
  await db("customers").where({ id, tenant_id: req.user.tenant_id }).delete(); // deals and orders keep their history without a customer
  res.status(204).end();
});

// ---- Deals ----
const toDeal = row => ({
  id: row.id,
  title: row.title,
  value: Number(row.value),
  stage: row.stage,
  expectedClose: row.expected_close,
  notes: row.notes,
  customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, company: row.customer_company } : null,
  owner: row.owner_id ? { id: row.owner_id, name: row.owner_name } : null,
  closedAt: row.closed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function dealsQuery(db, tenantId) {
  return db("deals as d")
    .leftJoin("customers as c", "c.id", "d.customer_id")
    .leftJoin("users as o", "o.id", "d.owner_id")
    .where("d.tenant_id", tenantId)
    .select("d.*", "c.name as customer_name", "c.company as customer_company", "o.name as owner_name");
}

router.get("/deals", async (req, res) => {
  const q = validate(z.object({ ownerId: z.coerce.number().int().positive().optional(), customerId: z.coerce.number().int().positive().optional() }), req.query);
  const query = dealsQuery(getDb(), req.user.tenant_id).orderBy("d.updated_at", "desc");
  if (q.ownerId) query.where("d.owner_id", q.ownerId);
  if (q.customerId) query.where("d.customer_id", q.customerId);
  res.json((await query.limit(1000)).map(toDeal));
});

router.post("/deals", requirePermission("sales.edit"), async (req, res) => {
  const input = validate(dealSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertCustomer(db, tenantId, input.customerId);
  await assertOwner(db, tenantId, input.ownerId);
  const now = nowIso();
  const id = await insertAndGetId(db, "deals", {
    tenant_id: tenantId,
    customer_id: input.customerId,
    title: input.title,
    value: input.value,
    stage: input.stage,
    expected_close: input.expectedClose,
    owner_id: input.ownerId ?? req.user.id,
    notes: input.notes || null,
    closed_at: OPEN_STAGES.includes(input.stage) ? null : now,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(toDeal(await dealsQuery(db, tenantId).where("d.id", id).first()));
});

router.patch("/deals/:id", requirePermission("sales.edit"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await db("deals").where({ id, tenant_id: tenantId }).first();
  if (!current) throw new HttpError(404, "Deal not found.");
  const input = validate(dealSchema.partial(), req.body ?? {});
  if ("customerId" in (req.body ?? {})) await assertCustomer(db, tenantId, input.customerId);
  if ("ownerId" in (req.body ?? {})) await assertOwner(db, tenantId, input.ownerId);

  const changes = sentOnly(input, req.body, { title: "title", customerId: "customer_id", value: "value", stage: "stage", expectedClose: "expected_close", ownerId: "owner_id", notes: "notes" });
  if (changes.stage && changes.stage !== current.stage) changes.closed_at = OPEN_STAGES.includes(changes.stage) ? null : nowIso();
  if (Object.keys(changes).length) await db("deals").where({ id }).update({ ...changes, updated_at: nowIso() });
  res.json(toDeal(await dealsQuery(db, tenantId).where("d.id", id).first()));
});

router.delete("/deals/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const deal = await db("deals").where({ id, tenant_id: req.user.tenant_id }).first();
  if (!deal) throw new HttpError(404, "Deal not found.");
  if (deal.owner_id !== req.user.id && !can(req, "sales.delete")) throw new HttpError(403, "Only the deal owner or someone allowed to delete sales records can delete it.", { code: "FORBIDDEN" });
  await db("deals").where({ id, tenant_id: req.user.tenant_id }).delete();
  res.status(204).end();
});

// ---- Orders ----
const toOrder = (row, items) => ({
  id: row.id,
  key: orderKey(row.id),
  status: row.status,
  total: Number(row.total),
  notes: row.notes,
  customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, company: row.customer_company } : null,
  createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
  itemCount: Number(row.item_count ?? items?.length ?? 0),
  items: items?.map(item => ({
    id: item.id,
    productId: item.product_id,
    sku: item.sku ?? null,
    unit: item.unit ?? null,
    description: item.description,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    lineTotal: Number(item.line_total),
  })),
  confirmedAt: row.confirmed_at,
  fulfilledAt: row.fulfilled_at,
  cancelledAt: row.cancelled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function ordersQuery(db, tenantId) {
  const itemCount = db("order_items").count("*").whereRaw("order_items.order_id = s.id").as("item_count");
  return db("orders as s")
    .leftJoin("customers as c", "c.id", "s.customer_id")
    .leftJoin("users as u", "u.id", "s.created_by")
    .where("s.tenant_id", tenantId)
    .select("s.*", "c.name as customer_name", "c.company as customer_company", "u.name as created_by_name", itemCount);
}

async function loadOrder(db, tenantId, id) {
  const row = await ordersQuery(db, tenantId).where("s.id", id).first();
  if (!row) throw new HttpError(404, "Order not found.");
  const items = await db("order_items as i").leftJoin("products as p", "p.id", "i.product_id").where("i.order_id", id).select("i.*", "p.sku", "p.unit").orderBy("i.id");
  return { row, items };
}

/** Resolves line items against the tenant's products and prices them. */
async function buildItems(db, tenantId, items, req = null) {
  const ids = [...new Set(items.map(item => item.productId).filter(Boolean))];
  const products = ids.length ? await db("products").where("tenant_id", tenantId).whereIn("id", ids) : [];
  const byId = new Map(products.map(product => [product.id, product]));
  return items.map((item, index) => {
    const product = item.productId ? byId.get(item.productId) : null;
    if (item.productId && !product) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { items: `Line ${index + 1}: that product no longer exists.` } });
    const description = item.description || product?.name;
    if (!description) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { items: `Line ${index + 1}: add a description or pick a product.` } });
    let unitPrice = Number(product?.sale_price ?? 0);
    if (item.unitPrice !== undefined) {
      const canOverridePrice = req ? (req.access?.isOwner || req.access?.permissions?.includes("billing.invoices.manage")) : true;
      if (!canOverridePrice && product && item.unitPrice !== Number(product.sale_price)) {
        throw new HttpError(403, `Line ${index + 1}: you don't have permission to override catalog prices.`, { code: "PRICE_OVERRIDE_FORBIDDEN" });
      }
      unitPrice = item.unitPrice;
    }
    return { product_id: product?.id ?? null, description, quantity: item.quantity, unit_price: unitPrice, line_total: round2(unitPrice * item.quantity) };
  });
}

/** Moves stock for every product line: direction -1 takes it out (confirm), +1 puts it back (cancel). */
async function applyStock(trx, req, items, direction, orderId) {
  if (!req.tenant.features.includes("inventory")) return;
  for (const item of items.filter(line => line.product_id)) {
    await moveStock(trx, {
      tenantId: req.user.tenant_id,
      productId: item.product_id,
      change: direction * Number(item.quantity),
      type: direction < 0 ? "sale" : "return",
      reason: direction < 0 ? "Sales order confirmed" : "Sales order cancelled",
      reference: orderKey(orderId),
      userId: req.user.id,
    });
  }
}

router.get("/orders", async (req, res) => {
  const q = validate(
    z.object({ status: z.enum(ORDER_STATUSES).optional(), customerId: z.coerce.number().int().positive().optional(), page: z.coerce.number().int().min(1).default(1) }),
    req.query
  );
  const db = getDb();
  const pageSize = 25;
  const query = ordersQuery(db, req.user.tenant_id);
  if (q.status) query.where("s.status", q.status);
  if (q.customerId) query.where("s.customer_id", q.customerId);
  const [{ total }] = await query.clone().clearSelect().count({ total: "s.id" });
  const rows = await query.orderBy("s.id", "desc").limit(pageSize).offset((q.page - 1) * pageSize);
  res.json({ items: rows.map(row => toOrder(row)), page: q.page, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)) });
});

router.get("/orders/:id", async (req, res) => {
  const { row, items } = await loadOrder(getDb(), req.user.tenant_id, parseId(req.params.id));
  res.json(toOrder(row, items));
});

router.post("/orders", requirePermission("sales.edit"), async (req, res) => {
  const input = validate(orderSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertCustomer(db, tenantId, input.customerId);
  const items = await buildItems(db, tenantId, input.items, req);
  const now = nowIso();

  const id = await db.transaction(async trx => {
    const orderId = await insertAndGetId(trx, "orders", {
      tenant_id: tenantId,
      customer_id: input.customerId,
      status: "draft",
      total: round2(items.reduce((sum, item) => sum + item.line_total, 0)),
      notes: input.notes || null,
      created_by: req.user.id,
      created_at: now,
      updated_at: now,
    });
    await trx("order_items").insert(items.map(item => ({ ...item, order_id: orderId })));
    return orderId;
  });
  const { row, items: saved } = await loadOrder(db, tenantId, id);
  res.status(201).json(toOrder(row, saved));
});

// Draft orders can be edited; status moves forward draft -> confirmed -> fulfilled, or to cancelled.
const NEXT_STATUS = { draft: ["confirmed", "cancelled"], confirmed: ["fulfilled", "cancelled"], fulfilled: [], cancelled: [] };

router.patch("/orders/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const { row: current, items: currentItems } = await loadOrder(db, tenantId, id);
  const input = validate(orderSchema.partial().extend({ status: z.enum(ORDER_STATUSES).optional() }), req.body ?? {});
  const now = nowIso();
  const body = req.body ?? {};

  const editing = "items" in body || "customerId" in body || "notes" in body;
  if (editing && !can(req, "sales.edit")) throw new HttpError(403, "You don't have permission to edit orders.", { code: "FORBIDDEN" });
  if (input.status && input.status !== current.status && !can(req, "sales.orders.confirm")) {
    throw new HttpError(403, "You don't have permission to confirm, fulfil, or cancel orders.", { code: "FORBIDDEN" });
  }
  if (editing && current.status !== "draft") throw new HttpError(422, "Only draft orders can be edited.", { code: "ORDER_LOCKED" });
  if (input.status && input.status !== current.status && !NEXT_STATUS[current.status].includes(input.status)) {
    throw new HttpError(422, `A ${current.status} order can't be marked ${input.status}.`, { code: "INVALID_TRANSITION" });
  }

  await db.transaction(async trx => {
    const changes = { updated_at: now };
    let items = currentItems;
    if ("customerId" in body) {
      await assertCustomer(trx, tenantId, input.customerId);
      changes.customer_id = input.customerId;
    }
    if ("notes" in body) changes.notes = input.notes || null;
    if ("items" in body) {
      items = await buildItems(trx, tenantId, input.items, req);
      await trx("order_items").where({ order_id: id }).delete();
      await trx("order_items").insert(items.map(item => ({ ...item, order_id: id })));
      changes.total = round2(items.reduce((sum, item) => sum + Number(item.line_total), 0));
    }
    if (input.status && input.status !== current.status) {
      changes.status = input.status;
      if (input.status === "confirmed") {
        changes.confirmed_at = now;
        await applyStock(trx, req, items, -1, id);
      }
      if (input.status === "fulfilled") changes.fulfilled_at = now;
      if (input.status === "cancelled") {
        changes.cancelled_at = now;
        if (current.status === "confirmed") await applyStock(trx, req, items, +1, id);
      }
    }
    await trx("orders").where({ id, tenant_id: tenantId }).update(changes);
  });

  const { row, items } = await loadOrder(db, tenantId, id);
  res.json(toOrder(row, items));
});

router.delete("/orders/:id", requirePermission("sales.edit"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const { row } = await loadOrder(db, req.user.tenant_id, id);
  if (row.status !== "draft") throw new HttpError(422, "Only draft orders can be deleted. Cancel it instead.", { code: "ORDER_LOCKED" });
  await db("orders").where({ id, tenant_id: req.user.tenant_id }).delete();
  res.status(204).end();
});

// ---- Summary ----
router.get("/summary", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const [pipeline, wonMonth, revenueMonth, ordersMonth, customers, topCustomers] = await Promise.all([
    db("deals").where("tenant_id", tenantId).select("stage").count({ count: "*" }).sum({ value: "value" }).groupBy("stage"),
    db("deals").where({ tenant_id: tenantId, stage: "won" }).where("closed_at", ">=", monthStart).select(db.raw("count(*) as count"), db.raw("coalesce(sum(value), 0) as value")),
    db("orders").where("tenant_id", tenantId).whereIn("status", ["confirmed", "fulfilled"]).where("confirmed_at", ">=", monthStart).select(db.raw("coalesce(sum(total), 0) as value")),
    db("orders").where("tenant_id", tenantId).where("created_at", ">=", monthStart).count({ count: "*" }),
    db("customers").where("tenant_id", tenantId).count({ count: "*" }),
    db("orders as s")
      .join("customers as c", "c.id", "s.customer_id")
      .where("s.tenant_id", tenantId)
      .whereIn("s.status", ["confirmed", "fulfilled"])
      .groupBy("c.id", "c.name")
      .select("c.id", "c.name")
      .sum({ total: "s.total" })
      .orderBy("total", "desc")
      .limit(5),
  ]);

  const byStage = Object.fromEntries(DEAL_STAGES.map(stage => [stage, { count: 0, value: 0 }]));
  for (const row of pipeline) byStage[row.stage] = { count: Number(row.count), value: round2(Number(row.value ?? 0)) };
  const open = OPEN_STAGES.reduce((acc, stage) => ({ count: acc.count + byStage[stage].count, value: round2(acc.value + byStage[stage].value) }), { count: 0, value: 0 });
  const closed = byStage.won.count + byStage.lost.count;

  res.json({
    pipeline: byStage,
    openPipeline: open,
    wonThisMonth: { count: Number(wonMonth[0].count), value: round2(Number(wonMonth[0].value)) },
    revenueThisMonth: round2(Number(revenueMonth[0].value)),
    ordersThisMonth: Number(ordersMonth[0].count),
    customers: Number(customers[0].count),
    winRate: closed ? Math.round((byStage.won.count / closed) * 100) : null,
    topCustomers: topCustomers.map(row => ({ id: row.id, name: row.name, total: round2(Number(row.total)) })),
  });
});

export default router;
