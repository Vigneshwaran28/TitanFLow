// Inventory: products and every stock movement, scoped to the tenant. Quantity on hand only changes
// through a movement, so the history always explains the current balance.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { requirePermission } from "../middleware/auth.js";
import { usersWithPermission } from "../services/permissions.js";
import { resolveSettings } from "../services/moduleSettings.js";
import { notifyUsers } from "../services/notify.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const money = z.coerce.number().min(0, "Can't be negative.").max(1e12).transform(value => Math.round(value * 100) / 100);

const productSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required.").max(60).transform(value => value.toUpperCase()),
  name: z.string().trim().min(1, "Name is required.").max(160),
  category: z.string().trim().max(80).nullable().default(null),
  unit: z.string().trim().min(1).max(20).default("pcs"),
  costPrice: money.default(0),
  salePrice: money.default(0),
  reorderLevel: z.coerce.number().int().min(0).max(1e9).default(0),
  description: z.string().trim().max(2000).nullable().default(null),
  isActive: z.boolean().default(true),
  openingStock: z.coerce.number().int().min(0).max(1e9).default(0),
});

const movementSchema = z.object({
  type: z.enum(["in", "out", "adjust"]),
  // in / out: a positive amount. adjust: the counted quantity on hand.
  quantity: z.coerce.number().int().min(0, "Can't be negative.").max(1e9),
  reason: z.string().trim().max(200).nullable().default(null),
  reference: z.string().trim().max(80).nullable().default(null),
});

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  stock: z.enum(["low", "out"]).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  sort: z.enum(["name", "sku", "quantity", "value"]).default("name"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const toProduct = row => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  category: row.category,
  unit: row.unit,
  costPrice: Number(row.cost_price),
  salePrice: Number(row.sale_price),
  quantity: Number(row.quantity),
  reorderLevel: Number(row.reorder_level),
  stockValue: Math.round(Number(row.quantity) * Number(row.cost_price) * 100) / 100,
  isLow: Number(row.quantity) <= Number(row.reorder_level),
  description: row.description,
  isActive: Boolean(row.is_active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toMovement = row => ({
  id: row.id,
  productId: row.product_id,
  product: row.product_name ? { id: row.product_id, name: row.product_name, sku: row.product_sku, unit: row.product_unit } : undefined,
  type: row.type,
  change: Number(row.change),
  balanceAfter: Number(row.balance_after),
  reason: row.reason,
  reference: row.reference,
  createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
  createdAt: row.created_at,
});

async function findProduct(db, tenantId, id) {
  const row = await db("products").where({ id, tenant_id: tenantId }).first();
  if (!row) throw new HttpError(404, "Product not found.");
  return row;
}

async function assertUniqueSku(db, tenantId, sku, exceptId) {
  const query = db("products").where({ tenant_id: tenantId, sku });
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { sku: "Another product already uses this SKU." } });
}

/**
 * Applies a signed stock change inside a transaction and records it. Used by inventory and by sales orders.
 * @param {import("knex").Knex.Transaction} trx
 * @returns {Promise<number>} the new balance
 */
export async function moveStock(trx, { tenantId, productId, change, type, reason = null, reference = null, userId = null }) {
  const product = await trx("products").where({ id: productId, tenant_id: tenantId }).forUpdate().first();
  if (!product) throw new HttpError(404, "Product not found.");
  const balance = Number(product.quantity) + change;
  if (balance < 0) {
    throw new HttpError(422, `Not enough stock of ${product.name}: ${product.quantity} ${product.unit} on hand.`, {
      code: "INSUFFICIENT_STOCK",
      errors: { quantity: `Only ${product.quantity} ${product.unit} on hand.` },
    });
  }
  const now = nowIso();
  await trx("products").where({ id: productId }).update({ quantity: balance, updated_at: now });
  await trx("stock_movements").insert({
    tenant_id: tenantId,
    product_id: productId,
    type,
    change,
    balance_after: balance,
    reason,
    reference,
    created_by: userId,
    created_at: now,
  });

  // Crossing down to the reorder level alerts the product managers once (not on every later movement).
  const reorder = Number(product.reorder_level);
  if (Number(product.quantity) > reorder && balance <= reorder) {
    const tenant = await trx("tenants").where({ id: tenantId }).first();
    if (resolveSettings(tenant?.settings).inventory.lowStockAlerts) {
      await notifyUsers(trx, await usersWithPermission(trx, tenantId, "inventory.products.edit"), {
        title: balance <= 0 ? `Out of stock: ${product.name}` : `Low stock: ${product.name}`,
        body: `${balance} ${product.unit} left (reorder at ${reorder}). SKU ${product.sku}`,
      });
    }
  }
  return balance;
}

function movementsQuery(db, tenantId) {
  return db("stock_movements as m")
    .join("products as p", "p.id", "m.product_id")
    .leftJoin("users as u", "u.id", "m.created_by")
    .where("m.tenant_id", tenantId)
    .select("m.*", "p.name as product_name", "p.sku as product_sku", "p.unit as product_unit", "u.name as created_by_name")
    .orderBy("m.created_at", "desc")
    .orderBy("m.id", "desc");
}

router.get("/summary", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const active = () => db("products").where({ tenant_id: tenantId, is_active: true });
  const [totals, low, out, recent] = await Promise.all([
    active().select(db.raw("count(*) as products"), db.raw("coalesce(sum(quantity), 0) as units"), db.raw("coalesce(sum(quantity * cost_price), 0) as value")),
    active().whereRaw("quantity <= reorder_level").count({ count: "*" }),
    active().where("quantity", "<=", 0).count({ count: "*" }),
    movementsQuery(db, tenantId).limit(8),
  ]);
  res.json({
    products: Number(totals[0].products),
    units: Number(totals[0].units),
    stockValue: Math.round(Number(totals[0].value) * 100) / 100,
    lowStock: Number(low[0].count),
    outOfStock: Number(out[0].count),
    recentMovements: recent.map(toMovement),
  });
});

router.get("/categories", async (req, res) => {
  const rows = await getDb()("products").where("tenant_id", req.user.tenant_id).whereNotNull("category").distinct("category").orderBy("category");
  res.json(rows.map(row => row.category));
});

router.get("/products", async (req, res) => {
  const q = validate(listSchema, req.query);
  const db = getDb();
  const query = db("products").where("tenant_id", req.user.tenant_id);
  if (q.status !== "all") query.where("is_active", q.status === "active");
  if (q.category) query.where("category", q.category);
  if (q.stock === "low") query.whereRaw("quantity <= reorder_level");
  if (q.stock === "out") query.where("quantity", "<=", 0);
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner => inner.whereRaw("lower(name) like ?", [term]).orWhereRaw("lower(sku) like ?", [term]).orWhereRaw("lower(coalesce(category, '')) like ?", [term]));
  }

  const [{ total }] = await query.clone().count({ total: "*" });
  if (q.sort === "name") query.orderByRaw("lower(name)");
  if (q.sort === "sku") query.orderBy("sku");
  if (q.sort === "quantity") query.orderBy("quantity", "asc");
  if (q.sort === "value") query.orderByRaw("quantity * cost_price desc");
  query.orderBy("id");

  const rows = await query.limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const count = Number(total);
  res.json({ items: rows.map(toProduct), page: q.page, total: count, totalPages: Math.max(1, Math.ceil(count / q.pageSize)) });
});

router.get("/products/:id", async (req, res) => {
  const db = getDb();
  const product = await findProduct(db, req.user.tenant_id, parseId(req.params.id));
  const movements = await movementsQuery(db, req.user.tenant_id).where("m.product_id", product.id).limit(100);
  res.json({ ...toProduct(product), movements: movements.map(toMovement) });
});

router.post("/products", requirePermission("inventory.products.edit"), async (req, res) => {
  const input = validate(productSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertUniqueSku(db, tenantId, input.sku);

  const now = nowIso();
  const id = await db.transaction(async trx => {
    const productId = await insertAndGetId(trx, "products", {
      tenant_id: tenantId,
      sku: input.sku,
      name: input.name,
      category: input.category || null,
      unit: input.unit,
      cost_price: input.costPrice,
      sale_price: input.salePrice,
      quantity: 0,
      reorder_level: input.reorderLevel,
      description: input.description || null,
      is_active: input.isActive,
      created_at: now,
      updated_at: now,
    });
    if (input.openingStock > 0) {
      await moveStock(trx, { tenantId, productId, change: input.openingStock, type: "in", reason: "Opening stock", userId: req.user.id });
    }
    return productId;
  });
  res.status(201).json(toProduct(await findProduct(db, tenantId, id)));
});

router.patch("/products/:id", requirePermission("inventory.products.edit"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await findProduct(db, tenantId, id);
  const input = validate(productSchema.omit({ openingStock: true }).partial(), req.body ?? {});
  if (input.sku) await assertUniqueSku(db, tenantId, input.sku, id);

  const map = { sku: "sku", name: "name", category: "category", unit: "unit", costPrice: "cost_price", salePrice: "sale_price", reorderLevel: "reorder_level", description: "description", isActive: "is_active" };
  // Only fields the request sent: schema defaults must not overwrite stored values.
  const sent = new Set(Object.keys(req.body ?? {}));
  const changes = Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => sent.has(key) && map[key])
      .map(([key, value]) => [map[key], value === "" ? null : value])
  );
  if (Object.keys(changes).length) await db("products").where({ id, tenant_id: tenantId }).update({ ...changes, updated_at: nowIso() });
  res.json(toProduct(await findProduct(db, tenantId, id)));
});

router.delete("/products/:id", requirePermission("inventory.products.delete"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findProduct(db, req.user.tenant_id, id);
  await db("products").where({ id, tenant_id: req.user.tenant_id }).delete();
  res.status(204).end();
});

router.post("/products/:id/movements", requirePermission("inventory.stock.move"), async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(movementSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const product = await findProduct(db, tenantId, id);

  let change = input.quantity;
  if (input.type === "out") change = -input.quantity;
  if (input.type === "adjust") change = input.quantity - Number(product.quantity);
  if (change === 0) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { quantity: input.type === "adjust" ? "That's already the quantity on hand." : "Enter a quantity above zero." } });

  await db.transaction(trx => moveStock(trx, { tenantId, productId: id, change, type: input.type, reason: input.reason, reference: input.reference, userId: req.user.id }));
  res.status(201).json(toProduct(await findProduct(db, tenantId, id)));
});

router.get("/movements", async (req, res) => {
  const q = validate(z.object({ page: z.coerce.number().int().min(1).default(1) }), req.query);
  const db = getDb();
  const pageSize = 50;
  const [{ total }] = await db("stock_movements").where("tenant_id", req.user.tenant_id).count({ total: "*" });
  const rows = await movementsQuery(db, req.user.tenant_id).limit(pageSize).offset((q.page - 1) * pageSize);
  res.json({ items: rows.map(toMovement), page: q.page, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)) });
});

export default router;
