// Clinic: practitioners and their weekly schedules, patients (with medical record numbers), the appointment
// book, and visits with prescriptions. Clinical data (visits, vitals, diagnoses, prescriptions) is private:
// only people with "clinic.records.view", or a practitioner who has seen or is booked with the patient, can
// read it, and every read of a patient's record and every visit change is audited. Allergies and chronic
// conditions are safety information and show to anyone who can see the patient.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { concatSql } from "../db/dialects.js";
import { can, requirePermission } from "../middleware/auth.js";
import { ACCENTS } from "../services/moduleSettings.js";
import { notifyUsers } from "../services/notify.js";
import { usersWithPermission } from "../services/permissions.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import {
  addDays,
  addMinutes,
  announceQueue,
  CLINIC_PERMISSIONS,
  IN_QUEUE,
  nextToken,
  queueFigures,
  timeOf,
  withTokenRetry,
  ageOn,
  bmiOf,
  CLOSING_HOLIDAYS,
  clinicNow,
  describeRanges,
  estimatedDateOfBirth,
  isStamp,
  minutesOf,
  parseSchedule,
  rangesOn,
  realDate,
  scheduleSchema,
  SLOT_HOLDING,
  slotsFor,
  WEEKDAY_NAMES,
  withinRanges,
} from "../services/clinic.js";
import { issuePortalCredentials } from "../services/patientPortal.js";
import { publish } from "../services/realtime.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

export const APPOINTMENT_STATUSES = ["scheduled", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"];
/** Allowed status changes; completed, cancelled and no_show are final. */
export const TRANSITIONS = Object.freeze({
  scheduled: ["confirmed", "checked_in", "cancelled", "no_show"],
  confirmed: ["checked_in", "cancelled", "no_show"],
  checked_in: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
});
const CLOSED_STATUSES = ["completed", "cancelled", "no_show"];
const GENDERS = ["female", "male", "other", "unknown"];
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const MAX_PRESCRIPTIONS = 30;

const settingsOf = req => req.tenant.settings.clinic;
const invalid = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { errors: { [field]: message } });
const forbidden = message => new HttpError(403, message, { code: "FORBIDDEN" });

/** Sees the whole appointment book (and every patient's demographics). Nurses need it to find checked-in patients. */
const seesSchedule = req => can(req, "clinic.schedule.view") || can(req, "clinic.appointments.manage") || can(req, "clinic.records.view") || can(req, "clinic.vitals.record");
const seesAllPatients = req => seesSchedule(req) || can(req, "clinic.patients.manage");
const isPractitioner = req => can(req, "clinic.practitioner");

const optionalText = max => z.string().trim().max(max).nullable().optional();
const dateOnly = z.string().refine(realDate, "Use a date like 2026-10-31.");
const stamp = z.string().refine(isStamp, "Use a date and time like 2026-10-31T09:30.");
const blank = value => (value === "" || value === undefined ? null : value);

/** Keeps only the keys the client actually sent, so schema defaults never overwrite stored values. */
const sentOnly = (input, body, map) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key in (body ?? {}) && map[key])
      .map(([key, value]) => [map[key], blank(value)])
  );

const fullName = row => [row.first_name, row.last_name].filter(Boolean).join(" ");

// ---- Practitioners ----
const providerSchema = z.object({
  specialty: z.string().trim().min(1, "Enter a specialty, e.g. General medicine.").max(80),
  qualification: optionalText(120),
  registrationNo: optionalText(60),
  slotMinutes: z.number().int().min(5, "At least 5 minutes.").max(240, "At most 240 minutes.").optional(),
  consultationFee: z.number().min(0, "Can't be negative.").max(1e9).nullable().optional(),
  room: optionalText(40),
  schedule: scheduleSchema,
  isAccepting: z.boolean().default(true),
  color: z.enum(ACCENTS).default("teal"),
});

const toProvider = (row, req) => ({
  userId: row.user_id,
  name: row.user_name,
  jobTitle: row.user_job_title ?? null,
  isActive: Boolean(row.user_is_active),
  specialty: row.specialty,
  qualification: row.qualification,
  registrationNo: row.registration_no,
  slotMinutes: Number(row.slot_minutes),
  consultationFee: row.consultation_fee == null ? null : Number(row.consultation_fee),
  room: row.room,
  schedule: parseSchedule(row.schedule),
  isAccepting: Boolean(row.is_accepting),
  color: row.color,
  isMe: row.user_id === req.user.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const providersQuery = (db, tenantId) =>
  db("clinic_providers as p")
    .join("users as u", "u.id", "p.user_id")
    .where("p.tenant_id", tenantId)
    .select("p.*", "u.name as user_name", "u.job_title as user_job_title", "u.is_active as user_is_active");

async function findProvider(db, tenantId, userId, field = "providerId") {
  const row = await providersQuery(db, tenantId).where("p.user_id", userId).first();
  if (!row || !row.user_is_active) {
    if (field) throw invalid(field, "Choose a practitioner set up in the clinic.");
    throw new HttpError(404, "Practitioner not found.");
  }
  return row;
}

router.get("/providers", async (req, res) => {
  const q = validate(z.object({ includeInactive: z.enum(["true", "false"]).optional() }), req.query);
  const query = providersQuery(getDb(), req.user.tenant_id).orderByRaw("lower(u.name)");
  if (q.includeInactive !== "true") query.where("u.is_active", true);
  res.json((await query).map(row => toProvider(row, req)));
});

router.get("/providers/candidates", requirePermission("clinic.providers.manage"), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const ids = await usersWithPermission(db, tenantId, "clinic.practitioner");
  if (!ids.length) return res.json([]);
  const rows = await db("users as u")
    .leftJoin("clinic_providers as p", "p.user_id", "u.id")
    .whereIn("u.id", ids)
    .where({ "u.tenant_id": tenantId, "u.is_active": true })
    .whereNull("p.user_id")
    .orderByRaw("lower(u.name)")
    .select("u.id", "u.name", "u.email", "u.job_title");
  res.json(rows.map(row => ({ id: row.id, name: row.name, email: row.email, jobTitle: row.job_title ?? null })));
});

router.put("/providers/:userId", async (req, res) => {
  const userId = parseId(req.params.userId);
  const self = userId === req.user.id && isPractitioner(req);
  if (!self && !can(req, "clinic.providers.manage")) throw forbidden("Only clinic admins can set up other practitioners.");
  const input = validate(providerSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const user = await db("users").where({ id: userId, tenant_id: tenantId, is_active: true }).first();
  if (!user) throw invalid("userId", "Choose an active person in your workspace.");
  if (!(await usersWithPermission(db, tenantId, "clinic.practitioner")).includes(userId)) {
    throw invalid("userId", `${user.name} needs a role with the practitioner permission first.`);
  }
  const existing = await db("clinic_providers").where({ user_id: userId, tenant_id: tenantId }).first();
  const now = nowIso();
  const values = {
    specialty: input.specialty,
    qualification: blank(input.qualification) ?? null,
    registration_no: blank(input.registrationNo) ?? null,
    slot_minutes: input.slotMinutes ?? existing?.slot_minutes ?? settingsOf(req).defaultSlotMinutes,
    consultation_fee: input.consultationFee ?? null,
    room: blank(input.room) ?? null,
    schedule: JSON.stringify(input.schedule),
    is_accepting: input.isAccepting,
    color: input.color,
    updated_at: now,
  };
  if (existing) await db("clinic_providers").where({ user_id: userId }).update(values);
  else await db("clinic_providers").insert({ user_id: userId, tenant_id: tenantId, ...values, created_at: now });
  await recordTenantAudit(db, req, existing ? "clinic.provider.update" : "clinic.provider.create", user.name, { specialty: input.specialty, slotMinutes: values.slot_minutes });
  res.status(existing ? 200 : 201).json(toProvider(await providersQuery(db, tenantId).where("p.user_id", userId).first(), req));
});

router.delete("/providers/:userId", requirePermission("clinic.providers.manage"), async (req, res) => {
  const userId = parseId(req.params.userId);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const row = await providersQuery(db, tenantId).where("p.user_id", userId).first();
  if (!row) throw new HttpError(404, "Practitioner not found.");
  const upcoming = await db("appointments")
    .where({ tenant_id: tenantId, provider_id: userId })
    .whereIn("status", ["scheduled", "confirmed", "checked_in", "in_progress"])
    .where("start_at", ">=", clinicNow(req).date)
    .count({ count: "*" })
    .first();
  if (Number(upcoming.count)) {
    throw new HttpError(409, `${row.user_name} has ${upcoming.count} upcoming appointment(s). Reschedule or cancel them first.`, { code: "HAS_APPOINTMENTS" });
  }
  await db("clinic_providers").where({ user_id: userId }).delete();
  await recordTenantAudit(db, req, "clinic.provider.delete", row.user_name);
  res.status(204).end();
});

// ---- Availability ----
async function closingHolidays(db, tenantId, from, to) {
  const rows = await db("holidays").where("tenant_id", tenantId).whereBetween("holiday_date", [from, to]).whereIn("type", CLOSING_HOLIDAYS).select("holiday_date", "name");
  const byDate = new Map();
  for (const row of rows) if (!byDate.has(row.holiday_date)) byDate.set(row.holiday_date, row.name);
  return byDate;
}

const bookedQuery = (db, tenantId, providerId, from, to) =>
  db("appointments")
    .where({ tenant_id: tenantId, provider_id: providerId })
    .whereIn("status", SLOT_HOLDING)
    .where("start_at", "<", `${to}T99`)
    .where("end_at", ">", `${from}T00:00`)
    .select("id", "start_at", "end_at");

function dayAvailability(req, provider, day, holidays, booked, now) {
  const slotMinutes = Number(provider.slot_minutes);
  const holiday = holidays.get(day);
  const base = { date: day, providerId: provider.user_id, slotMinutes };
  if (holiday) return { ...base, closed: holiday, slots: [] };
  if (!provider.is_accepting) return { ...base, closed: "not accepting appointments", slots: [] };
  const ranges = rangesOn(parseSchedule(provider.schedule), day);
  if (!ranges.length) return { ...base, closed: "not working", slots: [] };
  const lastBookableDay = addDays(now.date, settingsOf(req).bookingWindowDays);
  return { ...base, closed: null, slots: slotsFor({ ranges, slotMinutes, day, booked: booked.filter(row => row.start_at.startsWith(day) || row.end_at.startsWith(day)), now, lastBookableDay }) };
}

router.get("/availability", async (req, res) => {
  const q = validate(z.object({ providerId: z.coerce.number().int().positive(), date: dateOnly }), req.query);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const provider = await findProvider(db, tenantId, q.providerId);
  const [holidays, booked] = await Promise.all([closingHolidays(db, tenantId, q.date, q.date), bookedQuery(db, tenantId, provider.user_id, q.date, q.date)]);
  res.json(dayAvailability(req, provider, q.date, holidays, booked, clinicNow(req)));
});

router.get("/availability/next", async (req, res) => {
  const q = validate(z.object({ providerId: z.coerce.number().int().positive(), from: dateOnly.optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const provider = await findProvider(db, tenantId, q.providerId);
  const now = clinicNow(req);
  const first = q.from && q.from > now.date ? q.from : now.date;
  const last = addDays(now.date, settingsOf(req).bookingWindowDays);
  const slots = [];
  if (first <= last) {
    const [holidays, booked] = await Promise.all([closingHolidays(db, tenantId, first, last), bookedQuery(db, tenantId, provider.user_id, first, last)]);
    for (let day = first; day <= last && slots.length < q.limit; day = addDays(day, 1)) {
      for (const slot of dayAvailability(req, provider, day, holidays, booked, now).slots) {
        if (slot.available) slots.push({ date: day, start: slot.start, end: slot.end });
        if (slots.length >= q.limit) break;
      }
    }
  }
  res.json({ providerId: provider.user_id, slotMinutes: Number(provider.slot_minutes), slots });
});

// ---- Patients ----
const dateOfBirth = dateOnly.refine(value => value <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), "The date of birth can't be in the future.").refine(value => value >= "1900-01-01", "Check the year.");

const patientSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(80),
  lastName: optionalText(80),
  dateOfBirth: dateOfBirth.nullable().optional(),
  /** When the date of birth isn't known: the age in years, stored as an estimated date of birth. */
  ageYears: z.number({ error: "Enter the age in whole years." }).int("Enter the age in whole years.").min(0, "The age can't be negative.").max(130, "Check the age.").nullable().optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  phone: z.string().trim().max(40).regex(/^[0-9+()\-.\s]*$/, "Use digits, spaces, and + - ( ) only.").nullable().optional(),
  email: z.union([z.email("Enter a valid email address."), z.literal("")]).nullable().optional(),
  address: optionalText(500),
  bloodGroup: z.union([z.enum(BLOOD_GROUPS), z.literal("")]).nullable().optional(),
  allergies: optionalText(500),
  chronicConditions: optionalText(500),
  emergencyContactName: optionalText(120),
  emergencyContactPhone: optionalText(40),
  insuranceProvider: optionalText(120),
  insuranceNumber: optionalText(60),
  notes: optionalText(5000),
});

const PATIENT_COLUMNS = {
  firstName: "first_name",
  lastName: "last_name",
  dateOfBirth: "date_of_birth",
  gender: "gender",
  phone: "phone",
  email: "email",
  address: "address",
  bloodGroup: "blood_group",
  allergies: "allergies",
  chronicConditions: "chronic_conditions",
  emergencyContactName: "emergency_contact_name",
  emergencyContactPhone: "emergency_contact_phone",
  insuranceProvider: "insurance_provider",
  insuranceNumber: "insurance_number",
  notes: "notes",
};

const toPatient = (row, today) => ({
  id: row.id,
  mrn: row.mrn,
  firstName: row.first_name,
  lastName: row.last_name,
  name: fullName(row),
  dateOfBirth: row.date_of_birth,
  age: ageOn(row.date_of_birth, today),
  /** The date of birth was worked out from an age: show "~N yrs" */
  dobEstimated: Boolean(row.dob_estimated),
  gender: row.gender,
  phone: row.phone,
  email: row.email,
  address: row.address,
  bloodGroup: row.blood_group,
  allergies: row.allergies,
  chronicConditions: row.chronic_conditions,
  emergencyContactName: row.emergency_contact_name,
  emergencyContactPhone: row.emergency_contact_phone,
  insuranceProvider: row.insurance_provider,
  insuranceNumber: row.insurance_number,
  notes: row.notes,
  isActive: Boolean(row.is_active),
  /** Patient portal sign-in id (null until portal access is issued); the PIN is never returned after it's issued */
  patientNumber: row.portal_number ?? null,
  hasPortalAccess: Boolean(row.portal_pin_hash),
  portalPinSetAt: row.portal_pin_set_at ?? null,
  portalLastLoginAt: row.portal_last_login_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * date_of_birth and dob_estimated from a patient form: a real date of birth wins; otherwise an age in years becomes
 * an estimated date of birth. Only fields the client sent count. `current` (when editing) keeps an estimate that
 * still gives the same age, so re-saving a form doesn't move the estimated birthday.
 */
function birthColumns(input, body, today, current = null) {
  const sent = key => key in (body ?? {});
  if (sent("dateOfBirth") && input.dateOfBirth) return { date_of_birth: input.dateOfBirth, dob_estimated: false };
  if (sent("ageYears") && input.ageYears != null) {
    if (current?.dob_estimated && ageOn(current.date_of_birth, today) === input.ageYears) return { date_of_birth: current.date_of_birth, dob_estimated: true };
    return { date_of_birth: estimatedDateOfBirth(input.ageYears, today), dob_estimated: true };
  }
  if (sent("dateOfBirth") || sent("ageYears")) return { date_of_birth: null, dob_estimated: false };
  return {};
}

/** Where a workspace's patients sign in to the portal. */
const portalLoginPath = req => `/${req.tenant.slug}/patient/login`;

/** Patients a practitioner without the wider clinic access may see: those booked with or seen by them. */
const myPatientIds = (db, req) =>
  db("appointments").where({ tenant_id: req.user.tenant_id, provider_id: req.user.id }).whereNot("status", "cancelled").select("patient_id").union(db("clinic_visits").where({ tenant_id: req.user.tenant_id, provider_id: req.user.id }).select("patient_id"));

/** Loads a patient the user may see (404 otherwise). */
async function findPatient(db, req, id) {
  const patient = await db("patients").where({ id, tenant_id: req.user.tenant_id }).first();
  if (!patient) throw new HttpError(404, "Patient not found.");
  if (!seesAllPatients(req) && !(await hasRelationship(db, req, id))) throw new HttpError(404, "Patient not found.");
  return patient;
}

async function hasRelationship(db, req, patientId) {
  if (!isPractitioner(req)) return false;
  const tenantId = req.user.tenant_id;
  const [appointment, visit] = await Promise.all([
    db("appointments").where({ tenant_id: tenantId, provider_id: req.user.id, patient_id: patientId }).whereNot("status", "cancelled").first("id"),
    db("clinic_visits").where({ tenant_id: tenantId, provider_id: req.user.id, patient_id: patientId }).first("id"),
  ]);
  return Boolean(appointment || visit);
}

/** Clinical records: records.view, or a practitioner booked with / who has seen the patient. */
const canSeeRecord = async (db, req, patientId) => can(req, "clinic.records.view") || hasRelationship(db, req, patientId);

const digits = value => String(value ?? "").replace(/\D/g, "");

async function findDuplicate(db, tenantId, input) {
  if (input.email) {
    const byEmail = await db("patients").where("tenant_id", tenantId).whereRaw("lower(email) = ?", [input.email.toLowerCase()]).first();
    if (byEmail) return byEmail;
  }
  if (input.phone && digits(input.phone)) {
    const sameName = await db("patients").where("tenant_id", tenantId).whereRaw("lower(first_name) = ?", [input.firstName.toLowerCase()]).whereNotNull("phone").select("*");
    const match = sameName.find(row => digits(row.phone) === digits(input.phone));
    if (match) return match;
  }
  return null;
}

/** Next MRN for the tenant: prefix + 5-digit sequence, continuing from the highest number in use. */
async function nextMrn(trx, tenantId, prefix) {
  const rows = await trx("patients").where("tenant_id", tenantId).where("mrn", "like", `${prefix}%`).select("mrn");
  let max = 0;
  for (const row of rows) {
    const rest = row.mrn.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${String(max + 1).padStart(5, "0")}`;
}

router.get("/patients", async (req, res) => {
  const q = validate(
    z.object({
      search: z.string().trim().max(100).optional(),
      status: z.enum(["active", "inactive", "all"]).default("active"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
    req.query
  );
  const db = getDb();
  const query = db("patients").where("tenant_id", req.user.tenant_id);
  if (!seesAllPatients(req)) query.whereIn("id", myPatientIds(db, req));
  if (q.status !== "all") query.where("is_active", q.status === "active");
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    const phoneDigits = digits(q.search);
    query.where(inner => {
      inner
        .whereRaw(`lower(${concatSql(db, "first_name", "' '", "coalesce(last_name, '')")}) like ?`, [term])
        .orWhereRaw("lower(coalesce(last_name, '')) like ?", [term])
        .orWhereRaw("lower(mrn) like ?", [term])
        .orWhereRaw("coalesce(portal_number, '') like ?", [`%${q.search}%`])
        .orWhereRaw("lower(coalesce(email, '')) like ?", [term])
        .orWhereRaw("coalesce(phone, '') like ?", [`%${q.search}%`]);
      if (phoneDigits.length >= 4) inner.orWhereRaw("replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '+', ''), '.', '') like ?", [`%${phoneDigits}%`]);
    });
  }
  const [{ total }] = await query.clone().count({ total: "id" });
  const rows = await query.orderByRaw("lower(first_name)").orderByRaw("lower(coalesce(last_name, ''))").orderBy("id").limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const today = clinicNow(req).date;
  const totalCount = Number(total);
  res.json({ items: rows.map(row => toPatient(row, today)), page: q.page, pageSize: q.pageSize, total: totalCount, totalPages: Math.max(1, Math.ceil(totalCount / q.pageSize)) });
});

router.post("/patients", requirePermission("clinic.patients.manage"), async (req, res) => {
  const input = validate(patientSchema.extend({ confirmDuplicate: z.boolean().default(false) }), req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const today = clinicNow(req).date;
  if (!input.confirmDuplicate) {
    const duplicate = await findDuplicate(db, tenantId, input);
    if (duplicate) {
      return res.status(409).json({
        message: `${fullName(duplicate)} (${duplicate.mrn}) looks like the same person. Open the existing record, or confirm to register a new patient anyway.`,
        code: "POSSIBLE_DUPLICATE",
        patient: toPatient(duplicate, today),
      });
    }
  }
  const prefix = settingsOf(req).mrnPrefix ?? "MRN-";
  const now = nowIso();
  let id;
  let credentials;
  for (let attempt = 0; ; attempt++) {
    try {
      // Every new patient gets portal credentials: a patient number and a PIN shown once (below) for their card.
      ({ id, credentials } = await db.transaction(async trx => {
        const values = { tenant_id: tenantId, mrn: await nextMrn(trx, tenantId, prefix), is_active: true, created_by: req.user.id, created_at: now, updated_at: now };
        for (const [key, column] of Object.entries(PATIENT_COLUMNS)) values[column] = blank(input[key]) ?? null;
        Object.assign(values, birthColumns(input, req.body, today));
        const patientId = await insertAndGetId(trx, "patients", values);
        return { id: patientId, credentials: await issuePortalCredentials(trx, { id: patientId, tenant_id: tenantId }, now) };
      }));
      break;
    } catch (error) {
      if (attempt >= 3 || !/unique|duplicate/i.test(error.message)) throw error;
    }
  }
  const patient = await db("patients").where({ id }).first();
  await recordTenantAudit(db, req, "patient.create", `${fullName(patient)} (${patient.mrn})`);
  res.status(201).json({ ...toPatient(patient, today), portalCredentials: { ...credentials, loginPath: portalLoginPath(req) } });
});

// Issues portal access to a patient registered before the portal (or without it), or resets a forgotten PIN. The new
// PIN is returned once; earlier portal sessions end and any lock from wrong PINs is cleared.
router.post("/patients/:id/portal-pin", requirePermission("clinic.patients.manage"), async (req, res) => {
  const db = getDb();
  const patient = await findPatient(db, req, parseId(req.params.id));
  if (!patient.is_active) throw new HttpError(422, "This patient record is deactivated. Reactivate it to issue portal access.", { code: "PATIENT_INACTIVE" });
  let credentials;
  for (let attempt = 0; ; attempt++) {
    try {
      credentials = await db.transaction(trx => issuePortalCredentials(trx, patient, nowIso()));
      break;
    } catch (error) {
      if (attempt >= 3 || !/unique|duplicate/i.test(error.message)) throw error;
    }
  }
  await recordTenantAudit(db, req, patient.portal_pin_hash ? "patient.portal.reset" : "patient.portal.issue", `${fullName(patient)} (${patient.mrn})`, { patientId: patient.id });
  const updated = await db("patients").where({ id: patient.id }).first();
  res.json({ ...credentials, loginPath: portalLoginPath(req), patient: toPatient(updated, clinicNow(req).date) });
});

router.get("/patients/:id", async (req, res) => {
  const db = getDb();
  const patient = await findPatient(db, req, parseId(req.params.id));
  const now = clinicNow(req);
  const appointments = (await appointmentsQuery(db, req.user.tenant_id).where("a.patient_id", patient.id).orderBy("a.start_at", "desc").limit(200)).map(toAppointment);
  const upcoming = appointments.filter(item => item.start >= now.date && !CLOSED_STATUSES.includes(item.status)).reverse();
  const past = appointments.filter(item => !upcoming.includes(item));

  let record = null;
  const canViewRecord = await canSeeRecord(db, req, patient.id);
  if (canViewRecord) {
    const visits = await visitsQuery(db, req.user.tenant_id).where("v.patient_id", patient.id).orderBy("v.visit_date", "desc").orderBy("v.id", "desc");
    record = { visits: await withPrescriptions(db, visits) };
    await recordTenantAudit(db, req, "patient.record.view", `${fullName(patient)} (${patient.mrn})`, { patientId: patient.id, visits: visits.length });
  }
  res.json({ ...toPatient(patient, now.date), upcomingAppointments: upcoming, pastAppointments: past, canViewRecord, record });
});

router.patch("/patients/:id", requirePermission("clinic.patients.manage"), async (req, res) => {
  const db = getDb();
  const patient = await findPatient(db, req, parseId(req.params.id));
  const input = validate(patientSchema.partial(), req.body ?? {});
  const changes = { ...sentOnly(input, req.body, PATIENT_COLUMNS), ...birthColumns(input, req.body, clinicNow(req).date, patient) };
  if ("firstName" in changes && !changes.first_name) throw invalid("firstName", "First name is required.");
  if (Object.keys(changes).length) {
    await db("patients").where({ id: patient.id }).update({ ...changes, updated_at: nowIso() });
    await recordTenantAudit(db, req, "patient.update", `${fullName(patient)} (${patient.mrn})`, { fields: Object.keys(input).filter(key => key in (req.body ?? {})) });
  }
  res.json(toPatient(await db("patients").where({ id: patient.id }).first(), clinicNow(req).date));
});

for (const [action, active] of [["deactivate", false], ["reactivate", true]]) {
  router.post(`/patients/:id/${action}`, requirePermission("clinic.patients.manage"), async (req, res) => {
    const db = getDb();
    const patient = await findPatient(db, req, parseId(req.params.id));
    if (Boolean(patient.is_active) !== active) {
      await db("patients").where({ id: patient.id }).update({ is_active: active, updated_at: nowIso() });
      await recordTenantAudit(db, req, `patient.${action}`, `${fullName(patient)} (${patient.mrn})`);
    }
    res.json(toPatient(await db("patients").where({ id: patient.id }).first(), clinicNow(req).date));
  });
}

// ---- Appointments ----
// The patient summary on an appointment: demographics and safety information (allergies, chronic conditions), which
// everyone who can see the appointment may see. Age is on the appointment's day.
const toAppointment = row => ({
  id: row.id,
  patient: {
    id: row.patient_id,
    mrn: row.patient_mrn,
    name: fullName({ first_name: row.patient_first_name, last_name: row.patient_last_name }),
    phone: row.patient_phone ?? null,
    age: ageOn(row.patient_date_of_birth ?? null, row.start_at.slice(0, 10)),
    ageEstimated: Boolean(row.patient_dob_estimated),
    gender: row.patient_gender ?? null,
    bloodGroup: row.patient_blood_group ?? null,
    allergies: row.patient_allergies ?? null,
    chronicConditions: row.patient_chronic_conditions ?? null,
    patientNumber: row.patient_portal_number ?? null,
  },
  provider: { userId: row.provider_id, name: row.provider_name, color: row.provider_color ?? "teal", room: row.provider_room ?? null, specialty: row.provider_specialty ?? null },
  start: row.start_at,
  end: row.end_at,
  date: row.start_at.slice(0, 10),
  startTime: row.start_at.slice(11),
  endTime: row.end_at.slice(11),
  durationMinutes: minutesOf(row.end_at.slice(11)) - minutesOf(row.start_at.slice(11)),
  type: row.type,
  status: row.status,
  reason: row.reason,
  notes: row.notes,
  cancelReason: row.cancel_reason,
  checkedInAt: row.checked_in_at,
  completedAt: row.completed_at,
  visitId: row.visit_id ?? null,
  token: row.token_number ?? null,
  tokenDate: row.token_date ?? null,
  calledAt: row.called_at ?? null,
  callCount: Number(row.call_count ?? 0),
  publicCode: row.public_code ?? null,
  /** A nurse recorded vitals before the doctor (the values themselves: `triage`, for clinical staff only) */
  triageRecorded: Boolean(row.triage_at),
  createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Vitals and the chief complaint recorded before the doctor (PUT /appointments/:id/triage). Clinical data: only for
 * the appointment's practitioner, clinic.records.view and clinic.vitals.record; null for everyone else.
 */
function triageOf(req, row) {
  if (!row.triage_at) return null;
  const allowed = can(req, "clinic.records.view") || can(req, "clinic.vitals.record") || (isPractitioner(req) && row.provider_id === req.user.id);
  if (!allowed) return null;
  const vitals = parseVitals(row.triage_vitals);
  return { vitals, bmi: bmiOf(vitals), chiefComplaint: row.triage_complaint ?? null, recordedBy: row.triage_by ? { id: row.triage_by, name: row.triage_by_name ?? null } : null, recordedAt: row.triage_at };
}

/** An appointment with its triage, for the people allowed to see it. */
const withTriage = (req, row) => ({ ...toAppointment(row), triage: triageOf(req, row) });

function appointmentsQuery(db, tenantId) {
  return db("appointments as a")
    .join("patients as pt", "pt.id", "a.patient_id")
    .join("users as pu", "pu.id", "a.provider_id")
    .leftJoin("clinic_providers as cp", "cp.user_id", "a.provider_id")
    .leftJoin("users as cb", "cb.id", "a.created_by")
    .leftJoin("users as tb", "tb.id", "a.triage_by")
    .leftJoin("clinic_visits as v", "v.appointment_id", "a.id")
    .where("a.tenant_id", tenantId)
    .select(
      "a.*",
      "pt.mrn as patient_mrn",
      "pt.first_name as patient_first_name",
      "pt.last_name as patient_last_name",
      "pt.phone as patient_phone",
      "pt.date_of_birth as patient_date_of_birth",
      "pt.dob_estimated as patient_dob_estimated",
      "pt.gender as patient_gender",
      "pt.blood_group as patient_blood_group",
      "pt.allergies as patient_allergies",
      "pt.chronic_conditions as patient_chronic_conditions",
      "pt.portal_number as patient_portal_number",
      "tb.name as triage_by_name",
      "pu.name as provider_name",
      "cp.color as provider_color",
      "cp.room as provider_room",
      "cp.specialty as provider_specialty",
      "cb.name as created_by_name",
      "v.id as visit_id"
    );
}

/** Loads an appointment the user may see: the whole book, or their own as practitioner. */
async function findAppointment(db, req, id) {
  const row = await appointmentsQuery(db, req.user.tenant_id).where("a.id", id).first();
  if (!row || (!seesSchedule(req) && row.provider_id !== req.user.id)) throw new HttpError(404, "Appointment not found.");
  return row;
}

const bookingSchema = z.object({
  patientId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  start: stamp,
  durationMinutes: z.number().int().min(5, "At least 5 minutes.").max(480, "At most 8 hours.").optional(),
  type: z.string().trim().min(1).max(20).default("consultation"),
  reason: optionalText(300),
  notes: optionalText(1000),
  force: z.boolean().default(false),
});

const at = value => `${value.slice(0, 10)} at ${value.slice(11)}`;

/**
 * Validates a booking; throws 422 for invalid times and 409 SLOT_TAKEN for clashes.
 * `force` (front desk) books on holidays, outside hours, and over clashes; never in the past or beyond the window.
 */
async function assertBookable(db, req, { patient, provider, start, end, excludeId, force }) {
  const settings = settingsOf(req);
  const tenantId = req.user.tenant_id;
  const now = clinicNow(req);
  const day = start.slice(0, 10);
  const startMin = minutesOf(start.slice(11));
  const endMin = startMin + (minutesOf(end.slice(11)) - startMin);
  if (endMin > 24 * 60 || end.slice(0, 10) !== day) throw invalid("durationMinutes", "The appointment must end on the same day.");
  if (start < now.stamp) throw invalid("start", "That time has already passed. Pick a time later than now.");
  const lastDay = addDays(now.date, settings.bookingWindowDays);
  if (day > lastDay) throw invalid("start", `Appointments can be booked up to ${settings.bookingWindowDays} days ahead (until ${lastDay}).`);
  if (!patient.is_active) throw invalid("patientId", "This patient record is deactivated. Reactivate it to book.");

  if (!force) {
    if (!provider.is_accepting) throw invalid("providerId", `${provider.user_name} isn't accepting appointments right now.`);
    const holiday = (await closingHolidays(db, tenantId, day, day)).get(day);
    if (holiday) throw invalid("start", `The clinic is closed on ${day} for ${holiday}.`);
    const ranges = rangesOn(parseSchedule(provider.schedule), day);
    const weekday = WEEKDAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()];
    if (!ranges.length) throw invalid("start", `${provider.user_name} doesn't work on ${weekday}s.`);
    if (!withinRanges(ranges, startMin, endMin)) throw invalid("start", `That's outside ${provider.user_name}'s hours on ${weekday} (${describeRanges(ranges)}).`);
  }

  if (force || settings.allowOverbooking) return;
  const overlapping = query => {
    query.where("a.start_at", "<", end).where("a.end_at", ">", start).whereIn("a.status", SLOT_HOLDING);
    if (excludeId) query.whereNot("a.id", excludeId);
    return query.first();
  };
  const providerClash = await overlapping(appointmentsQuery(db, tenantId).where("a.provider_id", provider.user_id));
  if (providerClash) {
    throw new HttpError(409, `${provider.user_name} already has ${fullName({ first_name: providerClash.patient_first_name, last_name: providerClash.patient_last_name })} booked ${providerClash.start_at.slice(11)}–${providerClash.end_at.slice(11)} on ${day}. Pick another time.`, {
      code: "SLOT_TAKEN",
      errors: { start: "This time is already booked." },
    });
  }
  const patientClash = await overlapping(appointmentsQuery(db, tenantId).where("a.patient_id", patient.id));
  if (patientClash) {
    throw new HttpError(409, `${fullName(patient)} already has an appointment with ${patientClash.provider_name} ${patientClash.start_at.slice(11)}–${patientClash.end_at.slice(11)} on ${day}.`, {
      code: "SLOT_TAKEN",
      errors: { start: "The patient has another appointment at this time." },
    });
  }
}

function assertType(req, type) {
  if (!settingsOf(req).appointmentTypes.includes(type)) throw invalid("type", `Pick one of: ${settingsOf(req).appointmentTypes.join(", ")}.`);
}

async function bookablePatient(db, tenantId, patientId) {
  const patient = await db("patients").where({ id: patientId, tenant_id: tenantId }).first();
  if (!patient) throw invalid("patientId", "Choose a registered patient.");
  return patient;
}

router.get("/appointments", async (req, res) => {
  const statusList = z
    .string()
    .transform(value => value.split(",").map(item => item.trim()).filter(Boolean))
    .pipe(z.array(z.enum([...APPOINTMENT_STATUSES, "active"])));
  const q = validate(
    z.object({
      from: dateOnly.optional(),
      to: dateOnly.optional(),
      providerId: z.coerce.number().int().positive().optional(),
      patientId: z.coerce.number().int().positive().optional(),
      status: statusList.optional(),
    }),
    req.query
  );
  const db = getDb();
  const query = appointmentsQuery(db, req.user.tenant_id).orderBy("a.start_at").orderBy("a.id");
  if (!seesSchedule(req)) query.where("a.provider_id", req.user.id);
  else if (q.providerId) query.where("a.provider_id", q.providerId);
  if (q.patientId) query.where("a.patient_id", q.patientId);
  const from = q.from ?? (q.patientId ? null : clinicNow(req).date);
  const to = q.to ?? (q.patientId ? null : from);
  if (from && to && to < from) throw invalid("to", "The end date must be on or after the start date.");
  if (from) query.where("a.start_at", ">=", `${from}T00:00`);
  if (to) query.where("a.start_at", "<=", `${to}T99`);
  if (q.status?.length) {
    const statuses = q.status.flatMap(item => (item === "active" ? ["scheduled", "confirmed", "checked_in", "in_progress"] : [item]));
    query.whereIn("a.status", statuses);
  }
  res.json((await query.limit(2000)).map(toAppointment));
});

router.get("/appointments/:id", async (req, res) => {
  res.json(withTriage(req, await findAppointment(getDb(), req, parseId(req.params.id))));
});

router.post("/appointments", requirePermission("clinic.appointments.manage"), async (req, res) => {
  const input = validate(bookingSchema, req.body);
  assertType(req, input.type);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const patient = await bookablePatient(db, tenantId, input.patientId);
  const provider = await findProvider(db, tenantId, input.providerId);
  const duration = input.durationMinutes ?? Number(provider.slot_minutes);
  if (minutesOf(input.start.slice(11)) + duration > 24 * 60) throw invalid("durationMinutes", "The appointment must end on the same day.");
  const end = addMinutes(input.start, duration);
  await assertBookable(db, req, { patient, provider, start: input.start, end, force: input.force });
  const now = nowIso();
  const id = await db.transaction(async trx => {
    const appointmentId = await insertAndGetId(trx, "appointments", {
      tenant_id: tenantId,
      patient_id: patient.id,
      provider_id: provider.user_id,
      start_at: input.start,
      end_at: end,
      type: input.type,
      status: "scheduled",
      reason: blank(input.reason) ?? null,
      notes: blank(input.notes) ?? null,
      created_by: req.user.id,
      created_at: now,
      updated_at: now,
    });
    await notifyUsers(trx, [provider.user_id], { title: `New appointment: ${fullName(patient)}`, body: `${at(input.start)} (${input.type.replace("_", " ")})${input.reason ? ` — ${input.reason}` : ""}`, actorId: req.user.id });
    return appointmentId;
  });
  res.status(201).json(toAppointment(await findAppointment(db, req, id)));
});

/** Announces queue changes for each (provider, day) touched by a reschedule, when that day is today. */
async function announceMoves(db, tenantId, rows, today) {
  const seen = new Set();
  for (const row of rows) {
    const date = row.start_at.slice(0, 10);
    const key = `${row.provider_id}:${date}`;
    if (date !== today || seen.has(key)) continue;
    seen.add(key);
    await announceQueue(db, { tenantId, providerId: row.provider_id, date });
  }
}

router.patch("/appointments/:id", requirePermission("clinic.appointments.manage"), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findAppointment(db, req, parseId(req.params.id));
  if (CLOSED_STATUSES.includes(current.status)) throw new HttpError(422, `This appointment is ${current.status.replace("_", " ")} and can't be changed.`, { code: "APPOINTMENT_CLOSED" });
  const body = req.body ?? {};
  const input = validate(bookingSchema.omit({ patientId: true }).partial().extend({ force: z.boolean().default(false) }), body);
  if ("type" in body) assertType(req, input.type);

  const changes = sentOnly(input, body, { type: "type", reason: "reason", notes: "notes" });
  const moving = ["start", "durationMinutes", "providerId"].some(key => key in body && input[key] !== undefined);
  let provider = null;
  if (moving) {
    if (!["scheduled", "confirmed"].includes(current.status)) throw new HttpError(422, "Only scheduled or confirmed appointments can be rescheduled.", { code: "APPOINTMENT_IN_PROGRESS" });
    provider = await findProvider(db, tenantId, input.providerId ?? current.provider_id);
    const start = input.start ?? current.start_at;
    const duration = input.durationMinutes ?? minutesOf(current.end_at.slice(11)) - minutesOf(current.start_at.slice(11));
    if (minutesOf(start.slice(11)) + duration > 24 * 60) throw invalid("durationMinutes", "The appointment must end on the same day.");
    const end = addMinutes(start, duration);
    const patient = await db("patients").where({ id: current.patient_id }).first();
    await assertBookable(db, req, { patient, provider, start, end, excludeId: current.id, force: input.force });
    Object.assign(changes, { start_at: start, end_at: end, provider_id: provider.user_id });
  }
  if (Object.keys(changes).length) {
    await db.transaction(async trx => {
      await trx("appointments").where({ id: current.id }).update({ ...changes, updated_at: nowIso() });
      const patientName = fullName({ first_name: current.patient_first_name, last_name: current.patient_last_name });
      if (moving && (changes.start_at !== current.start_at || changes.provider_id !== current.provider_id)) {
        if (changes.provider_id !== current.provider_id) {
          await notifyUsers(trx, [current.provider_id], { title: `Appointment moved: ${patientName}`, body: `${at(current.start_at)} was reassigned to ${provider.user_name}`, actorId: req.user.id });
          await notifyUsers(trx, [changes.provider_id], { title: `New appointment: ${patientName}`, body: at(changes.start_at), actorId: req.user.id });
        } else {
          await notifyUsers(trx, [current.provider_id], { title: `Appointment rescheduled: ${patientName}`, body: `${at(current.start_at)} → ${at(changes.start_at)}`, actorId: req.user.id });
        }
      }
    });
    if (moving) await announceMoves(db, tenantId, [current, { provider_id: changes.provider_id, start_at: changes.start_at }], clinicNow(req).date);
  }
  res.json(toAppointment(await findAppointment(db, req, current.id)));
});

router.post("/appointments/:id/status", async (req, res) => {
  const input = validate(z.object({ status: z.enum(APPOINTMENT_STATUSES), cancelReason: z.string().trim().max(300).nullable().optional() }), req.body);
  const db = getDb();
  const current = await findAppointment(db, req, parseId(req.params.id));
  if (!TRANSITIONS[current.status].includes(input.status)) {
    const allowed = TRANSITIONS[current.status];
    throw new HttpError(422, allowed.length ? `A ${current.status.replace("_", " ")} appointment can only move to: ${allowed.join(", ").replaceAll("_", " ")}.` : `This appointment is already ${current.status.replace("_", " ")}.`, { code: "INVALID_TRANSITION" });
  }
  const clinical = ["in_progress", "completed"].includes(input.status);
  if (clinical) {
    const ownProvider = current.provider_id === req.user.id && isPractitioner(req);
    if (!ownProvider && !can(req, "clinic.records.view")) throw forbidden("Only the appointment's practitioner can start or complete it.");
  } else if (!can(req, "clinic.appointments.manage")) {
    throw forbidden("You don't have permission to manage appointments.");
  }
  if (input.status === "cancelled" && !input.cancelReason) throw invalid("cancelReason", "Give a reason for cancelling.");

  const now = nowIso();
  const changes = { status: input.status, updated_at: now };
  if (input.status === "checked_in") changes.checked_in_at = now;
  if (input.status === "in_progress" && !current.called_at) changes.called_at = now; // starting the consultation calls the token
  if (input.status === "completed") changes.completed_at = now;
  if (input.status === "cancelled") changes.cancel_reason = input.cancelReason;
  const patientName = fullName({ first_name: current.patient_first_name, last_name: current.patient_last_name });
  const date = current.start_at.slice(0, 10);
  // Checking in hands out the next token for the practitioner's day (retried once if another check-in raced us).
  await withTokenRetry(db, async trx => {
    const token = input.status === "checked_in" && current.token_number == null ? await nextToken(trx, current.provider_id, date) : null;
    await trx("appointments").where({ id: current.id }).update({ ...changes, ...token });
    if (input.status === "checked_in") {
      const number = token?.token_number ?? current.token_number;
      await notifyUsers(trx, [current.provider_id], { title: `${patientName} is waiting`, body: `Token ${number}, checked in for the ${current.start_at.slice(11)} appointment${current.provider_room ? ` (${current.provider_room})` : ""}`, actorId: req.user.id });
    }
    if (input.status === "cancelled") {
      await notifyUsers(trx, [current.provider_id], { title: `Appointment cancelled: ${patientName}`, body: `${at(current.start_at)} — ${input.cancelReason}`, actorId: req.user.id });
    }
  });
  if (input.status === "cancelled" || input.status === "no_show") {
    await recordTenantAudit(db, req, `appointment.${input.status === "cancelled" ? "cancel" : "no_show"}`, patientName, { appointmentId: current.id, start: current.start_at, reason: input.cancelReason ?? null });
  }
  const updated = await findAppointment(db, req, current.id);
  await announceQueue(db, { tenantId: req.user.tenant_id, providerId: current.provider_id, date, codes: [updated.public_code] });
  res.json(toAppointment(updated));
});

// ---- Visits & prescriptions ----
const vital = (label, min, max) =>
  z
    .number({ error: `${label} must be a number.` })
    .min(min, `${label} must be between ${min} and ${max}.`)
    .max(max, `${label} must be between ${min} and ${max}.`)
    .nullable()
    .optional();

const vitalsSchema = z
  .object({
    bpSystolic: vital("Systolic blood pressure", 50, 260),
    bpDiastolic: vital("Diastolic blood pressure", 30, 160),
    pulse: vital("Pulse", 20, 250),
    temperatureC: vital("Temperature (°C)", 30, 45),
    weightKg: vital("Weight (kg)", 0.3, 400),
    heightCm: vital("Height (cm)", 20, 260),
    spo2: vital("SpO2", 50, 100),
    respiratoryRate: vital("Respiratory rate", 4, 80),
  })
  .strict()
  .refine(v => v.bpSystolic == null || v.bpDiastolic == null || v.bpDiastolic < v.bpSystolic, "Diastolic pressure must be lower than systolic.")
  .refine(v => (v.bpSystolic == null) === (v.bpDiastolic == null), "Enter both systolic and diastolic blood pressure.");

const prescriptionSchema = z.object({
  medicine: z.string().trim().min(1, "Name the medicine.").max(160),
  dosage: optionalText(60),
  frequency: optionalText(60),
  duration: optionalText(60),
  route: optionalText(30),
  instructions: optionalText(300),
});

const visitSchema = z.object({
  chiefComplaint: optionalText(500),
  vitals: vitalsSchema.nullable().optional(),
  examination: optionalText(10000),
  diagnosis: optionalText(500),
  plan: optionalText(10000),
  followUpOn: dateOnly.nullable().optional(),
  prescriptions: z.array(prescriptionSchema).max(MAX_PRESCRIPTIONS, `At most ${MAX_PRESCRIPTIONS} medicines per prescription.`).default([]),
});

const parseVitals = json => {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const toVisit = (row, prescriptions) => {
  const vitals = parseVitals(row.vitals);
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    patient: { id: row.patient_id, mrn: row.patient_mrn, name: fullName({ first_name: row.patient_first_name, last_name: row.patient_last_name }) },
    provider: row.provider_id ? { userId: row.provider_id, name: row.provider_name } : null,
    visitDate: row.visit_date,
    chiefComplaint: row.chief_complaint,
    vitals,
    bmi: bmiOf(vitals),
    examination: row.examination,
    diagnosis: row.diagnosis,
    plan: row.plan,
    followUpOn: row.follow_up_on,
    prescriptions: prescriptions.map(item => ({
      id: item.id,
      position: item.position,
      medicine: item.medicine,
      dosage: item.dosage,
      frequency: item.frequency,
      duration: item.duration,
      route: item.route,
      instructions: item.instructions,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const visitsQuery = (db, tenantId) =>
  db("clinic_visits as v")
    .join("patients as pt", "pt.id", "v.patient_id")
    .leftJoin("users as u", "u.id", "v.provider_id")
    .where("v.tenant_id", tenantId)
    .select("v.*", "pt.mrn as patient_mrn", "pt.first_name as patient_first_name", "pt.last_name as patient_last_name", "u.name as provider_name");

async function withPrescriptions(db, visits) {
  if (!visits.length) return [];
  const items = await db("prescriptions").whereIn("visit_id", visits.map(visit => visit.id)).orderBy("position").orderBy("id");
  return visits.map(visit => toVisit(visit, items.filter(item => item.visit_id === visit.id)));
}

const loadVisit = async (db, tenantId, id) => (await withPrescriptions(db, [await visitsQuery(db, tenantId).where("v.id", id).first()]))[0];

/** Visit columns from the form; the form is saved whole (prescriptions are replaced). */
function visitValues(input, visitDate) {
  if (input.followUpOn && input.followUpOn < visitDate) throw invalid("followUpOn", "The follow-up can't be before the visit.");
  const vitals = input.vitals ? Object.fromEntries(Object.entries(input.vitals).filter(([, value]) => value != null)) : null;
  return {
    chief_complaint: blank(input.chiefComplaint) ?? null,
    vitals: vitals && Object.keys(vitals).length ? JSON.stringify(vitals) : null,
    examination: blank(input.examination) ?? null,
    diagnosis: blank(input.diagnosis) ?? null,
    plan: blank(input.plan) ?? null,
    follow_up_on: input.followUpOn ?? null,
  };
}

async function savePrescriptions(trx, visitId, prescriptions) {
  await trx("prescriptions").where({ visit_id: visitId }).delete();
  if (!prescriptions.length) return;
  await trx("prescriptions").insert(
    prescriptions.map((item, position) => ({
      visit_id: visitId,
      position,
      medicine: item.medicine,
      dosage: blank(item.dosage) ?? null,
      frequency: blank(item.frequency) ?? null,
      duration: blank(item.duration) ?? null,
      route: blank(item.route) ?? null,
      instructions: blank(item.instructions) ?? null,
    }))
  );
}

// ---- Triage: vitals a nurse records before the doctor ----
// Kept on the appointment, apart from the doctor's visit notes: the doctor's visit form starts from them and saves
// them into the visit (where they can be corrected). Recording triage never starts the consultation.
const triageSchema = z.object({
  vitals: vitalsSchema.nullable().optional(),
  chiefComplaint: optionalText(500),
});

router.put("/appointments/:id/triage", requirePermission("clinic.vitals.record", "clinic.practitioner"), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findAppointment(db, req, parseId(req.params.id));
  if (!can(req, "clinic.vitals.record") && current.provider_id !== req.user.id) throw forbidden("Only nurses and the patient's own practitioner can record vitals.");
  if (!["checked_in", "in_progress"].includes(current.status)) {
    throw new HttpError(422, current.status === "completed" ? "This visit is complete: vitals now belong in the visit notes." : "Check the patient in before recording vitals.", { code: "NOT_CHECKED_IN" });
  }
  const input = validate(triageSchema, req.body);
  const vitals = input.vitals ? Object.fromEntries(Object.entries(input.vitals).filter(([, value]) => value != null)) : {};
  const complaint = blank(input.chiefComplaint) ?? null;
  if (!Object.keys(vitals).length && !complaint) throw invalid("vitals", "Enter at least one vital sign or the chief complaint.");
  await db("appointments")
    .where({ id: current.id })
    .update({ triage_vitals: Object.keys(vitals).length ? JSON.stringify(vitals) : null, triage_complaint: complaint, triage_by: req.user.id, triage_at: nowIso(), updated_at: nowIso() });
  const patientName = fullName({ first_name: current.patient_first_name, last_name: current.patient_last_name });
  await recordTenantAudit(db, req, "appointment.triage", `${patientName} (${current.patient_mrn})`, { appointmentId: current.id, patientId: current.patient_id, vitals: Object.keys(vitals) });
  await announceQueue(db, { tenantId, providerId: current.provider_id, date: current.token_date ?? current.start_at.slice(0, 10) });
  res.json(withTriage(req, await findAppointment(db, req, current.id)));
});

const auditVisit = (db, req, action, visit) =>
  recordTenantAudit(db, req, action, `${visit.patient.name} (${visit.patient.mrn})`, { visitId: visit.id, appointmentId: visit.appointmentId, patientId: visit.patient.id, prescriptions: visit.prescriptions.length });

router.post("/appointments/:id/visit", requirePermission("clinic.practitioner"), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const appointment = await findAppointment(db, req, parseId(req.params.id));
  if (appointment.provider_id !== req.user.id) throw forbidden("Only the appointment's practitioner can write the visit notes.");
  if (["scheduled", "confirmed"].includes(appointment.status)) throw new HttpError(422, "Check the patient in before writing the visit.", { code: "NOT_CHECKED_IN" });
  if (["cancelled", "no_show"].includes(appointment.status)) throw new HttpError(422, `This appointment was ${appointment.status === "no_show" ? "a no-show" : "cancelled"}.`, { code: "APPOINTMENT_CLOSED" });
  const input = validate(visitSchema, req.body);
  const visitDate = appointment.start_at.slice(0, 10);
  const values = visitValues(input, visitDate);
  const existing = await db("clinic_visits").where({ appointment_id: appointment.id, tenant_id: tenantId }).first();
  const now = nowIso();
  const id = await db.transaction(async trx => {
    let visitId = existing?.id;
    if (existing) await trx("clinic_visits").where({ id: visitId }).update({ ...values, updated_at: now });
    else visitId = await insertAndGetId(trx, "clinic_visits", { tenant_id: tenantId, appointment_id: appointment.id, patient_id: appointment.patient_id, provider_id: req.user.id, visit_date: visitDate, ...values, created_at: now, updated_at: now });
    await savePrescriptions(trx, visitId, input.prescriptions);
    // Writing the notes starts the consultation.
    if (appointment.status === "checked_in") await trx("appointments").where({ id: appointment.id }).update({ status: "in_progress", called_at: appointment.called_at ?? now, updated_at: now });
    return visitId;
  });
  const visit = await loadVisit(db, tenantId, id);
  await auditVisit(db, req, existing ? "visit.update" : "visit.create", visit);
  if (appointment.status === "checked_in") await announceQueue(db, { tenantId, providerId: appointment.provider_id, date: visitDate });
  res.status(existing ? 200 : 201).json(visit);
});

router.post("/patients/:id/visits", requirePermission("clinic.practitioner"), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const patient = await db("patients").where({ id: parseId(req.params.id), tenant_id: tenantId }).first();
  if (!patient || (!seesAllPatients(req) && !(await hasRelationship(db, req, patient.id)))) throw new HttpError(404, "Patient not found.");
  const today = clinicNow(req).date;
  const input = validate(visitSchema.extend({ visitDate: dateOnly.optional() }), req.body);
  const visitDate = input.visitDate ?? today;
  if (visitDate > today) throw invalid("visitDate", "A visit can't be in the future.");
  const values = visitValues(input, visitDate);
  const now = nowIso();
  const id = await db.transaction(async trx => {
    const visitId = await insertAndGetId(trx, "clinic_visits", { tenant_id: tenantId, appointment_id: null, patient_id: patient.id, provider_id: req.user.id, visit_date: visitDate, ...values, created_at: now, updated_at: now });
    await savePrescriptions(trx, visitId, input.prescriptions);
    return visitId;
  });
  const visit = await loadVisit(db, tenantId, id);
  await auditVisit(db, req, "visit.create", visit);
  res.status(201).json(visit);
});

async function findVisibleVisit(db, req, id) {
  const row = await db("clinic_visits").where({ id, tenant_id: req.user.tenant_id }).first();
  if (!row || !(await canSeeRecord(db, req, row.patient_id))) throw new HttpError(404, "Visit not found.");
  return row;
}

router.get("/visits/:id", async (req, res) => {
  const db = getDb();
  const row = await findVisibleVisit(db, req, parseId(req.params.id));
  const visit = await loadVisit(db, req.user.tenant_id, row.id);
  await recordTenantAudit(db, req, "visit.view", `${visit.patient.name} (${visit.patient.mrn})`, { visitId: visit.id, patientId: visit.patient.id });
  res.json(visit);
});

router.patch("/visits/:id", requirePermission("clinic.practitioner"), async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const row = await findVisibleVisit(db, req, parseId(req.params.id));
  if (row.provider_id !== req.user.id) throw forbidden("Only the practitioner who wrote a visit can change it.");
  const input = validate(visitSchema, req.body);
  const values = visitValues(input, row.visit_date);
  await db.transaction(async trx => {
    await trx("clinic_visits").where({ id: row.id }).update({ ...values, updated_at: nowIso() });
    await savePrescriptions(trx, row.id, input.prescriptions);
  });
  const visit = await loadVisit(db, tenantId, row.id);
  await auditVisit(db, req, "visit.update", visit);
  res.json(visit);
});

router.get("/patients/:id/prescriptions/:visitId/print", async (req, res) => {
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const patientId = parseId(req.params.id);
  const row = await findVisibleVisit(db, req, parseId(req.params.visitId));
  if (row.patient_id !== patientId) throw new HttpError(404, "Visit not found.");
  const [visit, patient, provider] = await Promise.all([
    loadVisit(db, tenantId, row.id),
    db("patients").where({ id: patientId }).first(),
    row.provider_id ? db("users as u").leftJoin("clinic_providers as p", "p.user_id", "u.id").where("u.id", row.provider_id).select("u.name", "p.qualification", "p.registration_no", "p.specialty").first() : null,
  ]);
  const { company, branding } = req.tenant.settings;
  await recordTenantAudit(db, req, "prescription.print", `${fullName(patient)} (${patient.mrn})`, { visitId: visit.id });
  res.json({
    clinic: {
      name: company.legalName || branding.siteTitle || req.tenant.name,
      address: company.address || null,
      phone: company.phone || null,
      email: company.email || null,
      website: company.website || null,
      taxId: company.taxId || null,
    },
    provider: provider ? { name: provider.name, qualification: provider.qualification ?? null, registrationNo: provider.registration_no ?? null, specialty: provider.specialty ?? null } : null,
    patient: { id: patient.id, name: fullName(patient), age: ageOn(patient.date_of_birth, visit.visitDate), gender: patient.gender, mrn: patient.mrn, allergies: patient.allergies },
    visitId: visit.id,
    date: visit.visitDate,
    chiefComplaint: visit.chiefComplaint,
    vitals: visit.vitals,
    bmi: visit.bmi,
    diagnosis: visit.diagnosis,
    prescriptions: visit.prescriptions,
    followUpOn: visit.followUpOn,
    generatedAt: nowIso(),
  });
});

// ---- Token queues ----
// Check-in (or a walk-in) gives the patient the next token for that practitioner's day. The practitioner (or the
// front desk) calls tokens in order; the display board and the patient's phone follow along live.
const waitedMinutes = row => (row.checked_in_at ? Math.max(0, Math.round((Date.now() - new Date(row.checked_in_at).getTime()) / 60_000)) : null);

/** The practitioner themself or the front desk may run a queue. */
function assertQueueControl(req, providerId) {
  if (can(req, "clinic.appointments.manage")) return;
  if (isPractitioner(req) && req.user.id === providerId) return;
  throw forbidden("Only the practitioner or the front desk can call tokens in this queue.");
}

const walkInSchema = z.object({
  patientId: z.number({ error: "Choose a patient." }).int().positive("Choose a patient."),
  providerId: z.number({ error: "Choose a practitioner." }).int().positive("Choose a practitioner."),
  type: z.string().trim().min(1).max(20).optional(),
  reason: optionalText(300),
});

router.post("/walk-ins", requirePermission("clinic.appointments.manage"), async (req, res) => {
  const input = validate(walkInSchema, req.body);
  const types = settingsOf(req).appointmentTypes;
  const type = input.type ?? (types.includes("consultation") ? "consultation" : types[0]);
  assertType(req, type);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const patient = await bookablePatient(db, tenantId, input.patientId);
  if (!patient.is_active) throw invalid("patientId", "This patient record is deactivated. Reactivate it first.");
  const provider = await findProvider(db, tenantId, input.providerId);
  const already = await db("appointments").where({ tenant_id: tenantId, patient_id: patient.id, provider_id: provider.user_id, token_date: clinicNow(req).date }).whereIn("status", IN_QUEUE).first("id", "token_number");
  if (already) {
    throw new HttpError(409, `${fullName(patient)} is already in ${provider.user_name}'s queue today with token ${already.token_number}.`, { code: "ALREADY_IN_QUEUE", appointmentId: already.id });
  }
  // A walk-in joins the queue now: no schedule or overlap checks. Starts at the clinic's "now", rounded down to 5 minutes.
  const now = clinicNow(req);
  const startMin = Math.floor(minutesOf(now.time) / 5) * 5;
  const endMin = Math.min(startMin + Number(provider.slot_minutes), 24 * 60 - 1);
  const start = `${now.date}T${timeOf(startMin)}`;
  const end = `${now.date}T${timeOf(endMin)}`;
  const stamp = nowIso();
  const id = await withTokenRetry(db, async trx => {
    const token = await nextToken(trx, provider.user_id, now.date);
    const appointmentId = await insertAndGetId(trx, "appointments", {
      tenant_id: tenantId,
      patient_id: patient.id,
      provider_id: provider.user_id,
      start_at: start,
      end_at: end,
      type,
      status: "checked_in",
      checked_in_at: stamp,
      reason: blank(input.reason) ?? null,
      notes: null,
      call_count: 0,
      ...token,
      created_by: req.user.id,
      created_at: stamp,
      updated_at: stamp,
    });
    await notifyUsers(trx, [provider.user_id], { title: `${fullName(patient)} is waiting`, body: `Walk-in, token ${token.token_number}${input.reason ? ` — ${input.reason}` : ""}`, actorId: req.user.id });
    return appointmentId;
  });
  const row = await findAppointment(db, req, id);
  await recordTenantAudit(db, req, "appointment.walk_in", fullName(patient), { appointmentId: id, providerId: provider.user_id, token: row.token_number });
  await announceQueue(db, { tenantId, providerId: provider.user_id, date: now.date });
  res.status(201).json(toAppointment(row));
});

router.get("/queue", async (req, res) => {
  const q = validate(z.object({ date: dateOnly.optional(), providerId: z.coerce.number().int().positive().optional() }), req.query);
  const date = q.date ?? clinicNow(req).date;
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const providersList = providersQuery(db, tenantId).where("u.is_active", true).orderByRaw("lower(u.name)");
  // Practitioners without the wider clinic access only see their own queue.
  if (!seesAllPatients(req)) providersList.where("p.user_id", isPractitioner(req) ? req.user.id : -1);
  if (q.providerId) providersList.where("p.user_id", q.providerId);
  const providers = await providersList;
  const ids = providers.map(provider => provider.user_id);
  const rows = ids.length
    ? await appointmentsQuery(db, tenantId)
        .whereIn("a.provider_id", ids)
        .where(inner => inner.where("a.token_date", date).orWhere(day => day.whereNull("a.token_date").where("a.start_at", ">=", `${date}T00:00`).where("a.start_at", "<=", `${date}T99`)))
    : [];
  res.json({
    date,
    providers: providers.map(provider => {
      const figures = queueFigures(rows.filter(row => row.provider_id === provider.user_id));
      return {
        provider: { userId: provider.user_id, name: provider.user_name, room: provider.room ?? null, specialty: provider.specialty ?? null, color: provider.color ?? "teal" },
        nowServing: figures.nowServing ? { ...withTriage(req, figures.nowServing), waitingMinutes: waitedMinutes(figures.nowServing) } : null,
        waiting: figures.waiting.map((row, index) => ({ ...withTriage(req, row), queuePosition: index + 1, waitingMinutes: waitedMinutes(row) })),
        done: figures.done,
        noShow: figures.noShow,
        averageConsultMinutes: figures.averageConsultMinutes,
        nextToken: figures.nextToken,
      };
    }),
  });
});

// Token status for everyone with clinic access (the "Token status" tab): per practitioner, the token being served and
// the next few. Token numbers only: no names, so people who can't see the appointment book may read it too.
router.get("/queue/status", async (req, res) => {
  const q = validate(z.object({ date: dateOnly.optional() }), req.query);
  const date = q.date ?? clinicNow(req).date;
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const providers = await providersQuery(db, tenantId).where("u.is_active", true).orderByRaw("lower(u.name)");
  const ids = providers.map(provider => provider.user_id);
  const rows = ids.length
    ? await db("appointments").where({ tenant_id: tenantId, token_date: date }).whereIn("provider_id", ids).whereNotNull("token_number").select("id", "provider_id", "status", "token_number", "called_at", "completed_at", "updated_at")
    : [];
  res.json({
    date,
    providers: providers.map(provider => {
      const figures = queueFigures(rows.filter(row => row.provider_id === provider.user_id));
      const serving = figures.nowServing;
      return {
        provider: { userId: provider.user_id, name: provider.user_name, room: provider.room ?? null, specialty: provider.specialty ?? null, color: provider.color ?? "teal" },
        nowServing: serving ? { token: serving.token_number, status: serving.status === "in_progress" ? "in_progress" : "called", calledAt: serving.called_at ?? null } : null,
        // Called earlier but not seen yet go after the ones still to be called.
        next: [...figures.waiting.filter(row => !row.called_at), ...figures.waiting.filter(row => row.called_at)].slice(0, 5).map(row => row.token_number),
        waiting: figures.waiting.length,
        done: figures.done,
        averageConsultMinutes: figures.averageConsultMinutes,
      };
    }),
  });
});

/**
 * After a token is called: the display boards flash it (clinic.token.called), the front desk gets a notification,
 * and everyone following the queue refreshes. `codes`: public codes of tokens that just left the queue.
 */
async function announceCall(db, req, row, codes = []) {
  const tenantId = req.user.tenant_id;
  publish({ tenantId, permission: CLINIC_PERMISSIONS }, "clinic.token.called", { providerId: row.provider_id, providerName: row.provider_name, room: row.provider_room ?? null, token: row.token_number, appointmentId: row.id });
  try {
    const desk = await usersWithPermission(db, tenantId, "clinic.appointments.manage");
    await notifyUsers(db, desk, { title: `Token ${row.token_number} called`, body: `${row.provider_name}${row.provider_room ? ` · ${row.provider_room}` : ""}`, actorId: req.user.id });
  } catch (error) {
    console.warn("[clinic] token call notification failed:", error.message);
  }
  await announceQueue(db, { tenantId, providerId: row.provider_id, date: row.token_date, codes });
}

/** Calls a waiting token: stamps it, tells the display boards, and refreshes everyone following the queue. */
async function callToken(db, req, row) {
  const now = nowIso();
  await db("appointments").where({ id: row.id }).update({ called_at: now, call_count: db.raw("coalesce(call_count, 0) + 1"), updated_at: now });
  const updated = await findAppointment(db, req, row.id);
  await announceCall(db, req, updated);
  return toAppointment(updated);
}

/** A checked-in appointment that holds a token (422 otherwise). */
async function findWaiting(db, req, id) {
  const row = await findAppointment(db, req, id);
  assertQueueControl(req, row.provider_id);
  if (row.status !== "checked_in" || row.token_number == null) {
    throw new HttpError(422, row.status === "in_progress" ? "This patient is already with the practitioner." : "Only checked-in patients with a token can be called or skipped.", { code: "NOT_WAITING" });
  }
  return row;
}

router.post("/queue/:providerId/call-next", async (req, res) => {
  const providerId = parseId(req.params.providerId);
  assertQueueControl(req, providerId);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await findProvider(db, tenantId, providerId, null);
  const { date: sent } = validate(z.object({ date: dateOnly.optional() }), req.body ?? {});
  const date = sent ?? clinicNow(req).date;
  const rows = await appointmentsQuery(db, tenantId).where({ "a.provider_id": providerId, "a.token_date": date }).whereIn("a.status", IN_QUEUE);
  const { nowServing, waiting } = queueFigures(rows);
  // The lowest token nobody has called yet; when everyone has been called once, the next one after the current token.
  let next = waiting.find(row => !row.called_at);
  if (!next) next = waiting.find(row => row.token_number > (nowServing?.token_number ?? 0)) ?? waiting[0];
  if (!next) throw new HttpError(409, "Nobody is waiting in this queue.", { code: "QUEUE_EMPTY" });
  res.json(await callToken(db, req, next));
});

/** Times a patient may miss their call before the next "Complete & call next" marks them a no-show. */
const MISSED_CALLS_BEFORE_NO_SHOW = 2;

/**
 * "Complete & call next", the doctor's one button, in one transaction:
 * 1. The current patient is completed: the consultation in progress, or the token on screen that was called but never
 *    started (seen without pressing Start). With { missed: true } that token is treated as missed instead (step 2).
 *    Completing keeps any visit notes; it needs the practitioner (or clinic.records.view).
 * 2. Every other token that was called but never started missed its call: the first time it goes to the back of the
 *    line (a new token, waiting again, so its /q page stops saying "your turn"); once it has been called
 *    MISSED_CALLS_BEFORE_NO_SHOW times it becomes a no-show.
 * 3. The lowest token not yet called is called (patients sent to the back come after everyone else).
 * 409 QUEUE_EMPTY when there was nothing to complete and nobody to call.
 */
router.post("/queue/:providerId/next", async (req, res) => {
  const providerId = parseId(req.params.providerId);
  assertQueueControl(req, providerId);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await findProvider(db, tenantId, providerId, null);
  const input = validate(z.object({ date: dateOnly.optional(), missed: z.boolean().default(false) }), req.body ?? {});
  const date = input.date ?? clinicNow(req).date;
  const mayComplete = can(req, "clinic.records.view") || (isPractitioner(req) && req.user.id === providerId);
  const now = nowIso();

  let outcome;
  await withTokenRetry(db, async trx => {
    outcome = { completed: [], requeued: [], noShow: [], calledId: null };
    const rows = await trx("appointments")
      .where({ tenant_id: tenantId, provider_id: providerId, token_date: date })
      .whereIn("status", IN_QUEUE)
      .whereNotNull("token_number")
      .select("id", "status", "token_number", "called_at", "call_count", "completed_at", "updated_at");
    const { nowServing } = queueFigures(rows);
    const finishing = rows.filter(row => row.status === "in_progress");
    if (nowServing?.status === "checked_in" && !input.missed) finishing.push(nowServing);
    if (finishing.length && !mayComplete) throw forbidden("Only the practitioner can complete the consultation. Ask the doctor, or mark the patient as not here.");
    for (const row of finishing) {
      await trx("appointments").where({ id: row.id }).update({ status: "completed", completed_at: now, updated_at: now });
      outcome.completed.push(row.id);
    }
    const missed = rows.filter(row => row.status === "checked_in" && row.called_at && !finishing.includes(row)).sort((a, b) => a.token_number - b.token_number);
    for (const row of missed) {
      if (Number(row.call_count ?? 0) >= MISSED_CALLS_BEFORE_NO_SHOW) {
        await trx("appointments").where({ id: row.id }).update({ status: "no_show", updated_at: now });
        outcome.noShow.push(row.id);
      } else {
        const { token_number } = await nextToken(trx, providerId, date); // keeps the public code: the patient's link still works
        await trx("appointments").where({ id: row.id }).update({ token_number, called_at: null, updated_at: now });
        outcome.requeued.push(row.id);
      }
    }
    const next = await trx("appointments").where({ tenant_id: tenantId, provider_id: providerId, token_date: date, status: "checked_in" }).whereNull("called_at").whereNotNull("token_number").orderBy("token_number").first("id");
    if (next) {
      await trx("appointments").where({ id: next.id }).update({ called_at: now, call_count: trx.raw("coalesce(call_count, 0) + 1"), updated_at: now });
      outcome.calledId = next.id;
    }
  });
  const changed = outcome.completed.length + outcome.requeued.length + outcome.noShow.length;
  if (!changed && !outcome.calledId) throw new HttpError(409, "Nobody is waiting in this queue.", { code: "QUEUE_EMPTY" });

  const load = ids => (ids.length ? appointmentsQuery(db, tenantId).whereIn("a.id", ids).orderBy("a.token_number") : []);
  const [completed, requeued, noShow] = await Promise.all([load(outcome.completed), load(outcome.requeued), load(outcome.noShow)]);
  const called = outcome.calledId ? await findAppointment(db, req, outcome.calledId) : null;
  if (changed) {
    await recordTenantAudit(db, req, "appointment.queue.next", called ? `Token ${called.token_number}` : "Queue", {
      providerId,
      completed: outcome.completed,
      requeued: outcome.requeued,
      noShow: outcome.noShow,
      called: outcome.calledId,
    });
  }
  const leaving = [...completed, ...noShow].map(row => row.public_code);
  if (called) await announceCall(db, req, called, leaving);
  else await announceQueue(db, { tenantId, providerId, date, codes: leaving });
  res.json({
    completed: completed.map(toAppointment),
    requeued: requeued.map(toAppointment),
    noShow: noShow.map(toAppointment),
    called: called ? toAppointment(called) : null,
  });
});

router.post("/appointments/:id/recall", async (req, res) => {
  const db = getDb();
  const row = await findWaiting(db, req, parseId(req.params.id));
  res.json(await callToken(db, req, row));
});

router.post("/appointments/:id/skip", async (req, res) => {
  const db = getDb();
  const row = await findWaiting(db, req, parseId(req.params.id));
  // Moves the patient to the end of the line: a new token after the last one, waiting to be called again.
  let number;
  await withTokenRetry(db, async trx => {
    const token = await nextToken(trx, row.provider_id, row.token_date);
    number = token.token_number;
    await trx("appointments").where({ id: row.id }).update({ token_number: number, called_at: null, updated_at: nowIso() });
  });
  await recordTenantAudit(db, req, "appointment.token.skip", fullName({ first_name: row.patient_first_name, last_name: row.patient_last_name }), { appointmentId: row.id, providerId: row.provider_id, from: row.token_number, to: number });
  await announceQueue(db, { tenantId: req.user.tenant_id, providerId: row.provider_id, date: row.token_date });
  res.json(toAppointment(await findAppointment(db, req, row.id)));
});

// ---- Summary ----
router.get("/summary", async (req, res) => {
  const now = clinicNow(req);
  const q = validate(z.object({ date: dateOnly.optional() }), req.query);
  const date = q.date ?? now.date;
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const wide = seesSchedule(req);

  const dayQuery = appointmentsQuery(db, tenantId).where("a.start_at", ">=", `${date}T00:00`).where("a.start_at", "<=", `${date}T99`).orderBy("a.start_at");
  if (!wide) dayQuery.where("a.provider_id", req.user.id);
  const windowStart = addDays(date, -30);
  const noShowQuery = db("appointments").where("tenant_id", tenantId).where("start_at", ">=", `${windowStart}T00:00`).where("start_at", "<", `${date}T00:00`).whereIn("status", ["completed", "no_show"]);
  if (!wide) noShowQuery.where("provider_id", req.user.id);

  const [today, providers, newPatients, noShowRows] = await Promise.all([
    dayQuery,
    providersQuery(db, tenantId).where("u.is_active", true).orderByRaw("lower(u.name)"),
    seesAllPatients(req) ? db("patients").where("tenant_id", tenantId).where("created_at", ">=", `${date.slice(0, 7)}-01`).count({ count: "*" }).first() : null,
    noShowQuery.select("status").count({ count: "*" }).groupBy("status"),
  ]);

  const byStatus = Object.fromEntries(APPOINTMENT_STATUSES.map(status => [status, 0]));
  for (const row of today) byStatus[row.status]++;
  const perProvider = providers
    .filter(provider => wide || provider.user_id === req.user.id)
    .map(provider => {
      const mine = today.filter(row => row.provider_id === provider.user_id);
      return {
        providerId: provider.user_id,
        name: provider.user_name,
        color: provider.color,
        room: provider.room,
        total: mine.filter(row => row.status !== "cancelled").length,
        remaining: mine.filter(row => ["scheduled", "confirmed", "checked_in", "in_progress"].includes(row.status)).length,
        completed: mine.filter(row => row.status === "completed").length,
      };
    });
  const waitingRoom = today
    .filter(row => row.status === "checked_in")
    .sort((a, b) => String(a.checked_in_at).localeCompare(String(b.checked_in_at)))
    .map(row => ({ ...toAppointment(row), waitingMinutes: Math.max(0, Math.round((Date.now() - new Date(row.checked_in_at).getTime()) / 60_000)) }));

  let nextAppointment = null;
  if (isPractitioner(req)) {
    const next = await appointmentsQuery(db, tenantId)
      .where("a.provider_id", req.user.id)
      .where(inner => inner.where(active => active.whereIn("a.status", ["scheduled", "confirmed"]).where("a.end_at", ">", now.stamp)).orWhereIn("a.status", ["checked_in", "in_progress"]))
      .orderByRaw("case a.status when 'in_progress' then 0 when 'checked_in' then 1 else 2 end")
      .orderBy("a.start_at")
      .first();
    nextAppointment = next ? toAppointment(next) : null;
  }

  const counts = Object.fromEntries(noShowRows.map(row => [row.status, Number(row.count)]));
  const considered = (counts.completed ?? 0) + (counts.no_show ?? 0);
  res.json({
    date,
    total: today.filter(row => row.status !== "cancelled").length,
    byStatus,
    perProvider,
    waitingRoom,
    nextAppointment,
    newPatientsThisMonth: newPatients ? Number(newPatients.count) : null,
    noShowRate: considered ? Math.round(((counts.no_show ?? 0) / considered) * 1000) / 10 : null,
    noShowWindow: { from: windowStart, to: addDays(date, -1), noShows: counts.no_show ?? 0, considered },
  });
});

export default router;
