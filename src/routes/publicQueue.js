// Public token status: a patient follows their clinic token on their phone with the code printed on the token
// slip (/q/<code>). No sign-in, and nothing personal: no patient name, phone, MRN or reason. An unknown code, a
// suspended workspace, a workspace without the clinic module, and a token from another day all look the same.
import { Router } from "express";
import { findInAnyDatabase } from "../services/tenantDatabases.js";
import { addDays, clinicNow, IN_QUEUE, PUBLIC_CODE_PATTERN, queueFigures } from "../services/clinic.js";
import { maintenanceError, workspaceMaintenance } from "../services/maintenance.js";
import { resolveSettings } from "../services/moduleSettings.js";
import { effectiveFeatures } from "../services/tenants.js";
import { HttpError } from "../utils/http.js";

const router = Router();

const notFound = () => new HttpError(404, "We couldn't find a token with that code. Check the link on your token slip.", { code: "NOT_FOUND" });

/** What the patient sees: waiting, called (go to the room), in_progress, completed, cancelled, no_show. */
const publicStatus = row => (row.status === "checked_in" ? (row.called_at ? "called" : "waiting") : row.status);

router.get("/:code", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const code = String(req.params.code ?? "").trim().toUpperCase();
  if (!PUBLIC_CODE_PATTERN.test(code)) throw notFound();

  // Token codes carry no workspace: look in every database (tenants may have their own).
  const found = await findInAnyDatabase(lookup => lookup("appointments as a")
    .join("tenants as t", "t.id", "a.tenant_id")
    .join("users as u", "u.id", "a.provider_id")
    .leftJoin("clinic_providers as p", "p.user_id", "a.provider_id")
    .where("a.public_code", code)
    .whereNull("t.deleted_at") // a tenant in the recycle bin is gone for the public
    .select("a.id", "a.tenant_id", "a.provider_id", "a.status", "a.token_number", "a.token_date", "a.called_at", "u.name as provider_name", "p.room", "p.specialty", "p.slot_minutes", "t.name as tenant_name", "t.status as tenant_status", "t.features as tenant_features", "t.settings as tenant_settings", "t.maintenance as tenant_maintenance")
    .first());
  if (!found) throw notFound();
  const { db, value: row } = found;
  if (!row || row.token_number == null || row.tenant_status !== "active" || !effectiveFeatures(row.tenant_features, resolveSettings(row.tenant_settings)).includes("clinic")) throw notFound();
  const { active: maintenance } = await workspaceMaintenance(db, row.tenant_maintenance);
  if (maintenance) throw maintenanceError(maintenance);
  const today = clinicNow(req).date;
  if (row.token_date < addDays(today, -1) || row.token_date > addDays(today, 1)) throw notFound();

  const day = await db("appointments")
    .where({ tenant_id: row.tenant_id, provider_id: row.provider_id, token_date: row.token_date })
    .select("id", "status", "token_number", "called_at", "completed_at", "updated_at");
  const figures = queueFigures(day);
  const mine = day.find(item => item.id === row.id);
  const status = publicStatus(row);
  // Ahead of you: waiting patients with an earlier token who haven't been called yet.
  const aheadOfYou = status === "waiting" ? figures.waiting.filter(item => !item.called_at && item.token_number < row.token_number).length : 0;
  const perPatient = figures.averageConsultMinutes ?? (row.slot_minutes ? Number(row.slot_minutes) : null);
  const busy = figures.nowServing && figures.nowServing !== mine && IN_QUEUE.includes(figures.nowServing.status) ? 1 : 0;
  const estimatedWaitMinutes = status === "waiting" && perPatient != null ? Math.round((aheadOfYou + busy) * perPatient) : null;

  const settings = resolveSettings(row.tenant_settings);
  res.json({
    token: row.token_number,
    date: row.token_date,
    status,
    provider: { name: row.provider_name, room: row.room ?? null, specialty: row.specialty ?? null },
    nowServing: figures.nowServing?.token_number ?? null,
    aheadOfYou,
    estimatedWaitMinutes,
    calledAt: row.called_at ?? null,
    clinicName: settings.company?.legalName || settings.branding?.siteTitle || row.tenant_name,
  });
});

export default router;
