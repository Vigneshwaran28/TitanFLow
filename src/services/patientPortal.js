// Patient portal credentials and sessions. Patients sign in at /<workspace>/patient/login with their patient number
// (8 digits, random, unique per workspace, printed on their card and token slip) and a 6-digit PIN that is only ever
// stored as a bcrypt hash and shown once to the receptionist who issues it.
// Portal sessions are completely separate from staff sessions: their own cookie (tf_p_<slug>), a JWT signed with a
// key derived from the install's secret and carrying its own audience, so a patient token can never pass as a staff
// session (and a staff token never as a patient one).
import { createHmac, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { readConfig } from "../config/store.js";
import { HttpError } from "../utils/http.js";

export const PORTAL_COOKIE_PREFIX = "tf_p_";
export const PORTAL_AUDIENCE = "taskflow-patient-portal";
export const PORTAL_SESSION_HOURS = 12;
export const PATIENT_NUMBER_PATTERN = /^[1-9]\d{7}$/;
export const PIN_PATTERN = /^\d{6}$/;

/** Wrong PINs before a patient number is locked, and for how long. */
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;

/** The cookie that holds a workspace's patient session. */
export const portalCookie = slug => `${PORTAL_COOKIE_PREFIX}${slug}`;

/** 8 digits, never starting with 0 (so it survives spreadsheets and phone keypads). */
export const newPatientNumber = () => String(randomInt(10_000_000, 100_000_000));

/** 6 random digits; weak sequences (all the same, 123456, 654321) are redrawn. */
export function newPin() {
  for (;;) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!/^(\d)\1{5}$/.test(pin) && !"0123456789".includes(pin) && !"9876543210".includes(pin)) return pin;
  }
}

export const hashPin = pin => bcrypt.hash(pin, 10);
export const pinMatches = (pin, hash) => (hash ? bcrypt.compare(pin, hash) : Promise.resolve(false));

/**
 * Gives a patient portal credentials: keeps their patient number (or draws a new one that's free in the workspace)
 * and sets a fresh PIN. A new PIN ends every portal session signed in with the old one, and clears any lock.
 * Runs inside the caller's transaction; returns the plain PIN for the one-time display.
 * @param {import("knex").Knex | import("knex").Knex.Transaction} db
 * @param {{ id: number, tenant_id: number, portal_number?: string | null }} patient
 * @returns {Promise<{ patientNumber: string, pin: string }>}
 */
export async function issuePortalCredentials(db, patient, now = new Date().toISOString()) {
  let patientNumber = patient.portal_number ?? null;
  for (let attempt = 0; !patientNumber; attempt++) {
    if (attempt > 20) throw new HttpError(500, "Couldn't assign a patient number. Please try again.");
    const candidate = newPatientNumber();
    const taken = await db("patients").where({ tenant_id: patient.tenant_id, portal_number: candidate }).first("id");
    if (!taken) patientNumber = candidate;
  }
  const pin = newPin();
  await db("patients")
    .where({ id: patient.id })
    .update({ portal_number: patientNumber, portal_pin_hash: await hashPin(pin), portal_pin_set_at: now, portal_failed_attempts: 0, portal_locked_until: null, updated_at: now });
  return { patientNumber, pin };
}

/** Signing key for portal sessions: derived from (never equal to) the key staff sessions use. */
function portalSecret() {
  const config = readConfig();
  if (!config) throw new HttpError(503, "Setup is not complete.", { code: "SETUP_REQUIRED" });
  return createHmac("sha256", config.jwtSecret).update("patient-portal-session").digest("hex");
}

export const portalCookieOptions = maxAge => ({ httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge, path: "/" });

/** Signs a patient in to a workspace's portal on this browser. */
export function startPortalSession(res, { patientId, tenantId, slug }) {
  const token = jwt.sign({ sub: String(patientId), tid: tenantId, ws: slug, iatMs: Date.now() }, portalSecret(), { audience: PORTAL_AUDIENCE, expiresIn: `${PORTAL_SESSION_HOURS}h` });
  res.cookie(portalCookie(slug), token, portalCookieOptions(PORTAL_SESSION_HOURS * 3_600_000));
}

export const endPortalSession = (res, slug) => res.clearCookie(portalCookie(slug), { path: "/" });

/** The payload of a valid portal token, or null. */
export function verifyPortalToken(token) {
  try {
    return jwt.verify(token, portalSecret(), { audience: PORTAL_AUDIENCE });
  } catch {
    return null;
  }
}
