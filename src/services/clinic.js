// Clinic helpers: clinic-local times, practitioners' weekly schedules, and free/busy slots.
// Appointment times are clinic-local wall-clock strings ("YYYY-MM-DDTHH:MM"), so they compare as text
// and never shift with time zones. Weekdays follow Date#getUTCDay: 0 = Sunday.
import { randomInt } from "node:crypto";
import { z } from "zod";
import { publish } from "./realtime.js";

const DAY_MS = 86_400_000;
const pad = n => String(n).padStart(2, "0");
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Statuses that hold a slot; cancelled and no-show appointments free it. */
export const SLOT_HOLDING = ["scheduled", "confirmed", "checked_in", "in_progress", "completed"];
/** Holiday types that close the clinic. */
export const CLOSING_HOLIDAYS = ["public", "company"];

export const minutesOf = time => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};
export const timeOf = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
export const toDate = value => new Date(`${value}T00:00:00Z`);
export const toDay = date => date.toISOString().slice(0, 10);
export const addDays = (day, days) => toDay(new Date(toDate(day).getTime() + days * DAY_MS));
export const weekdayOf = day => toDate(day).getUTCDay();
export const realDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toDate(value).getTime()) && toDay(toDate(value)) === value;

const STAMP = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
export const isStamp = value => typeof value === "string" && STAMP.test(value) && realDate(value.slice(0, 10));
/** "YYYY-MM-DDTHH:MM" plus minutes (same day only; callers check the day boundary). */
export const addMinutes = (stamp, minutes) => `${stamp.slice(0, 10)}T${timeOf(minutesOf(stamp.slice(11)) + minutes)}`;

const localStamp = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/**
 * The clinic's "now". Clients may send their wall-clock time (header X-Local-Time, or `now` in the query
 * or body) as "YYYY-MM-DDTHH:MM"; it's trusted only within 15 hours of the server's clock (every real
 * time zone). Otherwise the server's local time is used.
 * @returns {{ stamp: string, date: string, time: string }}
 */
export function clinicNow(req) {
  const sent = req.get?.("x-local-time") ?? req.query?.now ?? req.body?.now;
  let stamp = localStamp();
  if (isStamp(sent)) {
    const asUtc = new Date(`${sent}:00Z`).getTime();
    if (Math.abs(asUtc - Date.now()) <= 15 * 3_600_000) stamp = sent;
  }
  return { stamp, date: stamp.slice(0, 10), time: stamp.slice(11) };
}

// ---- Weekly schedules ----
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use times like 09:00.");

/** { "1": [["09:00","13:00"],["14:00","18:00"]], ... } with sorted, valid, non-overlapping ranges. */
export const scheduleSchema = z
  .record(z.string(), z.array(z.tuple([hhmm, hhmm]), { error: "Each day is a list of [start, end] times." }).max(8, "At most 8 sessions a day."))
  .superRefine((schedule, ctx) => {
    for (const [key, ranges] of Object.entries(schedule)) {
      if (!/^[0-6]$/.test(key)) {
        ctx.addIssue({ code: "custom", message: `Unknown weekday "${key}". Use 0 (Sunday) to 6 (Saturday).` });
        return;
      }
      const day = WEEKDAY_NAMES[Number(key)];
      const sorted = [...ranges].sort((a, b) => minutesOf(a[0]) - minutesOf(b[0]));
      for (const [start, end] of sorted) {
        if (minutesOf(start) >= minutesOf(end)) {
          ctx.addIssue({ code: "custom", message: `${day}: ${start}–${end} must end after it starts.` });
          return;
        }
      }
      for (let i = 1; i < sorted.length; i++) {
        if (minutesOf(sorted[i][0]) < minutesOf(sorted[i - 1][1])) {
          ctx.addIssue({ code: "custom", message: `${day}: ${sorted[i - 1][0]}–${sorted[i - 1][1]} overlaps ${sorted[i][0]}–${sorted[i][1]}.` });
          return;
        }
      }
    }
  })
  .transform(schedule => {
    const clean = {};
    for (const key of Object.keys(schedule).sort()) {
      if (schedule[key].length) clean[key] = [...schedule[key]].sort((a, b) => minutesOf(a[0]) - minutesOf(b[0]));
    }
    return clean;
  });

export function parseSchedule(json) {
  try {
    const value = JSON.parse(json || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The ranges a practitioner works on a date. */
export const rangesOn = (schedule, day) => schedule[String(weekdayOf(day))] ?? [];

/** "09:00–13:00, 14:00–18:00" */
export const describeRanges = ranges => ranges.map(([start, end]) => `${start}–${end}`).join(", ");

/** True when [startMin, endMin) sits inside one working range. */
export const withinRanges = (ranges, startMin, endMin) => ranges.some(([start, end]) => startMin >= minutesOf(start) && endMin <= minutesOf(end));

/**
 * Slots for one day: the schedule cut into slotMinutes pieces, each free unless it overlaps an appointment
 * that holds its time, it has already started, or it's beyond the booking window.
 * @param {{ ranges: string[][], slotMinutes: number, day: string, booked: {start_at: string, end_at: string}[], now: {stamp: string}, lastBookableDay: string }} input
 */
export function slotsFor({ ranges, slotMinutes, day, booked, now, lastBookableDay }) {
  const slots = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    for (let t = minutesOf(rangeStart); t + slotMinutes <= minutesOf(rangeEnd); t += slotMinutes) {
      const start = `${day}T${timeOf(t)}`;
      const end = `${day}T${timeOf(t + slotMinutes)}`;
      const taken = booked.some(row => row.start_at < end && row.end_at > start);
      slots.push({ start: timeOf(t), end: timeOf(t + slotMinutes), available: !taken && start >= now.stamp && day <= lastBookableDay });
    }
  }
  return slots;
}

/** BMI from kg and cm, one decimal. */
export const bmiOf = vitals => {
  if (!vitals?.weightKg || !vitals?.heightCm) return null;
  return Math.round((vitals.weightKg / (vitals.heightCm / 100) ** 2) * 10) / 10;
};

/** Completed years between a date of birth and a day. */
export function ageOn(dateOfBirth, day) {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = day.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/**
 * A date of birth for a patient whose age is known but not their birthday: the same calendar day, `years` ago
 * (29 February becomes 28 February). Stored with patients.dob_estimated so screens show "~N yrs".
 */
export function estimatedDateOfBirth(years, day) {
  const [y, m, d] = day.split("-").map(Number);
  const year = y - years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return `${String(year).padStart(4, "0")}-${pad(m)}-${pad(m === 2 && d === 29 && !leap ? 28 : d)}`;
}

// ---- Token queues ----
// A token is a queue number per practitioner per clinic day, handed out at check-in (or for a walk-in).
// The patient follows it on /q/<public code> without signing in.
export const CLINIC_PERMISSIONS = ["clinic.schedule.view", "clinic.appointments.manage", "clinic.patients.manage", "clinic.practitioner", "clinic.records.view", "clinic.providers.manage", "clinic.vitals.record"];
/** No 0/O, 1/I/L: easy to read off a slip and type on a phone. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PUBLIC_CODE_LENGTH = 10;
export const PUBLIC_CODE_PATTERN = /^[2-9A-HJKMNP-Z]{10}$/;
export const newPublicCode = () => Array.from({ length: PUBLIC_CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export const isUniqueViolation = error => /unique|duplicate/i.test(String(error?.message ?? ""));

/** The next token for a practitioner's day (inside the caller's transaction) plus a fresh public code. */
export async function nextToken(trx, providerId, date) {
  const row = await trx("appointments").where({ provider_id: providerId, token_date: date }).max({ max: "token_number" }).first();
  return { token_date: date, token_number: Number(row?.max ?? 0) + 1, public_code: newPublicCode() };
}

/** Runs a transaction that hands out a token, retrying once when another check-in took the same number. */
export async function withTokenRetry(db, work) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (attempt >= 1 || !isUniqueViolation(error)) throw error;
    }
  }
}

/** Patients still in the queue (waiting or with the doctor). */
export const IN_QUEUE = ["checked_in", "in_progress"];

/**
 * Queue figures for one practitioner's day, from rows with token_number, status, called_at, completed_at, updated_at.
 * nowServing: the consultation in progress, or else the most recently called token still waiting.
 */
export function queueFigures(rows) {
  const tokened = rows.filter(row => row.token_number != null);
  const inProgress = tokened.filter(row => row.status === "in_progress").sort((a, b) => String(b.called_at ?? b.updated_at).localeCompare(String(a.called_at ?? a.updated_at)));
  const called = tokened.filter(row => row.status === "checked_in" && row.called_at).sort((a, b) => String(b.called_at).localeCompare(String(a.called_at)));
  const nowServing = inProgress[0] ?? called[0] ?? null;
  const waiting = tokened.filter(row => row.status === "checked_in" && row !== nowServing).sort((a, b) => a.token_number - b.token_number);
  const durations = rows
    .filter(row => row.status === "completed" && row.called_at && row.completed_at)
    .map(row => (new Date(row.completed_at).getTime() - new Date(row.called_at).getTime()) / 60_000)
    .filter(minutes => minutes >= 0 && minutes < 600);
  const averageConsultMinutes = durations.length ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10 : null;
  const nextTokenNumber = tokened.reduce((max, row) => Math.max(max, row.token_number), 0) + 1;
  return {
    nowServing,
    waiting,
    done: rows.filter(row => row.status === "completed").length,
    noShow: rows.filter(row => row.status === "no_show").length,
    averageConsultMinutes,
    nextToken: nextTokenNumber,
  };
}

/**
 * Tells everyone following a practitioner's queue that it changed: clinic staff (refetch the queue) and every
 * patient token page in that queue. `codes` adds public codes that just left the queue (completed, cancelled).
 * Never throws.
 */
export async function announceQueue(db, { tenantId, providerId, date, codes = [] }) {
  try {
    publish({ tenantId, permission: CLINIC_PERMISSIONS }, "clinic.queue.updated", { providerId, date });
    const rows = await db("appointments").where({ tenant_id: tenantId, provider_id: providerId, token_date: date }).whereIn("status", IN_QUEUE).whereNotNull("public_code").select("public_code");
    const all = new Set([...rows.map(row => row.public_code), ...codes.filter(Boolean)]);
    for (const code of all) publish({ channel: `queue:${code}` }, "queue.updated", {});
  } catch (error) {
    console.warn("[clinic] queue announcement failed:", error.message);
  }
}
