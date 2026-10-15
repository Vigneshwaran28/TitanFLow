// Provider console: maintenance windows (mounted by admin.js at /api/bunny/maintenance, behind requireAdmin).
//   GET  /              the platform window and every tenant's, with their state (off, scheduled, active, ended)
//   PUT  /platform      set the window for every tenant
//   PUT  /tenants/:id   set one tenant's window
// Saving ends the live connections of the people it affects, so their tabs re-check and show (or leave) the
// maintenance page right away.
import { Router } from "express";
import { z } from "zod";
import { getPlatformDb as getDb } from "../db/connection.js";
import { updateTenantRow } from "../services/tenantDatabases.js";
import { getGlobalMaintenance, maintenanceState, parseMaintenance, setGlobalMaintenance, withState } from "../services/maintenance.js";
import { disconnectTenantSockets } from "../services/realtime.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const isoTime = z
  .string()
  .trim()
  .refine(value => !Number.isNaN(Date.parse(value)), "Enter a valid date and time.")
  .transform(value => new Date(value).toISOString());

const windowSchema = z
  .object({
    enabled: z.boolean(),
    message: z.string().trim().max(500, "Use at most 500 characters.").default(""),
    /** null = from now */
    startsAt: isoTime.nullable().default(null),
    /** null = until switched off */
    endsAt: isoTime.nullable().default(null),
    /** workspace owners and admins can still sign in */
    allowAdmins: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt && value.startsAt && value.endsAt <= value.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start." });
    if (value.enabled && value.endsAt && Date.parse(value.endsAt) <= Date.now()) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end is already past." });
  });

/** "off -> active" style details for the audit log. */
const describe = (before, after) => ({ from: maintenanceState(before), to: maintenanceState(after), startsAt: after.startsAt, endsAt: after.endsAt, allowAdmins: after.allowAdmins });

/** @param {{ requireAdmin: import("express").RequestHandler, audit: Function }} deps */
export function consoleMaintenanceRouter({ requireAdmin, audit }) {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res) => {
    const db = getDb();
    const [platform, tenants] = await Promise.all([getGlobalMaintenance(db), db("tenants").whereNull("deleted_at").orderBy("name").select("id", "name", "slug", "status", "maintenance")]);
    res.json({
      platform: withState(platform),
      tenants: tenants.map(tenant => ({ id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, maintenance: withState(parseMaintenance(tenant.maintenance)) })),
    });
  });

  router.put("/platform", async (req, res) => {
    const input = validate(windowSchema, req.body ?? {});
    const db = getDb();
    const before = await getGlobalMaintenance(db);
    const window = { ...input, updatedAt: nowIso(), updatedBy: req.admin.username };
    await setGlobalMaintenance(db, window);
    disconnectTenantSockets(null, "Maintenance changed");
    await audit(req, "maintenance_platform", "platform", describe(before, window));
    res.json(withState(window));
  });

  router.put("/tenants/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(windowSchema, req.body ?? {});
    const db = getDb();
    const tenant = await db("tenants").where({ id }).whereNull("deleted_at").first();
    if (!tenant) throw new HttpError(404, "Tenant not found.");
    const before = parseMaintenance(tenant.maintenance);
    const window = { ...input, updatedAt: nowIso(), updatedBy: req.admin.username };
    await updateTenantRow(id, { maintenance: JSON.stringify(window), updated_at: nowIso() });
    disconnectTenantSockets(id, "Maintenance changed");
    await audit(req, "maintenance_tenant", `tenants#${id}`, describe(before, window), id);
    res.json(withState(window));
  });

  return router;
}
