// Logistics: shipments with a tracking history, carriers, the delivery fleet, and drivers.
// Booking (logistics.edit) creates a pending shipment; dispatch (logistics.dispatch) assigns carrier, vehicle,
// and driver and moves any shipment along; drivers (logistics.deliver) update only their own deliveries.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { likeEscape } from "../db/dialects.js";
import { can, requirePermission } from "../middleware/auth.js";
import {
  carrierTrackingUrl,
  canTransition,
  DIRECTIONS,
  DRIVER_STATUSES,
  generateTrackingCode,
  MOVING_STATUSES,
  SERVICES,
  SHIPMENT_STATUSES,
  TERMINAL_STATUSES,
  todayIso,
  TRANSITIONS,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
} from "../services/logistics.js";
import { notifyUsers } from "../services/notify.js";
import { usersWithPermission } from "../services/permissions.js";
import { publish } from "../services/realtime.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const settingsOf = req => req.tenant.settings.logistics;
const round2 = value => Math.round(value * 100) / 100;
const invalid = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { errors: { [field]: message } });
const forbidden = message => new HttpError(403, message, { code: "FORBIDDEN" });
const isUniqueViolation = error => error?.code === "23505" || error?.code === "ER_DUP_ENTRY" || /unique|duplicate/i.test(String(error?.message));
const orderKey = id => `SO-${String(id).padStart(4, "0")}`;
const num = value => (value == null ? null : Number(value));

/** Everyone except a driver-only role sees every shipment; drivers see the ones assigned to them. */
const seesAll = req => ["logistics.view", "logistics.edit", "logistics.dispatch", "logistics.fleet.manage"].some(permission => can(req, permission));

const LOGISTICS_PERMISSIONS = ["logistics.view", "logistics.edit", "logistics.dispatch", "logistics.deliver", "logistics.fleet.manage"];
/** Live hints after a shipment changed (call once committed); `trackingCode` also refreshes its public tracking page. */
function publishShipment(req, shipmentId, status, trackingCode = null) {
  publish({ tenantId: req.user.tenant_id, permission: LOGISTICS_PERMISSIONS }, "shipment.updated", { shipmentId, status, actorId: req.user.id });
  if (trackingCode) publish({ channel: `track:${trackingCode}` }, "tracking.updated", { status });
}

const money = z.coerce.number().min(0, "Can't be negative.").max(1e12).transform(round2);
const optionalText = max => z.string().trim().max(max).nullable().default(null);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.");
const optionalId = z.number().int().positive().nullable().default(null);
const occurredAt = z.iso.datetime({ offset: true, message: "Use a date and time like 2026-10-05T14:30:00Z." }).nullable().default(null);

const STATUS_NOTES = {
  pending: "Shipment booked",
  picked_up: "Picked up",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  failed: "Delivery attempt failed",
  returned: "Returned to sender",
  cancelled: "Shipment cancelled",
};

const shipmentSchema = z.object({
  direction: z.enum(DIRECTIONS).default("outbound"),
  service: z.enum(SERVICES).default("standard"),
  orderId: optionalId,
  customerId: optionalId,
  carrierId: optionalId,
  carrierReference: optionalText(60),
  vehicleId: optionalId,
  driverId: optionalId,
  senderName: optionalText(160),
  senderAddress: optionalText(500),
  recipientName: optionalText(160),
  recipientPhone: optionalText(40),
  recipientAddress: optionalText(500),
  originCity: optionalText(80),
  destinationCity: optionalText(80),
  packages: z.coerce.number().int().min(1, "At least 1 package.").max(10000).default(1),
  weightKg: z.coerce.number().positive("Enter a weight above zero.").max(1e6).transform(round2).nullable().default(null),
  declaredValue: money.nullable().default(null),
  shippingCost: money.nullable().default(null),
  codAmount: money.nullable().default(null),
  shipDate: dateOnly.nullable().default(null),
  expectedOn: dateOnly.nullable().default(null),
  notes: optionalText(5000),
});

const COLUMNS = {
  direction: "direction",
  service: "service",
  orderId: "order_id",
  customerId: "customer_id",
  carrierId: "carrier_id",
  carrierReference: "carrier_reference",
  vehicleId: "vehicle_id",
  driverId: "driver_id",
  senderName: "sender_name",
  senderAddress: "sender_address",
  recipientName: "recipient_name",
  recipientPhone: "recipient_phone",
  recipientAddress: "recipient_address",
  originCity: "origin_city",
  destinationCity: "destination_city",
  packages: "packages",
  weightKg: "weight_kg",
  declaredValue: "declared_value",
  shippingCost: "shipping_cost",
  codAmount: "cod_amount",
  shipDate: "ship_date",
  expectedOn: "expected_on",
  notes: "notes",
};
const ASSIGNMENT_FIELDS = ["carrierId", "carrierReference", "vehicleId", "driverId"];

/** Keeps only the keys the client actually sent, so schema defaults never overwrite stored values. */
const sentOnly = (input, body, map) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key in (body ?? {}) && map[key])
      .map(([key, value]) => [map[key], value === "" ? null : value])
  );

// ---- Mappers ----
const isOverdue = row => Boolean(row.expected_on && row.expected_on < todayIso() && !TERMINAL_STATUSES.includes(row.status));

const toShipment = row => ({
  id: row.id,
  number: row.number,
  trackingCode: row.tracking_code,
  direction: row.direction,
  status: row.status,
  service: row.service,
  carrier: row.carrier_id ? { id: row.carrier_id, name: row.carrier_name } : null,
  carrierReference: row.carrier_reference,
  trackingUrl: row.carrier_id ? carrierTrackingUrl(row.carrier_tracking_url, row.carrier_reference) : null,
  vehicle: row.vehicle_id ? { id: row.vehicle_id, registration: row.vehicle_registration } : null,
  driver: row.driver_id ? { id: row.driver_id, name: row.driver_name } : null,
  orderId: row.order_id,
  customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, company: row.customer_company ?? null } : null,
  senderName: row.sender_name,
  senderAddress: row.sender_address,
  recipientName: row.recipient_name,
  recipientPhone: row.recipient_phone,
  recipientAddress: row.recipient_address,
  originCity: row.origin_city,
  destinationCity: row.destination_city,
  packages: Number(row.packages),
  weightKg: num(row.weight_kg),
  declaredValue: num(row.declared_value),
  shippingCost: num(row.shipping_cost),
  codAmount: num(row.cod_amount),
  shipDate: row.ship_date,
  expectedOn: row.expected_on,
  deliveredAt: row.delivered_at,
  receivedBy: row.received_by,
  notes: row.notes,
  isOverdue: isOverdue(row),
  createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toEvent = row => ({
  id: row.id,
  status: row.status,
  location: row.location,
  note: row.note,
  actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null,
  occurredAt: row.occurred_at,
});

function shipmentsQuery(db, tenantId) {
  return db("shipments as s")
    .leftJoin("carriers as c", "c.id", "s.carrier_id")
    .leftJoin("vehicles as v", "v.id", "s.vehicle_id")
    .leftJoin("users as d", "d.id", "s.driver_id")
    .leftJoin("users as u", "u.id", "s.created_by")
    .leftJoin("customers as cu", "cu.id", "s.customer_id")
    .where("s.tenant_id", tenantId)
    .select(
      "s.*",
      "c.name as carrier_name",
      "c.tracking_url as carrier_tracking_url",
      "v.registration as vehicle_registration",
      "d.name as driver_name",
      "u.name as created_by_name",
      "cu.name as customer_name",
      "cu.company as customer_company"
    );
}

/** The statuses this person may move a shipment to next. */
function allowedStatuses(req, shipment) {
  const next = TRANSITIONS[shipment.status] ?? [];
  if (can(req, "logistics.dispatch")) return next;
  if (can(req, "logistics.deliver") && shipment.driver_id === req.user.id) return next.filter(status => DRIVER_STATUSES.includes(status));
  return [];
}

async function findShipment(db, req, id) {
  const row = await shipmentsQuery(db, req.user.tenant_id).where("s.id", id).first();
  if (!row || (!seesAll(req) && row.driver_id !== req.user.id)) throw new HttpError(404, "Shipment not found.");
  return row;
}

async function loadDetail(db, req, id) {
  const row = await findShipment(db, req, id);
  const [events, order, customer] = await Promise.all([
    db("shipment_events as e").leftJoin("users as a", "a.id", "e.actor_id").where("e.shipment_id", id).select("e.*", "a.name as actor_name").orderBy("e.occurred_at", "desc").orderBy("e.id", "desc"),
    row.order_id ? db("orders").where({ id: row.order_id, tenant_id: req.user.tenant_id }).first() : null,
    row.customer_id ? db("customers").where({ id: row.customer_id, tenant_id: req.user.tenant_id }).first() : null,
  ]);
  return {
    ...toShipment(row),
    order: order ? { id: order.id, number: orderKey(order.id), status: order.status, total: Number(order.total) } : null,
    customer: customer ? { id: customer.id, name: customer.name, company: customer.company, email: customer.email, phone: customer.phone, address: customer.address } : null,
    events: events.map(toEvent),
    allowedStatuses: allowedStatuses(req, row),
    currency: req.tenant.settings.company.currency,
  };
}

// ---- Reference checks: everything a shipment points at must belong to the tenant ----
async function eligibleDriverIds(db, tenantId) {
  const [deliver, dispatch] = await Promise.all([usersWithPermission(db, tenantId, "logistics.deliver"), usersWithPermission(db, tenantId, "logistics.dispatch")]);
  return new Set([...deliver, ...dispatch]);
}

async function assertDriver(db, tenantId, driverId, field = "driverId") {
  if (driverId == null) return;
  const user = await db("users").where({ id: driverId, tenant_id: tenantId, is_active: true }).first();
  if (!user || !(await eligibleDriverIds(db, tenantId)).has(driverId)) throw invalid(field, "Choose an active person who can make deliveries.");
}

async function assertCarrier(db, tenantId, carrierId) {
  if (carrierId == null) return;
  const carrier = await db("carriers").where({ id: carrierId, tenant_id: tenantId }).first();
  if (!carrier) throw invalid("carrierId", "Choose one of your carriers.");
  if (!carrier.is_active) throw invalid("carrierId", "This carrier is inactive.");
}

async function assertVehicle(db, tenantId, vehicleId) {
  if (vehicleId == null) return;
  const vehicle = await db("vehicles").where({ id: vehicleId, tenant_id: tenantId }).first();
  if (!vehicle) throw invalid("vehicleId", "Choose one of your vehicles.");
  if (["maintenance", "retired"].includes(vehicle.status)) throw invalid("vehicleId", `This vehicle is ${vehicle.status === "retired" ? "retired" : "in maintenance"}.`);
}

async function findOrder(db, tenantId, orderId) {
  if (orderId == null) return null;
  const order = await db("orders").where({ id: orderId, tenant_id: tenantId }).first();
  if (!order) throw invalid("orderId", "Choose an existing sales order.");
  return order;
}

async function findCustomer(db, tenantId, customerId) {
  if (customerId == null) return null;
  const customer = await db("customers").where({ id: customerId, tenant_id: tenantId }).first();
  if (!customer) throw invalid("customerId", "Choose an existing customer.");
  return customer;
}

function assertDates(shipDate, expectedOn) {
  if (shipDate && expectedOn && expectedOn < shipDate) throw invalid("expectedOn", "The expected date can't be before the ship date.");
}

function eventTime(value) {
  if (!value) return nowIso();
  const time = new Date(value);
  if (time.getTime() > Date.now() + 5 * 60_000) throw invalid("occurredAt", "That time is in the future.");
  return time.toISOString();
}

/** A vehicle is in use while any of its shipments is on the road; maintenance and retired are left alone. */
async function syncVehicle(trx, tenantId, vehicleId) {
  if (!vehicleId) return;
  const vehicle = await trx("vehicles").where({ id: vehicleId, tenant_id: tenantId }).first();
  if (!vehicle || !["available", "in_use"].includes(vehicle.status)) return;
  const busy = await trx("shipments").where({ tenant_id: tenantId, vehicle_id: vehicleId }).whereIn("status", MOVING_STATUSES).first("id");
  const next = busy ? "in_use" : "available";
  if (vehicle.status !== next) await trx("vehicles").where({ id: vehicleId }).update({ status: next, updated_at: nowIso() });
}

async function notifyAssigned(trx, req, driverId, shipment) {
  const where = shipment.destination_city || shipment.recipient_name;
  await notifyUsers(trx, [driverId], { title: `Shipment assigned: ${shipment.number}`, body: `${req.user.name} assigned you ${shipment.number}${where ? ` to ${where}` : ""}.`, actorId: req.user.id });
}

/** Next per-tenant number: prefix + at least 4 digits, one past the highest already used with this prefix. */
async function nextNumber(trx, tenantId, prefix) {
  const escaped = prefix.replace(/[\\%_]/g, char => `\\${char}`);
  const rows = await trx("shipments").where("tenant_id", tenantId).whereRaw(`number like ?${likeEscape(trx)}`, [`${escaped}%`]).select("number");
  let max = 0;
  for (const { number } of rows) {
    const rest = number.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// ---- Summary ----
router.get("/summary", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const today = todayIso();
  const now = new Date();
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7))).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const all = db("shipments").where("tenant_id", tenantId);
  const open = all.clone().whereNotIn("status", TERMINAL_STATUSES);

  const [byStatusRows, dueToday, overdue, deliveredWeek, recentDelivered, cod, byCarrierRows, mine] = await Promise.all([
    all.clone().select("status").count({ count: "*" }).groupBy("status"),
    open.clone().where("expected_on", today).count({ count: "*" }),
    open.clone().where("expected_on", "<", today).count({ count: "*" }),
    all.clone().where("status", "delivered").where("delivered_at", ">=", weekStart).count({ count: "*" }),
    all.clone().where("status", "delivered").where("delivered_at", ">=", monthAgo).whereNotNull("expected_on").select("delivered_at", "expected_on"),
    all.clone().whereIn("status", ["in_transit", "out_for_delivery"]).select(db.raw("count(cod_amount) as count"), db.raw("coalesce(sum(cod_amount), 0) as amount")),
    db("shipments as s")
      .leftJoin("carriers as c", "c.id", "s.carrier_id")
      .where("s.tenant_id", tenantId)
      .whereNotIn("s.status", TERMINAL_STATUSES)
      .groupBy("s.carrier_id", "c.name")
      .select("s.carrier_id", "c.name")
      .count({ count: "*" }),
    open.clone().where("driver_id", req.user.id).count({ count: "*" }),
  ]);

  const byStatus = Object.fromEntries(SHIPMENT_STATUSES.map(status => [status, 0]));
  for (const row of byStatusRows) byStatus[row.status] = Number(row.count);
  const onTime = recentDelivered.filter(row => row.delivered_at.slice(0, 10) <= row.expected_on).length;

  res.json({
    byStatus,
    total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    open: SHIPMENT_STATUSES.filter(status => !TERMINAL_STATUSES.includes(status)).reduce((sum, status) => sum + byStatus[status], 0),
    dueToday: Number(dueToday[0].count),
    overdue: Number(overdue[0].count),
    deliveredThisWeek: Number(deliveredWeek[0].count),
    onTimeRate: recentDelivered.length ? Math.round((onTime / recentDelivered.length) * 100) : null,
    codToCollect: { count: Number(cod[0].count), amount: round2(Number(cod[0].amount)) },
    byCarrier: byCarrierRows
      .map(row => ({ carrier: row.carrier_id ? { id: row.carrier_id, name: row.name } : null, count: Number(row.count) }))
      .sort((a, b) => b.count - a.count),
    myDeliveries: Number(mine[0].count),
    currency: req.tenant.settings.company.currency,
  });
});

// ---- Shipments ----
const listSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES).optional(),
  direction: z.enum(DIRECTIONS).optional(),
  carrierId: z.coerce.number().int().positive().optional(),
  driverId: z.coerce.number().int().positive().optional(),
  mine: z.enum(["true", "false"]).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(100).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Filters shared by the list and the CSV export; from/to are booking dates (inclusive). */
function applyFilters(query, req, q) {
  if (!seesAll(req) || q.mine === "true") query.where("s.driver_id", req.user.id);
  if (q.status) query.where("s.status", q.status);
  if (q.direction) query.where("s.direction", q.direction);
  if (q.carrierId) query.where("s.carrier_id", q.carrierId);
  if (q.driverId) query.where("s.driver_id", q.driverId);
  if (q.from) query.where("s.created_at", ">=", q.from);
  if (q.to) query.where("s.created_at", "<", nextDay(q.to));
  if (q.overdue === "true") query.where("s.expected_on", "<", todayIso()).whereNotIn("s.status", TERMINAL_STATUSES);
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner =>
      inner
        .whereRaw("lower(s.number) like ?", [term])
        .orWhereRaw("lower(s.tracking_code) like ?", [term])
        .orWhereRaw("lower(coalesce(s.carrier_reference, '')) like ?", [term])
        .orWhereRaw("lower(s.recipient_name) like ?", [term])
        .orWhereRaw("lower(coalesce(s.destination_city, '')) like ?", [term])
        .orWhereRaw("lower(coalesce(s.origin_city, '')) like ?", [term])
    );
  }
  return query;
}

router.get("/shipments", async (req, res) => {
  const q = validate(listSchema, req.query);
  if (q.from && q.to && q.to < q.from) throw invalid("to", "The end date can't be before the start date.");
  const query = applyFilters(shipmentsQuery(getDb(), req.user.tenant_id), req, q);
  const [{ total }] = await query.clone().clearSelect().count({ total: "s.id" });
  const rows = await query.orderBy("s.id", "desc").limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const count = Number(total);
  res.json({ items: rows.map(toShipment), page: q.page, pageSize: q.pageSize, total: count, totalPages: Math.max(1, Math.ceil(count / q.pageSize)) });
});

router.get("/shipments/:id", async (req, res) => {
  res.json(await loadDetail(getDb(), req, parseId(req.params.id)));
});

router.post("/shipments", requirePermission("logistics.edit"), async (req, res) => {
  const body = req.body ?? {};
  const input = validate(shipmentSchema, body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  if (ASSIGNMENT_FIELDS.some(field => body[field] != null) && !can(req, "logistics.dispatch")) throw forbidden("You don't have permission to assign carriers, vehicles, or drivers.");

  const order = await findOrder(db, tenantId, input.orderId);
  const customerId = input.customerId ?? order?.customer_id ?? null;
  const customer = await findCustomer(db, tenantId, customerId);
  await Promise.all([assertCarrier(db, tenantId, input.carrierId), assertVehicle(db, tenantId, input.vehicleId), assertDriver(db, tenantId, input.driverId)]);
  assertDates(input.shipDate, input.expectedOn);

  // A linked order (or customer) fills in whatever recipient details weren't typed.
  const recipientName = input.recipientName || customer?.name || null;
  const recipientAddress = input.recipientAddress || customer?.address || null;
  const recipientPhone = input.recipientPhone || customer?.phone || null;
  const errors = {};
  if (!recipientName) errors.recipientName = "Who is it going to?";
  if (!recipientAddress) errors.recipientAddress = "Add the delivery address.";
  if (Object.keys(errors).length) throw new HttpError(422, "Please fix the highlighted fields.", { errors });

  const prefix = settingsOf(req).shipmentPrefix || "SHP-";
  let id;
  for (let attempt = 0; ; attempt++) {
    try {
      id = await db.transaction(async trx => {
        const now = nowIso();
        const number = await nextNumber(trx, tenantId, prefix);
        const row = {
          tenant_id: tenantId,
          number,
          tracking_code: generateTrackingCode(),
          status: "pending",
          ...Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [column, input[key] === "" ? null : input[key]])),
          customer_id: customerId,
          recipient_name: recipientName,
          recipient_address: recipientAddress,
          recipient_phone: recipientPhone,
          created_by: req.user.id,
          created_at: now,
          updated_at: now,
        };
        const shipmentId = await insertAndGetId(trx, "shipments", row);
        await trx("shipment_events").insert({ shipment_id: shipmentId, status: "pending", location: input.originCity, note: STATUS_NOTES.pending, actor_id: req.user.id, occurred_at: now });
        if (input.driverId) await notifyAssigned(trx, req, input.driverId, row);
        return shipmentId;
      });
      break;
    } catch (error) {
      // Two bookings raced for the same number (or, astronomically rarely, the same code): try again.
      if (attempt < 4 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
  const detail = await loadDetail(db, req, id);
  await recordTenantAudit(db, req, "shipment.create", detail.number, { recipient: detail.recipientName, destination: detail.destinationCity });
  publishShipment(req, id, detail.status);
  res.status(201).json(detail);
});

router.patch("/shipments/:id", requirePermission("logistics.edit", "logistics.dispatch"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findShipment(db, req, id);
  const body = req.body ?? {};
  const sent = Object.keys(body).filter(key => key in COLUMNS);
  const assigning = sent.filter(key => ASSIGNMENT_FIELDS.includes(key));
  if (assigning.length && !can(req, "logistics.dispatch")) throw forbidden("You don't have permission to assign carriers, vehicles, or drivers.");
  if (sent.length > assigning.length && !can(req, "logistics.edit")) throw forbidden("You don't have permission to edit shipments.");
  if (TERMINAL_STATUSES.includes(current.status)) throw new HttpError(409, `A ${current.status} shipment can't be edited.`, { code: "LOCKED" });

  const input = validate(shipmentSchema.partial(), body);
  const changes = sentOnly(input, body, COLUMNS);
  if ("order_id" in changes) await findOrder(db, tenantId, changes.order_id);
  if ("customer_id" in changes) await findCustomer(db, tenantId, changes.customer_id);
  if ("carrier_id" in changes && changes.carrier_id !== current.carrier_id) await assertCarrier(db, tenantId, changes.carrier_id);
  if ("vehicle_id" in changes && changes.vehicle_id !== current.vehicle_id) await assertVehicle(db, tenantId, changes.vehicle_id);
  if ("driver_id" in changes && changes.driver_id !== current.driver_id) await assertDriver(db, tenantId, changes.driver_id);
  if ("recipient_name" in changes && !changes.recipient_name) throw invalid("recipientName", "Who is it going to?");
  if ("recipient_address" in changes && !changes.recipient_address) throw invalid("recipientAddress", "Add the delivery address.");
  if ("packages" in changes && changes.packages == null) throw invalid("packages", "At least 1 package.");
  for (const field of ["direction", "service"]) if (field in changes && changes[field] == null) throw invalid(field, "Pick one.");
  assertDates(changes.ship_date !== undefined ? changes.ship_date : current.ship_date, changes.expected_on !== undefined ? changes.expected_on : current.expected_on);

  const driverChanged = "driver_id" in changes && changes.driver_id !== current.driver_id;
  const vehicleChanged = "vehicle_id" in changes && changes.vehicle_id !== current.vehicle_id;
  const carrierChanged = "carrier_id" in changes && changes.carrier_id !== current.carrier_id;
  if (Object.keys(changes).length) {
    await db.transaction(async trx => {
      await trx("shipments").where({ id }).update({ ...changes, updated_at: nowIso() });
      if (vehicleChanged) {
        await syncVehicle(trx, tenantId, current.vehicle_id);
        await syncVehicle(trx, tenantId, changes.vehicle_id);
      }
      if (driverChanged && changes.driver_id) await notifyAssigned(trx, req, changes.driver_id, { ...current, ...changes });
    });
  }
  const detail = await loadDetail(db, req, id);
  if (driverChanged || vehicleChanged || carrierChanged) {
    await recordTenantAudit(db, req, "shipment.assign", detail.number, { carrier: detail.carrier?.name ?? null, vehicle: detail.vehicle?.registration ?? null, driver: detail.driver?.name ?? null });
  }
  // The public tracking page shows the route and expected date, so it refreshes on edits too.
  if (Object.keys(changes).length) publishShipment(req, id, current.status, current.tracking_code);
  res.json(detail);
});

router.post("/shipments/:id/status", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findShipment(db, req, id);
  const input = validate(
    z.object({ status: z.enum(SHIPMENT_STATUSES), location: optionalText(120), note: optionalText(300), receivedBy: optionalText(120), occurredAt }),
    req.body ?? {}
  );

  const dispatcher = can(req, "logistics.dispatch");
  if (!dispatcher) {
    if (!can(req, "logistics.deliver")) throw forbidden("You don't have permission to update shipment status.");
    if (current.driver_id !== req.user.id) throw forbidden("You can only update shipments assigned to you.");
    if (!DRIVER_STATUSES.includes(input.status)) throw forbidden("Ask a dispatcher to make this change.");
  }
  if (!canTransition(current.status, input.status)) {
    const next = TRANSITIONS[current.status];
    throw new HttpError(409, `A ${current.status.replaceAll("_", " ")} shipment can't be marked ${input.status.replaceAll("_", " ")}${next.length ? `. Next: ${next.join(", ")}.` : "."}`, { code: "INVALID_STATUS" });
  }
  if (input.status === "delivered" && settingsOf(req).requireProofOfDelivery && !input.receivedBy) throw invalid("receivedBy", "Enter the name of the person who received it.");

  const occurred = eventTime(input.occurredAt);
  const changes = { status: input.status, updated_at: nowIso() };
  if (input.status === "delivered") Object.assign(changes, { delivered_at: occurred, received_by: input.receivedBy || null });
  if (input.status === "picked_up" && !current.ship_date) changes.ship_date = occurred.slice(0, 10);

  await db.transaction(async trx => {
    await trx("shipments").where({ id }).update(changes);
    const note = input.note || STATUS_NOTES[input.status]; // the receiver's name stays on the shipment: events are public
    await trx("shipment_events").insert({ shipment_id: id, status: input.status, location: input.location || null, note: note.slice(0, 300), actor_id: req.user.id, occurred_at: occurred });
    await syncVehicle(trx, tenantId, current.vehicle_id);
    if (["delivered", "failed"].includes(input.status)) {
      await notifyUsers(trx, [current.created_by], {
        title: `${current.number} ${input.status === "delivered" ? "delivered" : "delivery failed"}`,
        body: `${req.user.name} marked ${current.number} for ${current.recipient_name} ${input.status === "delivered" ? "delivered" : "failed"}${input.note ? `: ${input.note}` : "."}`,
        actorId: req.user.id,
      });
    }
  });
  if (["cancelled", "returned"].includes(input.status)) await recordTenantAudit(db, req, `shipment.${input.status === "cancelled" ? "cancel" : "return"}`, current.number, input.note ? { note: input.note } : null);
  publishShipment(req, id, input.status, current.tracking_code);
  res.json(await loadDetail(db, req, id));
});

router.post("/shipments/:id/events", async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const current = await findShipment(db, req, id);
  const input = validate(z.object({ location: optionalText(120), note: z.string().trim().min(1, "Write a note.").max(300), occurredAt }), req.body ?? {});
  const staff = can(req, "logistics.edit") || can(req, "logistics.dispatch");
  if (!staff && !(can(req, "logistics.deliver") && current.driver_id === req.user.id)) throw forbidden("You can only add updates to shipments assigned to you.");
  await db("shipment_events").insert({ shipment_id: id, status: current.status, location: input.location || null, note: input.note, actor_id: req.user.id, occurred_at: eventTime(input.occurredAt) });
  await db("shipments").where({ id, tenant_id: req.user.tenant_id }).update({ updated_at: nowIso() });
  publishShipment(req, id, current.status, current.tracking_code);
  res.status(201).json(await loadDetail(db, req, id));
});

router.delete("/shipments/:id", requirePermission("logistics.dispatch"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const current = await findShipment(db, req, id);
  if (!["pending", "cancelled"].includes(current.status)) throw new HttpError(409, "Only pending or cancelled shipments can be deleted.", { code: "LOCKED" });
  await db("shipments").where({ id, tenant_id: req.user.tenant_id }).delete();
  await recordTenantAudit(db, req, "shipment.delete", current.number, { recipient: current.recipient_name });
  publishShipment(req, id, "deleted", current.tracking_code);
  res.status(204).end();
});

// ---- Export ----
const csvCell = value => {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`; // keep spreadsheets from running it as a formula
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get("/export", requirePermission("logistics.view", "logistics.edit", "logistics.dispatch"), async (req, res) => {
  const q = validate(z.object({ from: dateOnly.optional(), to: dateOnly.optional(), status: z.enum(SHIPMENT_STATUSES).optional() }), req.query);
  const rows = await applyFilters(shipmentsQuery(getDb(), req.user.tenant_id), req, q).orderBy("s.id").limit(50_000);
  const header = "number,tracking_code,status,direction,service,carrier,carrier_reference,driver,vehicle,recipient_name,recipient_phone,origin_city,destination_city,packages,weight_kg,declared_value,shipping_cost,cod_amount,ship_date,expected_on,delivered_at,received_by,created_at";
  const lines = [
    header,
    ...rows.map(row =>
      [
        row.number, row.tracking_code, row.status, row.direction, row.service, row.carrier_name, row.carrier_reference, row.driver_name, row.vehicle_registration,
        row.recipient_name, row.recipient_phone, row.origin_city, row.destination_city, row.packages, num(row.weight_kg), num(row.declared_value), num(row.shipping_cost),
        num(row.cod_amount), row.ship_date, row.expected_on, row.delivered_at, row.received_by, row.created_at,
      ]
        .map(csvCell)
        .join(",")
    ),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="shipments-${todayIso()}.csv"`);
  res.send(lines.join("\r\n"));
});

// ---- Carriers ----
const carrierSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  code: optionalText(30),
  trackingUrl: z
    .string()
    .trim()
    .max(300)
    .refine(value => !value || /^https?:\/\/\S+$/i.test(value), "Enter a web address starting with http:// or https://.")
    .refine(value => !value || value.includes("{code}"), "Include {code} where the tracking number goes.")
    .nullable()
    .default(null),
  phone: optionalText(40),
  email: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable().default(null),
  isActive: z.boolean().default(true),
});
const CARRIER_COLUMNS = { name: "name", code: "code", trackingUrl: "tracking_url", phone: "phone", email: "email", isActive: "is_active" };

const toCarrier = row => ({
  id: row.id,
  name: row.name,
  code: row.code,
  trackingUrl: row.tracking_url,
  phone: row.phone,
  email: row.email,
  isActive: Boolean(row.is_active),
  activeShipments: Number(row.active_shipments ?? 0),
  totalShipments: Number(row.total_shipments ?? 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function carriersQuery(db, tenantId) {
  const active = db("shipments").count("*").whereRaw("shipments.carrier_id = c.id").whereNotIn("shipments.status", TERMINAL_STATUSES).as("active_shipments");
  const total = db("shipments").count("*").whereRaw("shipments.carrier_id = c.id").as("total_shipments");
  return db("carriers as c").where("c.tenant_id", tenantId).select("c.*", active, total);
}

async function findCarrier(db, tenantId, id) {
  const row = await carriersQuery(db, tenantId).where("c.id", id).first();
  if (!row) throw new HttpError(404, "Carrier not found.");
  return row;
}

async function assertCarrierName(db, tenantId, name, exceptId = null) {
  const query = db("carriers").where("tenant_id", tenantId).whereRaw("lower(name) = ?", [name.toLowerCase()]);
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) throw invalid("name", "You already have a carrier with this name.");
}

router.get("/carriers", async (req, res) => {
  const q = validate(z.object({ status: z.enum(["active", "inactive", "all"]).default("all") }), req.query);
  const query = carriersQuery(getDb(), req.user.tenant_id).orderByRaw("lower(c.name)");
  if (q.status !== "all") query.where("c.is_active", q.status === "active");
  res.json((await query).map(toCarrier));
});

router.post("/carriers", requirePermission("logistics.fleet.manage"), async (req, res) => {
  const input = validate(carrierSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertCarrierName(db, tenantId, input.name);
  const now = nowIso();
  const id = await insertAndGetId(db, "carriers", {
    tenant_id: tenantId,
    name: input.name,
    code: input.code || null,
    tracking_url: input.trackingUrl || null,
    phone: input.phone || null,
    email: input.email || null,
    is_active: input.isActive,
    created_at: now,
    updated_at: now,
  });
  await recordTenantAudit(db, req, "carrier.create", input.name);
  res.status(201).json(toCarrier(await findCarrier(db, tenantId, id)));
});

router.patch("/carriers/:id", requirePermission("logistics.fleet.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await findCarrier(db, tenantId, id);
  const input = validate(carrierSchema.partial(), req.body ?? {});
  const changes = sentOnly(input, req.body, CARRIER_COLUMNS);
  if ("name" in changes) {
    if (!changes.name) throw invalid("name", "Name is required.");
    await assertCarrierName(db, tenantId, changes.name, id);
  }
  if ("is_active" in changes && changes.is_active == null) delete changes.is_active;
  if (Object.keys(changes).length) await db("carriers").where({ id }).update({ ...changes, updated_at: nowIso() });
  const row = await findCarrier(db, tenantId, id);
  await recordTenantAudit(db, req, "carrier.update", row.name, { fields: Object.keys(changes) });
  res.json(toCarrier(row));
});

router.delete("/carriers/:id", requirePermission("logistics.fleet.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const row = await findCarrier(db, tenantId, id);
  if (Number(row.total_shipments) > 0) {
    // Shipments keep their history: retire the carrier instead.
    await db("carriers").where({ id, tenant_id: tenantId }).update({ is_active: false, updated_at: nowIso() });
    await recordTenantAudit(db, req, "carrier.deactivate", row.name);
    return res.json({ deleted: false, carrier: toCarrier(await findCarrier(db, tenantId, id)) });
  }
  await db("carriers").where({ id, tenant_id: tenantId }).delete();
  await recordTenantAudit(db, req, "carrier.delete", row.name);
  res.json({ deleted: true, carrier: null });
});

// ---- Vehicles ----
const vehicleSchema = z.object({
  registration: z
    .string()
    .trim()
    .min(1, "Registration is required.")
    .max(30)
    .transform(value => value.toUpperCase().replace(/\s+/g, " ")),
  type: z.enum(VEHICLE_TYPES).default("van"),
  capacityKg: z.coerce.number().positive("Enter a capacity above zero.").max(1e6).nullable().default(null),
  status: z.enum(VEHICLE_STATUSES).default("available"),
  driverId: optionalId,
  notes: optionalText(300),
});
const VEHICLE_COLUMNS = { registration: "registration", type: "type", capacityKg: "capacity_kg", status: "status", driverId: "driver_id", notes: "notes" };

const toVehicle = row => ({
  id: row.id,
  registration: row.registration,
  type: row.type,
  capacityKg: num(row.capacity_kg),
  status: row.status,
  driver: row.driver_id ? { id: row.driver_id, name: row.driver_name } : null,
  notes: row.notes,
  activeShipments: Number(row.active_shipments ?? 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function vehiclesQuery(db, tenantId) {
  const active = db("shipments").count("*").whereRaw("shipments.vehicle_id = v.id").whereNotIn("shipments.status", TERMINAL_STATUSES).as("active_shipments");
  return db("vehicles as v").leftJoin("users as d", "d.id", "v.driver_id").where("v.tenant_id", tenantId).select("v.*", "d.name as driver_name", active);
}

async function findVehicle(db, tenantId, id) {
  const row = await vehiclesQuery(db, tenantId).where("v.id", id).first();
  if (!row) throw new HttpError(404, "Vehicle not found.");
  return row;
}

async function assertRegistration(db, tenantId, registration, exceptId = null) {
  const query = db("vehicles").where("tenant_id", tenantId).whereRaw("upper(registration) = ?", [registration.toUpperCase()]);
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) throw invalid("registration", "A vehicle with this registration already exists.");
}

router.get("/vehicles", async (req, res) => {
  const q = validate(z.object({ status: z.enum(VEHICLE_STATUSES).optional() }), req.query);
  const query = vehiclesQuery(getDb(), req.user.tenant_id).orderBy("v.registration");
  if (q.status) query.where("v.status", q.status);
  res.json((await query).map(toVehicle));
});

router.post("/vehicles", requirePermission("logistics.fleet.manage"), async (req, res) => {
  const input = validate(vehicleSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertRegistration(db, tenantId, input.registration);
  await assertDriver(db, tenantId, input.driverId);
  const now = nowIso();
  const id = await insertAndGetId(db, "vehicles", {
    tenant_id: tenantId,
    registration: input.registration,
    type: input.type,
    capacity_kg: input.capacityKg,
    status: input.status,
    driver_id: input.driverId,
    notes: input.notes || null,
    created_at: now,
    updated_at: now,
  });
  await recordTenantAudit(db, req, "vehicle.create", input.registration);
  res.status(201).json(toVehicle(await findVehicle(db, tenantId, id)));
});

router.patch("/vehicles/:id", requirePermission("logistics.fleet.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findVehicle(db, tenantId, id);
  const input = validate(vehicleSchema.partial(), req.body ?? {});
  const changes = sentOnly(input, req.body, VEHICLE_COLUMNS);
  if ("registration" in changes) {
    if (!changes.registration) throw invalid("registration", "Registration is required.");
    await assertRegistration(db, tenantId, changes.registration, id);
  }
  for (const field of ["type", "status"]) if (field in changes && changes[field] == null) throw invalid(field, "Pick one.");
  if ("driver_id" in changes && changes.driver_id !== current.driver_id) await assertDriver(db, tenantId, changes.driver_id);
  if (Object.keys(changes).length) await db("vehicles").where({ id }).update({ ...changes, updated_at: nowIso() });
  const row = await findVehicle(db, tenantId, id);
  await recordTenantAudit(db, req, "vehicle.update", row.registration, { fields: Object.keys(changes) });
  res.json(toVehicle(row));
});

router.delete("/vehicles/:id", requirePermission("logistics.fleet.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const row = await findVehicle(db, tenantId, id);
  if (Number(row.active_shipments) > 0) throw new HttpError(409, "This vehicle still has shipments on it. Reassign them first.", { code: "IN_USE" });
  if (await db("shipments").where({ tenant_id: tenantId, vehicle_id: id }).first("id")) {
    // Past shipments keep their history: retire the vehicle instead.
    await db("vehicles").where({ id, tenant_id: tenantId }).update({ status: "retired", driver_id: null, updated_at: nowIso() });
    await recordTenantAudit(db, req, "vehicle.retire", row.registration);
    return res.json({ deleted: false, vehicle: toVehicle(await findVehicle(db, tenantId, id)) });
  }
  await db("vehicles").where({ id, tenant_id: tenantId }).delete();
  await recordTenantAudit(db, req, "vehicle.delete", row.registration);
  res.json({ deleted: true, vehicle: null });
});

// ---- Drivers ----
router.get("/drivers", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const ids = [...(await eligibleDriverIds(db, tenantId))];
  if (!ids.length) return res.json([]);
  const active = db("shipments").count("*").whereRaw("shipments.driver_id = u.id").whereNotIn("shipments.status", TERMINAL_STATUSES).as("active_shipments");
  const [users, vehicles] = await Promise.all([
    db("users as u").where({ "u.tenant_id": tenantId, "u.is_active": true }).whereIn("u.id", ids).select("u.id", "u.name", "u.email", "u.job_title", active).orderByRaw("lower(u.name)"),
    db("vehicles").where("tenant_id", tenantId).whereIn("driver_id", ids).whereNot("status", "retired").select("id", "registration", "driver_id").orderBy("id"),
  ]);
  const vehicleOf = new Map();
  for (const vehicle of vehicles) if (!vehicleOf.has(vehicle.driver_id)) vehicleOf.set(vehicle.driver_id, { id: vehicle.id, registration: vehicle.registration });
  res.json(
    users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      jobTitle: user.job_title,
      activeShipments: Number(user.active_shipments ?? 0),
      vehicle: vehicleOf.get(user.id) ?? null,
    }))
  );
});

export default router;
