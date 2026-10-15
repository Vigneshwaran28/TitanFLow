// Patient portal (/api/patient): patients sign in at /<workspace>/patient/login with their patient number and PIN
// (issued by reception: POST /api/clinic/patients and /patients/:id/portal-pin) and see their own tokens today, live,
// and their past visits and prescriptions. Read-only, and only ever the signed-in patient's own records.
// The workspace comes from the X-Workspace header (or ?ws=, or `workspace` in the sign-in body), like staff requests.
// Sessions are separate from staff sessions (services/patientPortal.js). The portal closes, like the app, for a
// suspended or expired workspace, one without the clinic module, and during maintenance (patients never bypass it).
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { requestedWorkspace } from "../middleware/auth.js";
import { addDays, ageOn, bmiOf, clinicNow, IN_QUEUE, minutesOf, queueFigures, timeOf } from "../services/clinic.js";
import { maintenanceError, workspaceMaintenance } from "../services/maintenance.js";
import { resolveSettings } from "../services/moduleSettings.js";
import {
  endPortalSession,
  MAX_PIN_FAILURES,
  PATIENT_NUMBER_PATTERN,
  PIN_LOCK_MINUTES,
  PIN_PATTERN,
  pinMatches,
  portalCookie,
  startPortalSession,
  verifyPortalToken,
} from "../services/patientPortal.js";
import { subscriptionExpired } from "../services/subscriptionDates.js";
import { effectiveFeatures } from "../services/tenants.js";
import { HttpError, nowIso, validate } from "../utils/http.js";

const router = Router();
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const unavailable = () => new HttpError(404, "This clinic doesn't have a patient portal. Check the address on your card.", { code: "NOT_FOUND" });
const signInAgain = (message = "Please sign in.") => new HttpError(401, message, { code: "UNAUTHENTICATED" });

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

/** The workspace behind a portal request, with every check that closes the portal. */
async function loadClinic(db, slug) {
  if (!slug || !SLUG.test(slug)) throw unavailable();
  const tenant = await db("tenants").where({ slug }).first();
  if (!tenant || tenant.deleted_at) throw unavailable();
  const settings = resolveSettings(tenant.settings);
  if (!effectiveFeatures(tenant.features, settings).includes("clinic")) throw unavailable();
  if (tenant.status !== "active" || subscriptionExpired(tenant.subscription_ends_on, tenant.grace_days)) {
    throw new HttpError(403, "The patient portal isn't available right now. Please contact the clinic.", { code: "TENANT_SUSPENDED" });
  }
  const { active } = await workspaceMaintenance(db, tenant.maintenance);
  if (active) throw maintenanceError(active);
  return { tenant, settings };
}

const clinicInfo = (tenant, settings) => ({
  name: settings.company?.legalName || settings.branding?.siteTitle || tenant.name,
  phone: settings.company?.phone || null,
  email: settings.company?.email || null,
  address: settings.company?.address || null,
});

const fullName = row => [row.first_name, row.last_name].filter(Boolean).join(" ");

// ---- Sign-in throttling ----
// Per patient number: MAX_PIN_FAILURES wrong PINs lock it for PIN_LOCK_MINUTES (stored, so it survives restarts).
// Per IP address: IP_MAX_FAILURES wrong sign-ins in a window stop guessing across many patient numbers.
const IP_MAX_FAILURES = 20;
const IP_WINDOW_MS = 15 * 60 * 1000;
const ipFailures = new Map();
// Compared against when the patient number is unknown, so a wrong number takes as long as a wrong PIN.
const DUMMY_HASH = bcrypt.hashSync("not-a-pin", 10);

const tooMany = minutes =>
  new HttpError(429, `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or ask the clinic to reset your PIN.`, { code: "TOO_MANY_ATTEMPTS" });

function checkIp(key) {
  const entry = ipFailures.get(key);
  if (!entry) return;
  if (Date.now() > entry.resetAt) return ipFailures.delete(key);
  if (entry.count >= IP_MAX_FAILURES) throw tooMany(Math.ceil((entry.resetAt - Date.now()) / 60_000));
}

function recordIpFailure(key) {
  const entry = ipFailures.get(key);
  if (!entry || Date.now() > entry.resetAt) ipFailures.set(key, { count: 1, resetAt: Date.now() + IP_WINDOW_MS });
  else entry.count += 1;
  if (ipFailures.size > 10_000) for (const [ip, value] of ipFailures) if (Date.now() > value.resetAt) ipFailures.delete(ip);
}

const loginSchema = z.object({
  patientNumber: z
    .string({ error: "Enter the patient number from your card." })
    .transform(value => value.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(PATIENT_NUMBER_PATTERN, "Enter the 8-digit patient number from your card.")),
  pin: z.string({ error: "Enter your 6-digit PIN." }).trim().regex(PIN_PATTERN, "Enter your 6-digit PIN."),
  workspace: z.string().trim().toLowerCase().optional(),
});

router.post("/login", async (req, res) => {
  const input = validate(loginSchema, req.body);
  const slug = requestedWorkspace(req) ?? (input.workspace && SLUG.test(input.workspace) ? input.workspace : null);
  const ipKey = req.ip ?? "unknown";
  checkIp(ipKey);
  const db = getDb();
  const { tenant, settings } = await loadClinic(db, slug);
  const patient = await db("patients").where({ tenant_id: tenant.id, portal_number: input.patientNumber }).first();
  const now = nowIso();
  if (patient?.portal_locked_until && patient.portal_locked_until > now) throw tooMany(Math.max(1, Math.ceil((Date.parse(patient.portal_locked_until) - Date.now()) / 60_000)));

  const matches = patient?.portal_pin_hash ? await pinMatches(input.pin, patient.portal_pin_hash) : (await bcrypt.compare(input.pin, DUMMY_HASH)) && false;
  if (!matches) {
    recordIpFailure(ipKey);
    if (patient) {
      const failures = Number(patient.portal_failed_attempts ?? 0) + 1;
      const locked = failures >= MAX_PIN_FAILURES;
      await db("patients")
        .where({ id: patient.id })
        .update({ portal_failed_attempts: locked ? 0 : failures, portal_locked_until: locked ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString() : null });
      if (locked) throw tooMany(PIN_LOCK_MINUTES);
    }
    throw new HttpError(401, "Incorrect patient number or PIN.", { code: "INVALID_CREDENTIALS" });
  }
  if (!patient.is_active) throw new HttpError(403, "Your patient record isn't active. Please contact the clinic.", { code: "PATIENT_INACTIVE" });
  await db("patients").where({ id: patient.id }).update({ portal_failed_attempts: 0, portal_locked_until: null, portal_last_login_at: now });
  startPortalSession(res, { patientId: patient.id, tenantId: tenant.id, slug: tenant.slug });
  res.json(profile(patient, tenant, settings, clinicNow(req).date));
});

router.post("/logout", (req, res) => {
  const slug = requestedWorkspace(req) ?? (typeof req.body?.workspace === "string" && SLUG.test(req.body.workspace) ? req.body.workspace : null);
  if (slug) endPortalSession(res, slug);
  res.status(204).end();
});

/** Loads the signed-in patient of the request's workspace into req.portal, or answers 401. */
async function requirePatient(req, res, next) {
  const slug = requestedWorkspace(req);
  const token = slug ? req.cookies?.[portalCookie(slug)] : null;
  if (!token) throw signInAgain();
  const payload = verifyPortalToken(token);
  if (!payload || payload.ws !== slug) {
    endPortalSession(res, slug);
    throw signInAgain("Your session has expired. Please sign in again.");
  }
  const db = getDb();
  const { tenant, settings } = await loadClinic(db, slug);
  const patient = payload.tid === tenant.id ? await db("patients").where({ id: Number(payload.sub), tenant_id: tenant.id }).first() : null;
  // A new PIN (reset by the clinic) ends sessions signed in with the old one.
  const revoked = !patient?.portal_pin_hash || (patient.portal_pin_set_at && Number(payload.iatMs ?? 0) < Date.parse(patient.portal_pin_set_at));
  if (!patient || !patient.is_active || revoked) {
    endPortalSession(res, slug);
    throw signInAgain("Please sign in again.");
  }
  req.portal = { db, tenant, settings, patient };
  next();
}

function profile(patient, tenant, settings, today) {
  return {
    patient: {
      name: fullName(patient),
      firstName: patient.first_name,
      patientNumber: patient.portal_number,
      mrn: patient.mrn,
      age: ageOn(patient.date_of_birth, today),
      ageEstimated: Boolean(patient.dob_estimated),
      gender: patient.gender ?? null,
      bloodGroup: patient.blood_group ?? null,
      allergies: patient.allergies ?? null,
      chronicConditions: patient.chronic_conditions ?? null,
    },
    clinic: clinicInfo(tenant, settings),
    workspace: tenant.slug,
  };
}

router.get("/me", requirePatient, (req, res) => {
  const { patient, tenant, settings } = req.portal;
  res.json(profile(patient, tenant, settings, clinicNow(req).date));
});

/** What the patient sees: waiting, called (go to the room), in_progress, completed, cancelled, no_show. */
const portalStatus = row => (row.status === "checked_in" ? (row.called_at ? "called" : "waiting") : row.status);

const appointmentRows = (db, tenantId) =>
  db("appointments as a")
    .join("users as u", "u.id", "a.provider_id")
    .leftJoin("clinic_providers as p", "p.user_id", "a.provider_id")
    .where("a.tenant_id", tenantId)
    .select("a.id", "a.provider_id", "a.status", "a.type", "a.start_at", "a.token_number", "a.token_date", "a.called_at", "a.public_code", "u.name as provider_name", "p.room", "p.specialty", "p.slot_minutes");

const providerOf = row => ({ name: row.provider_name, room: row.room ?? null, specialty: row.specialty ?? null });

// Today's tokens with their live place in the queue, today's booked appointments not yet checked in, and what's next.
// The expected time is the clinic's clock now plus the estimated wait (the browser sends its clock as `now`).
router.get("/tokens", requirePatient, async (req, res) => {
  const { db, tenant, patient } = req.portal;
  const now = clinicNow(req);
  const mine = await appointmentRows(db, tenant.id)
    .where("a.patient_id", patient.id)
    .where(inner => inner.where("a.token_date", now.date).orWhere(day => day.whereNull("a.token_date").where("a.start_at", ">=", `${now.date}T00:00`).where("a.start_at", "<=", `${addDays(now.date, 60)}T99`)))
    .orderBy("a.start_at");

  const queues = new Map();
  const dayOf = async providerId => {
    if (!queues.has(providerId)) {
      queues.set(providerId, await db("appointments").where({ tenant_id: tenant.id, provider_id: providerId, token_date: now.date }).whereNotNull("token_number").select("id", "status", "token_number", "called_at", "completed_at", "updated_at"));
    }
    return queues.get(providerId);
  };

  const tokens = [];
  for (const row of mine.filter(item => item.token_number != null && item.token_date === now.date)) {
    const day = await dayOf(row.provider_id);
    const figures = queueFigures(day);
    const status = portalStatus(row);
    const self = day.find(item => item.id === row.id);
    // Ahead of you: waiting patients with an earlier token who haven't been called yet.
    const aheadOfYou = status === "waiting" ? figures.waiting.filter(item => !item.called_at && item.token_number < row.token_number).length : 0;
    const perPatient = figures.averageConsultMinutes ?? (row.slot_minutes ? Number(row.slot_minutes) : null);
    const busy = figures.nowServing && figures.nowServing !== self && IN_QUEUE.includes(figures.nowServing.status) ? 1 : 0;
    const estimatedWaitMinutes = status === "waiting" && perPatient != null ? Math.round((aheadOfYou + busy) * perPatient) : null;
    const expectedMinute = estimatedWaitMinutes == null ? null : minutesOf(now.time) + estimatedWaitMinutes;
    tokens.push({
      appointmentId: row.id,
      token: row.token_number,
      date: row.token_date,
      status,
      provider: providerOf(row),
      nowServing: figures.nowServing?.token_number ?? null,
      aheadOfYou,
      nextInLine: status === "waiting" && aheadOfYou === 0,
      estimatedWaitMinutes,
      /** Clinic-local "HH:MM" (null when unknown or after midnight) */
      expectedAt: expectedMinute != null && expectedMinute < 24 * 60 ? timeOf(expectedMinute) : null,
      calledAt: row.called_at ?? null,
      /** For live updates on the public channel queue:<code> */
      publicCode: row.public_code,
    });
  }
  const booked = mine
    .filter(item => item.token_number == null && ["scheduled", "confirmed"].includes(item.status))
    .map(item => ({ appointmentId: item.id, date: item.start_at.slice(0, 10), time: item.start_at.slice(11), type: item.type, status: item.status, provider: providerOf(item) }));
  res.json({ date: now.date, time: now.time, tokens, today: booked.filter(item => item.date === now.date), upcoming: booked.filter(item => item.date > now.date).slice(0, 5) });
});

// Past visits with prescriptions, newest first. The doctor's examination notes stay internal; the patient sees the
// complaint, vitals, diagnosis, advice (plan), follow-up and medicines.
router.get("/visits", requirePatient, async (req, res) => {
  const { db, tenant, settings, patient } = req.portal;
  const visits = await db("clinic_visits as v")
    .leftJoin("users as u", "u.id", "v.provider_id")
    .leftJoin("clinic_providers as p", "p.user_id", "v.provider_id")
    .where({ "v.tenant_id": tenant.id, "v.patient_id": patient.id })
    .orderBy("v.visit_date", "desc")
    .orderBy("v.id", "desc")
    .limit(100)
    .select("v.*", "u.name as provider_name", "p.specialty", "p.qualification", "p.registration_no");
  const items = visits.length ? await db("prescriptions").whereIn("visit_id", visits.map(visit => visit.id)).orderBy("position").orderBy("id") : [];
  const parse = json => {
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  };
  res.json({
    clinic: clinicInfo(tenant, settings),
    patient: { name: fullName(patient), patientNumber: patient.portal_number, mrn: patient.mrn, gender: patient.gender ?? null, allergies: patient.allergies ?? null, dateOfBirth: patient.date_of_birth ?? null, ageEstimated: Boolean(patient.dob_estimated) },
    visits: visits.map(visit => {
      const vitals = parse(visit.vitals);
      return {
        id: visit.id,
        visitDate: visit.visit_date,
        age: ageOn(patient.date_of_birth, visit.visit_date),
        provider: visit.provider_id ? { name: visit.provider_name, specialty: visit.specialty ?? null, qualification: visit.qualification ?? null, registrationNo: visit.registration_no ?? null } : null,
        chiefComplaint: visit.chief_complaint,
        vitals,
        bmi: bmiOf(vitals),
        diagnosis: visit.diagnosis,
        plan: visit.plan,
        followUpOn: visit.follow_up_on,
        prescriptions: items
          .filter(item => item.visit_id === visit.id)
          .map(item => ({ id: item.id, medicine: item.medicine, dosage: item.dosage, frequency: item.frequency, duration: item.duration, route: item.route, instructions: item.instructions })),
      };
    }),
  });
});

export default router;
