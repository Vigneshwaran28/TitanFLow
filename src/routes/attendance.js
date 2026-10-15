// Attendance: daily check-in / check-out and leave requests, scoped to the tenant and driven by its
// attendance settings (working days, start time, automatic check-in, half days, leave types, allowance).
// Work days are the employee's local calendar day, sent by the client as YYYY-MM-DD with the local time.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can, requirePermission } from "../middleware/auth.js";
import { rolesByUser, usersWithPermission } from "../services/permissions.js";
import { loadCalendar } from "../services/workCalendar.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { notifyUsers } from "../services/notify.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const LEAVE_LABELS = { annual: "Annual leave", sick: "Sick leave", casual: "Casual leave", unpaid: "Unpaid leave", other: "Leave" };
const PORTION_LABELS = { full: "", first_half: " (first half)", second_half: " (second half)" };

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.");
const month = z.string().regex(/^\d{4}-\d{2}$/, "Use a month like 2026-10.");
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:05.");

const DAY_MS = 86_400_000;
const MAX_PAST_LEAVE_DAYS = 60;
const MAX_LEAVE_SPAN_DAYS = 90;
const toDate = value => new Date(`${value}T00:00:00Z`);
const toDay = date => date.toISOString().slice(0, 10);
const settingsOf = req => req.tenant.settings.attendance;

const invalid = (field, message) => new HttpError(422, "Please fix the highlighted fields.", { errors: { [field]: message } });

/** A client's "today" is within a day of the server's UTC date in every real timezone. */
function assertPlausibleToday(date) {
  const diff = Math.abs(toDate(date) - toDate(toDay(new Date())));
  if (diff > DAY_MS) throw invalid("date", "You can only check in or out for today.");
}

/** The calendar for one person (their optional holidays count) or the whole tenant. */
const calendarFor = (db, req, from, to, userId) => loadCalendar(db, req.user.tenant_id, settingsOf(req), { from, to, userId });


/** Days a leave request uses: half days count 0.5. */
const leaveDays = row => (row.portion && row.portion !== "full" ? 0.5 : Number(row.days));

function monthRange(value) {
  const [year, monthIndex] = value.split("-").map(Number);
  return { first: `${value}-01`, last: toDay(new Date(Date.UTC(year, monthIndex, 0))) };
}

const hoursBetween = (start, end) => (end ? Math.max(0, (new Date(end) - new Date(start)) / 3_600_000) : 0);
const round1 = value => Math.round(value * 10) / 10;
const minutesOf = time => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes late against the workday start (0 when on time or unknown). */
function lateMinutes(row, settings) {
  if (!row.check_in_local) return 0;
  const late = minutesOf(row.check_in_local) - minutesOf(settings.workdayStart);
  return late > settings.lateAfterMinutes ? late : 0;
}

const toRecord = (row, settings) => ({
  id: row.id,
  userId: row.user_id,
  date: row.work_date,
  checkInAt: row.check_in_at,
  checkOutAt: row.check_out_at,
  checkInLocal: row.check_in_local ?? null,
  source: row.source ?? "manual",
  lateMinutes: lateMinutes(row, settings),
  hours: round1(hoursBetween(row.check_in_at, row.check_out_at)),
  note: row.note,
});

const toLeave = row => ({
  id: row.id,
  user: { id: row.user_id, name: row.user_name, jobTitle: row.user_job_title ?? null },
  type: row.type,
  portion: row.portion ?? "full",
  startDate: row.start_date,
  endDate: row.end_date,
  days: leaveDays(row),
  reason: row.reason,
  status: row.status,
  reviewer: row.reviewer_id ? { id: row.reviewer_id, name: row.reviewer_name } : null,
  reviewNote: row.review_note,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at,
});

function leaveQuery(db, tenantId) {
  return db("leave_requests as l")
    .join("users as u", "u.id", "l.user_id")
    .leftJoin("users as r", "r.id", "l.reviewer_id")
    .where("l.tenant_id", tenantId)
    .select("l.*", "u.name as user_name", "u.job_title as user_job_title", "r.name as reviewer_name");
}

/** Approved leave covering a day, per user: { type, portion }. */
async function approvedLeaveOn(db, tenantId, date, userId) {
  const query = db("leave_requests").where({ tenant_id: tenantId, status: "approved" }).where("start_date", "<=", date).where("end_date", ">=", date).select("user_id", "type", "portion");
  if (userId) query.where("user_id", userId);
  const rows = await query;
  return new Map(rows.map(row => [row.user_id, { type: row.type, portion: row.portion ?? "full" }]));
}

/** Annual leave used (approved) and requested (pending) in a calendar year. */
async function annualBalance(db, userId, year, settings) {
  const rows = await db("leave_requests")
    .where({ user_id: userId, type: "annual" })
    .whereIn("status", ["approved", "pending"])
    .where("start_date", ">=", `${year}-01-01`)
    .where("start_date", "<=", `${year}-12-31`);
  const sum = status => rows.filter(row => row.status === status).reduce((total, row) => total + leaveDays(row), 0);
  const used = sum("approved");
  const pending = sum("pending");
  return { year, allowance: settings.annualAllowance, used, pending, remaining: Math.max(0, settings.annualAllowance - used - pending) };
}

async function createRecord(db, req, { date, localTime: time, note = null, source }) {
  const id = await insertAndGetId(db, "attendance_records", {
    tenant_id: req.user.tenant_id,
    user_id: req.user.id,
    work_date: date,
    check_in_at: nowIso(),
    check_in_local: time ?? null,
    source,
    note: note || null,
  });
  return db("attendance_records").where({ id }).first();
}

// ---- My attendance ----
router.get("/today", requirePermission("attendance.self"), async (req, res) => {
  const { date } = validate(z.object({ date: dateOnly }), req.query);
  const settings = settingsOf(req);
  const db = getDb();
  const [record, leave, calendar] = await Promise.all([
    db("attendance_records").where({ user_id: req.user.id, work_date: date }).first(),
    approvedLeaveOn(db, req.user.tenant_id, date, req.user.id),
    calendarFor(db, req, date, date, req.user.id),
  ]);
  res.json({
    date,
    record: record ? toRecord(record, settings) : null,
    leave: leave.get(req.user.id) ?? null,
    workingDay: calendar.isWorkingDay(date),
    holiday: calendar.holidayOn(date),
    offReason: calendar.reasonOff(date),
    autoCheckIn: settings.autoCheckIn,
    workdayStart: settings.workdayStart,
  });
});

/**
 * Called by the app when someone opens it: records attendance for the day unless the workspace turned
 * this off, it isn't a working day, or they're on approved full-day leave. Safe to call repeatedly.
 */
router.post("/auto", requirePermission("attendance.self"), async (req, res) => {
  const input = validate(z.object({ date: dateOnly, localTime: localTime.optional() }), req.body);
  assertPlausibleToday(input.date);
  const settings = settingsOf(req);
  const db = getDb();

  const existing = await db("attendance_records").where({ user_id: req.user.id, work_date: input.date }).first();
  if (existing) return res.json({ recorded: false, reason: "already_recorded", record: toRecord(existing, settings) });
  if (!settings.autoCheckIn) return res.json({ recorded: false, reason: "disabled", record: null });
  const calendar = await calendarFor(db, req, input.date, input.date, req.user.id);
  if (!calendar.isWorkingDay(input.date)) return res.json({ recorded: false, reason: calendar.holidayOn(input.date) ? "holiday" : "non_working_day", record: null });
  const leave = (await approvedLeaveOn(db, req.user.tenant_id, input.date, req.user.id)).get(req.user.id);
  if (leave?.portion === "full") return res.json({ recorded: false, reason: "on_leave", record: null });

  try {
    const record = await createRecord(db, req, { date: input.date, localTime: input.localTime, source: "auto" });
    res.status(201).json({ recorded: true, reason: null, record: toRecord(record, settings) });
  } catch {
    // Two tabs opening at once: the unique (user, day) index kept one record; return it.
    const record = await db("attendance_records").where({ user_id: req.user.id, work_date: input.date }).first();
    res.json({ recorded: false, reason: "already_recorded", record: record ? toRecord(record, settings) : null });
  }
});

router.post("/check-in", requirePermission("attendance.self"), async (req, res) => {
  const input = validate(z.object({ date: dateOnly, localTime: localTime.optional(), note: z.string().trim().max(300).nullable().default(null) }), req.body);
  assertPlausibleToday(input.date);
  const settings = settingsOf(req);
  const db = getDb();
  const calendar = await calendarFor(db, req, input.date, input.date, req.user.id);
  if (!calendar.isWorkingDay(input.date)) throw new HttpError(422, `Today is ${calendar.reasonOff(input.date)}, not a working day.`, { code: "NON_WORKING_DAY" });
  const leave = (await approvedLeaveOn(db, req.user.tenant_id, input.date, req.user.id)).get(req.user.id);
  if (leave?.portion === "full") {
    throw new HttpError(422, "You're on approved leave today. Cancel the leave first if you're working.", { code: "ON_LEAVE" });
  }
  if (await db("attendance_records").where({ user_id: req.user.id, work_date: input.date }).first()) {
    throw new HttpError(409, "You've already checked in today.", { code: "ALREADY_CHECKED_IN" });
  }
  const record = await createRecord(db, req, { date: input.date, localTime: input.localTime, note: input.note, source: "manual" });
  res.status(201).json(toRecord(record, settings));
});

router.post("/check-out", requirePermission("attendance.self"), async (req, res) => {
  const input = validate(z.object({ date: dateOnly }), req.body);
  assertPlausibleToday(input.date);
  const db = getDb();
  const record = await db("attendance_records").where({ user_id: req.user.id, work_date: input.date }).first();
  if (!record) throw new HttpError(409, "Check in before checking out.", { code: "NOT_CHECKED_IN" });
  if (record.check_out_at) throw new HttpError(409, "You've already checked out today.", { code: "ALREADY_CHECKED_OUT" });
  await db("attendance_records").where({ id: record.id }).update({ check_out_at: nowIso() });
  res.json(toRecord(await db("attendance_records").where({ id: record.id }).first(), settingsOf(req)));
});

router.get("/me", requirePermission("attendance.self"), async (req, res) => {
  const { month: value } = validate(z.object({ month }), req.query);
  const { first, last } = monthRange(value);
  const settings = settingsOf(req);
  const db = getDb();
  const [records, leaves, balance] = await Promise.all([
    db("attendance_records").where({ user_id: req.user.id }).whereBetween("work_date", [first, last]).orderBy("work_date"),
    leaveQuery(db, req.user.tenant_id).where("l.user_id", req.user.id).where("l.status", "approved").where("l.start_date", "<=", last).where("l.end_date", ">=", first),
    annualBalance(db, req.user.id, Number(value.slice(0, 4)), settings),
  ]);
  const calendar = await calendarFor(db, req, first, last, req.user.id);
  const hours = records.reduce((sum, row) => sum + hoursBetween(row.check_in_at, row.check_out_at), 0);
  const completedDays = records.filter(row => row.check_out_at).length;
  const leaveTotal = leaves.reduce((sum, row) => {
    const span = calendar.countWorkingDays(row.start_date > first ? row.start_date : first, row.end_date < last ? row.end_date : last);
    return sum + (row.portion && row.portion !== "full" ? 0.5 : span);
  }, 0);
  res.json({
    month: value,
    records: records.map(row => toRecord(row, settings)),
    leaves: leaves.map(toLeave),
    summary: {
      daysPresent: records.length,
      lateDays: records.filter(row => lateMinutes(row, settings) > 0).length,
      hours: round1(hours),
      averageHours: completedDays ? round1(hours / completedDays) : 0,
      leaveDays: leaveTotal,
      workingDays: calendar.countWorkingDays(first, last),
    },
    balance,
  });
});

router.get("/balance", requirePermission("attendance.self"), async (req, res) => {
  const { year } = validate(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) }), req.query);
  res.json(await annualBalance(getDb(), req.user.id, year, settingsOf(req)));
});

// ---- Team view (admins) ----
router.get("/team", requirePermission("attendance.team.view"), async (req, res) => {
  const { date } = validate(z.object({ date: dateOnly }), req.query);
  const settings = settingsOf(req);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const [users, records, leave] = await Promise.all([
    db("users").where({ tenant_id: tenantId, is_active: true }).select("id", "name", "job_title").orderByRaw("lower(name)"),
    db("attendance_records").where({ tenant_id: tenantId, work_date: date }),
    approvedLeaveOn(db, tenantId, date),
  ]);
  const calendar = await calendarFor(db, req, date, date);
  const byUser = new Map(records.map(row => [row.user_id, row]));
  const people = users.map(user => {
    const record = byUser.get(user.id);
    const userLeave = leave.get(user.id) ?? null;
    let status = "absent";
    if (record) status = record.check_out_at ? "checked_out" : "present";
    else if (userLeave?.portion === "full") status = "on_leave";
    else if (userLeave) status = "half_day_leave";
    else if (!calendar.isWorkingDay(date)) status = "day_off";
    return { user: { id: user.id, name: user.name, jobTitle: user.job_title }, status, leave: userLeave, record: record ? toRecord(record, settings) : null };
  });
  const count = (...statuses) => people.filter(person => statuses.includes(person.status)).length;
  res.json({
    date,
    workingDay: calendar.isWorkingDay(date),
    holiday: calendar.holidayOn(date),
    offReason: calendar.reasonOff(date),
    people,
    summary: {
      total: people.length,
      present: count("present", "checked_out"),
      late: people.filter(person => person.record?.lateMinutes > 0).length,
      onLeave: count("on_leave", "half_day_leave"),
      absent: count("absent"),
    },
  });
});

router.get("/report", requirePermission("attendance.team.view"), async (req, res) => {
  const { month: value } = validate(z.object({ month }), req.query);
  const { first, last } = monthRange(value);
  const settings = settingsOf(req);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const [users, records, leaves] = await Promise.all([
    db("users").where({ tenant_id: tenantId, is_active: true }).select("id", "name", "job_title").orderByRaw("lower(name)"),
    db("attendance_records").where("tenant_id", tenantId).whereBetween("work_date", [first, last]),
    db("leave_requests").where({ tenant_id: tenantId, status: "approved" }).where("start_date", "<=", last).where("end_date", ">=", first),
  ]);
  const calendar = await calendarFor(db, req, first, last);
  res.json({
    month: value,
    workingDays: calendar.countWorkingDays(first, last),
    rows: users.map(user => {
      const mine = records.filter(row => row.user_id === user.id);
      const hours = mine.reduce((sum, row) => sum + hoursBetween(row.check_in_at, row.check_out_at), 0);
      const leaveTotal = leaves
        .filter(row => row.user_id === user.id)
        .reduce((sum, row) => sum + (row.portion && row.portion !== "full" ? 0.5 : calendar.countWorkingDays(row.start_date > first ? row.start_date : first, row.end_date < last ? row.end_date : last)), 0);
      return {
        user: { id: user.id, name: user.name, jobTitle: user.job_title },
        daysPresent: mine.length,
        lateDays: mine.filter(row => lateMinutes(row, settings) > 0).length,
        hours: round1(hours),
        leaveDays: leaveTotal,
      };
    }),
  });
});

// ---- Who's on leave (everyone with attendance access) ----
// Approved leave covering a day, so colleagues can plan around it: name, job title, roles, type, portion and dates.
// Never the reason or the review notes.
router.get("/on-leave", async (req, res) => {
  const { date } = validate(z.object({ date: dateOnly.refine(value => !Number.isNaN(toDate(value).getTime()), "Use a real date.") }), req.query);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const [rows, roles] = await Promise.all([
    db("leave_requests as l")
      .join("users as u", "u.id", "l.user_id")
      .where({ "l.tenant_id": tenantId, "l.status": "approved", "u.is_active": true })
      .where("l.start_date", "<=", date)
      .where("l.end_date", ">=", date)
      .orderByRaw("lower(u.name)")
      .orderBy("l.id")
      .select("l.id", "l.user_id", "l.type", "l.portion", "l.start_date", "l.end_date", "u.name as user_name", "u.job_title as user_job_title"),
    rolesByUser(db, tenantId),
  ]);
  res.json({
    date,
    people: rows.map(row => ({
      leaveId: row.id,
      user: { id: row.user_id, name: row.user_name, jobTitle: row.user_job_title ?? null },
      roles: (roles.get(row.user_id) ?? []).map(role => role.name),
      type: row.type,
      portion: row.portion ?? "full",
      startDate: row.start_date,
      endDate: row.end_date,
    })),
  });
});

// ---- Leave ----
router.get("/leave", async (req, res) => {
  const q = validate(z.object({ scope: z.enum(["mine", "all"]).default("mine"), status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional() }), req.query);
  const query = leaveQuery(getDb(), req.user.tenant_id).orderBy("l.start_date", "desc").orderBy("l.id", "desc").limit(200);
  if (q.scope === "mine" || !(can(req, "attendance.leave.approve") || can(req, "attendance.team.view"))) query.where("l.user_id", req.user.id);
  if (q.status) query.where("l.status", q.status);
  res.json((await query).map(toLeave));
});

router.post("/leave", requirePermission("attendance.self"), async (req, res) => {
  const settings = settingsOf(req);
  const input = validate(
    z
      .object({
        type: z.enum(["annual", "sick", "casual", "unpaid", "other"]),
        portion: z.enum(["full", "first_half", "second_half"]).default("full"),
        startDate: dateOnly,
        endDate: dateOnly,
        reason: z.string().trim().max(500).nullable().default(null),
      })
      .refine(value => value.endDate >= value.startDate, { path: ["endDate"], message: "The end date can't be before the start date." }),
    req.body
  );

  // ---- Validation against the workspace's rules ----
  if (!settings.leaveTypes.includes(input.type)) throw invalid("type", "This leave type isn't used in your workspace.");
  const halfDay = input.portion !== "full";
  if (halfDay && !settings.halfDayLeave) throw invalid("portion", "Your workspace doesn't allow half-day leave.");
  if (halfDay && input.startDate !== input.endDate) throw invalid("portion", "A half day must start and end on the same date.");
  if ((toDate(input.endDate) - toDate(input.startDate)) / DAY_MS > MAX_LEAVE_SPAN_DAYS) throw invalid("endDate", `Request at most ${MAX_LEAVE_SPAN_DAYS} days at a time.`);
  if ((toDate(toDay(new Date())) - toDate(input.startDate)) / DAY_MS > MAX_PAST_LEAVE_DAYS) {
    throw invalid("startDate", `Leave can be recorded up to ${MAX_PAST_LEAVE_DAYS} days back.`);
  }
  const db = getDb();
  const calendar = await calendarFor(db, req, input.startDate, input.endDate, req.user.id);
  const span = calendar.countWorkingDays(input.startDate, input.endDate);
  if (!span) throw invalid("endDate", halfDay ? `That date is ${calendar.reasonOff(input.startDate) ?? "not a working day"}.` : "Those dates are all holidays or days off.");
  const days = halfDay ? 0.5 : span;

  const overlap = await db("leave_requests")
    .where({ user_id: req.user.id })
    .whereIn("status", ["pending", "approved"])
    .where("start_date", "<=", input.endDate)
    .where("end_date", ">=", input.startDate)
    .select("portion");
  // Two halves of the same day may be requested separately; anything else overlapping is a clash.
  const clashes = overlap.some(row => !halfDay || (row.portion ?? "full") === "full" || row.portion === input.portion);
  if (clashes) throw invalid("startDate", "You already have leave requested for some of these days.");

  if (input.type === "annual") {
    const balance = await annualBalance(db, req.user.id, Number(input.startDate.slice(0, 4)), settings);
    if (days > balance.remaining) {
      throw invalid("endDate", `Only ${balance.remaining} annual leave day${balance.remaining === 1 ? "" : "s"} left this year (${balance.allowance} allowed, ${balance.used} taken, ${balance.pending} pending).`);
    }
  }

  const tenantId = req.user.tenant_id;
  const id = await db.transaction(async trx => {
    const leaveId = await insertAndGetId(trx, "leave_requests", {
      tenant_id: tenantId,
      user_id: req.user.id,
      type: input.type,
      portion: input.portion,
      start_date: input.startDate,
      end_date: input.endDate,
      days: halfDay ? 1 : span, // stored as whole days; half days are read as 0.5 from `portion`
      reason: input.reason || null,
      status: "pending",
      created_at: nowIso(),
    });
    await notifyUsers(trx, await usersWithPermission(trx, tenantId, "attendance.leave.approve"), {
      title: `${LEAVE_LABELS[input.type]} request`,
      body: `${req.user.name} asked for ${days} day${days === 1 ? "" : "s"}${PORTION_LABELS[input.portion]} (${input.startDate}${input.endDate !== input.startDate ? ` to ${input.endDate}` : ""})`,
      actorId: req.user.id,
    });
    return leaveId;
  });
  res.status(201).json(toLeave(await leaveQuery(db, tenantId).where("l.id", id).first()));
});

router.patch("/leave/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const input = validate(z.object({ status: z.enum(["approved", "rejected", "cancelled"]), reviewNote: z.string().trim().max(300).nullable().default(null) }), req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const leave = await db("leave_requests").where({ id, tenant_id: tenantId }).first();
  if (!leave) throw new HttpError(404, "Leave request not found.");

  const now = nowIso();
  if (input.status === "cancelled") {
    if (leave.user_id !== req.user.id) throw new HttpError(403, "Only the person who asked can cancel a request.", { code: "FORBIDDEN" });
    if (leave.status !== "pending" && !(leave.status === "approved" && leave.start_date > toDay(new Date()))) {
      throw new HttpError(422, "Only pending requests, or approved leave that hasn't started, can be cancelled.", { code: "INVALID_TRANSITION" });
    }
    await db("leave_requests").where({ id }).update({ status: "cancelled" });
  } else {
    if (!can(req, "attendance.leave.approve")) throw new HttpError(403, "You don't have permission to approve leave.", { code: "FORBIDDEN" });
    if (leave.status !== "pending") throw new HttpError(422, "This request has already been decided.", { code: "INVALID_TRANSITION" });
    if (leave.user_id === req.user.id) throw new HttpError(422, "Another admin must decide your own leave request.", { code: "SELF_APPROVAL" });
    await db.transaction(async trx => {
      await trx("leave_requests").where({ id }).update({ status: input.status, reviewer_id: req.user.id, review_note: input.reviewNote || null, reviewed_at: now });
      await notifyUsers(trx, [leave.user_id], {
        title: `${LEAVE_LABELS[leave.type]} ${input.status}`,
        body: `${req.user.name} ${input.status} your leave for ${leave.start_date}${leave.end_date !== leave.start_date ? ` to ${leave.end_date}` : ""}${PORTION_LABELS[leave.portion ?? "full"]}${input.reviewNote ? `: ${input.reviewNote}` : ""}`,
        actorId: req.user.id,
      });
    });
    const person = await db("users").where({ id: leave.user_id }).first();
    await recordTenantAudit(db, req, `leave.${input.status === "approved" ? "approve" : "reject"}`, person?.name, { type: leave.type, from: leave.start_date, to: leave.end_date });
  }
  res.json(toLeave(await leaveQuery(db, tenantId).where("l.id", id).first()));
});

export default router;
