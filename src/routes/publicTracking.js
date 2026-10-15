// Public shipment tracking: anyone with a tracking code sees its progress. No sign-in, and no personal
// details (recipient, addresses, phone numbers, drivers). A missing code, a suspended workspace, and a
// workspace that turned public tracking off all look the same from outside.
import { Router } from "express";
import { findInAnyDatabase } from "../services/tenantDatabases.js";
import { maintenanceError, workspaceMaintenance } from "../services/maintenance.js";
import { resolveSettings } from "../services/moduleSettings.js";
import { effectiveFeatures } from "../services/tenants.js";
import { TRACKING_CODE_PATTERN } from "../services/logistics.js";
import { HttpError } from "../utils/http.js";

const router = Router();

const notFound = () => new HttpError(404, "We couldn't find a shipment with that tracking code.", { code: "NOT_FOUND" });

router.get("/:code", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const code = String(req.params.code ?? "").trim().toUpperCase();
  if (!TRACKING_CODE_PATTERN.test(code)) throw notFound();

  // Tracking codes carry no workspace: look in every database (tenants may have their own).
  const found = await findInAnyDatabase(lookup => lookup("shipments as s")
    .join("tenants as t", "t.id", "s.tenant_id")
    .leftJoin("carriers as c", "c.id", "s.carrier_id")
    .where("s.tracking_code", code)
    .whereNull("t.deleted_at") // a tenant in the recycle bin is gone for the public
    .select("s.*", "t.name as tenant_name", "t.status as tenant_status", "t.features as tenant_features", "t.settings as tenant_settings", "t.maintenance as tenant_maintenance", "c.name as carrier_name")
    .first());
  if (!found) throw notFound();
  const { db, value: row } = found;
  if (!row || row.tenant_status !== "active" || !effectiveFeatures(row.tenant_features, resolveSettings(row.tenant_settings)).includes("logistics")) throw notFound();
  const { active: maintenance } = await workspaceMaintenance(db, row.tenant_maintenance);
  if (maintenance) throw maintenanceError(maintenance);
  const settings = resolveSettings(row.tenant_settings);
  if (!settings.logistics.publicTracking) throw notFound();

  const events = await db("shipment_events").where("shipment_id", row.id).select("status", "location", "note", "occurred_at").orderBy("occurred_at", "desc").orderBy("id", "desc");
  res.json({
    trackingCode: row.tracking_code,
    number: row.number,
    status: row.status,
    service: row.service,
    originCity: row.origin_city,
    destinationCity: row.destination_city,
    expectedOn: row.expected_on,
    deliveredAt: row.delivered_at,
    packages: Number(row.packages),
    carrier: row.carrier_id ? { name: row.carrier_name } : null,
    events: events.map(event => ({ status: event.status, location: event.location, note: event.note, occurredAt: event.occurred_at })),
    company: settings.branding?.siteTitle || row.tenant_name,
  });
});

export default router;
