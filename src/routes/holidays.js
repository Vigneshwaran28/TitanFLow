// Holiday calendar for a tenant: public and company holidays (days off for everyone), optional holidays
// (each person may pick a few per year), CSV import with a preview step, and CSV export.
// Reading is open to anyone with attendance access; changes need "Manage holidays".
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { can, requirePermission } from "../middleware/auth.js";
import { recordTenantAudit } from "../services/tenantAudit.js";
import { toDate, toDay } from "../services/workCalendar.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const TYPES = ["public", "company", "optional"];
const MAX_IMPORT_ROWS = 1000;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.").refine(isRealDate, "That date doesn't exist.");

const holidaySchema = z.object({
  date: dateOnly,
  name: z.string().trim().min(1, "Name the holiday.").max(120),
  type: z.enum(TYPES).default("public"),
  description: z.string().trim().max(300).nullable().default(null),
});

const settingsOf = req => req.tenant.settings.attendance;
const manage = requirePermission("attendance.holidays.manage");

function isRealDate(value) {
  const date = toDate(value);
  return !Number.isNaN(date.getTime()) && toDay(date) === value;
}

const toHoliday = (row, picked) => ({
  id: row.id,
  date: row.holiday_date,
  name: row.name,
  type: row.type,
  description: row.description,
  picked: picked?.has(row.id) ?? false,
  pickCount: row.pick_count != null ? Number(row.pick_count) : undefined,
});

async function findHoliday(db, tenantId, id) {
  const row = await db("holidays").where({ id, tenant_id: tenantId }).first();
  if (!row) throw new HttpError(404, "Holiday not found.");
  return row;
}

async function assertNoDuplicate(db, tenantId, date, name, exceptId) {
  const query = db("holidays").where({ tenant_id: tenantId, holiday_date: date }).whereRaw("lower(name) = ?", [name.toLowerCase()]);
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) throw new HttpError(422, "Please fix the highlighted fields.", { errors: { name: "This holiday is already on that date." } });
}

// ---- CSV ----
/** Splits CSV text into rows of cells (handles quotes, escaped quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(cells => cells.some(value => value.trim()));
}

/** Accepts 2026-10-20, 20/10/2026, 20-10-2026, or 20.10.2026 (day first). */
function normalizeDate(value) {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return null;
}

const TYPE_ALIASES = { public: "public", national: "public", gazetted: "public", company: "company", office: "company", optional: "optional", restricted: "optional", floating: "optional" };

/** Validates CSV rows; returns the holidays to save and per-line problems. */
function readImport(csv) {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  if (!rows.length) throw new HttpError(422, "The file is empty.", { code: "EMPTY_IMPORT" });
  const header = rows[0].map(cell => cell.trim().toLowerCase());
  const hasHeader = header.includes("date");
  const col = name => (hasHeader ? header.indexOf(name) : { date: 0, name: 1, type: 2, description: 3 }[name]);
  const index = { date: col("date"), name: hasHeader ? Math.max(header.indexOf("name"), header.indexOf("holiday")) : 1, type: col("type"), description: col("description") };
  if (hasHeader && index.name < 0) throw new HttpError(422, "The header needs a \"name\" column.", { code: "BAD_IMPORT" });
  const data = hasHeader ? rows.slice(1) : rows;
  if (data.length > MAX_IMPORT_ROWS) throw new HttpError(422, `Import at most ${MAX_IMPORT_ROWS} rows at a time.`, { code: "BAD_IMPORT" });

  const items = [];
  const errors = [];
  const seen = new Set();
  data.forEach((cells, offset) => {
    const line = offset + (hasHeader ? 2 : 1);
    const get = key => (index[key] >= 0 ? (cells[index[key]] ?? "").trim() : "");
    const date = normalizeDate(get("date"));
    const name = get("name");
    const rawType = get("type").toLowerCase();
    const type = rawType ? TYPE_ALIASES[rawType] : "public";
    if (!date || !isRealDate(date)) return errors.push({ line, message: `"${get("date")}" isn't a date. Use YYYY-MM-DD or DD/MM/YYYY.` });
    if (!name) return errors.push({ line, message: "The holiday needs a name." });
    if (name.length > 120) return errors.push({ line, message: "Keep the name under 120 characters." });
    if (!type) return errors.push({ line, message: `Type "${get("type")}" should be public, company, or optional.` });
    const key = `${date}|${name.toLowerCase()}`;
    if (seen.has(key)) return errors.push({ line, message: `${name} on ${date} appears twice in the file.` });
    seen.add(key);
    items.push({ line, date, name, type, description: get("description").slice(0, 300) || null });
  });
  return { items, errors };
}

const csvCell = value => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// ---- Routes ----
router.get("/", async (req, res) => {
  const { year } = validate(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) }), req.query);
  const db = getDb();
  const settings = settingsOf(req);
  const tenantId = req.user.tenant_id;
  const managing = can(req, "attendance.holidays.manage");
  const pickCounts = db("holiday_selections").count("*").whereRaw("holiday_selections.holiday_id = holidays.id").as("pick_count");
  const query = db("holidays").where("tenant_id", tenantId).whereBetween("holiday_date", [`${year}-01-01`, `${year}-12-31`]).orderBy("holiday_date").orderBy("name");
  const rows = await (managing ? query.select("holidays.*", pickCounts) : query.select("holidays.*"));
  const picked = new Set(
    (await db("holiday_selections").where("user_id", req.user.id).whereIn("holiday_id", rows.map(row => row.id)).select("holiday_id")).map(row => row.holiday_id)
  );
  res.json({
    year,
    holidays: rows.map(row => toHoliday(row, picked)),
    optional: { quota: settings.optionalHolidayQuota, picked: rows.filter(row => row.type === "optional" && picked.has(row.id)).length },
    weekend: { workingDays: settings.workingDays, saturdaysOff: settings.saturdaysOff },
    canManage: managing,
  });
});

router.post("/", manage, async (req, res) => {
  const input = validate(holidaySchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertNoDuplicate(db, tenantId, input.date, input.name);
  const now = nowIso();
  const id = await insertAndGetId(db, "holidays", {
    tenant_id: tenantId,
    holiday_date: input.date,
    name: input.name,
    type: input.type,
    description: input.description || null,
    created_by: req.user.id,
    created_at: now,
    updated_at: now,
  });
  await recordTenantAudit(db, req, "holiday.create", `${input.name} (${input.date})`, { type: input.type });
  res.status(201).json(toHoliday(await findHoliday(db, tenantId, id)));
});

router.patch("/:id", manage, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findHoliday(db, tenantId, id);
  const input = validate(holidaySchema, { date: current.holiday_date, name: current.name, type: current.type, description: current.description, ...req.body });
  await assertNoDuplicate(db, tenantId, input.date, input.name, id);
  await db.transaction(async trx => {
    await trx("holidays").where({ id }).update({ holiday_date: input.date, name: input.name, type: input.type, description: input.description || null, updated_at: nowIso() });
    // Picks only make sense for optional holidays.
    if (input.type !== "optional") await trx("holiday_selections").where({ holiday_id: id }).delete();
  });
  await recordTenantAudit(db, req, "holiday.update", `${input.name} (${input.date})`);
  res.json(toHoliday(await findHoliday(db, tenantId, id)));
});

router.delete("/:id", manage, async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const holiday = await findHoliday(db, req.user.tenant_id, id);
  await db("holidays").where({ id }).delete();
  await recordTenantAudit(db, req, "holiday.delete", `${holiday.name} (${holiday.holiday_date})`);
  res.status(204).end();
});

/**
 * CSV import. `dryRun` returns what would happen without saving. `merge` adds new holidays and updates
 * matching ones (same date and name); `replace` first removes the existing holidays in the years the file covers.
 */
router.post("/import", manage, async (req, res) => {
  const input = validate(
    z.object({ csv: z.string().min(1, "Choose a CSV file.").max(200_000, "The file is too large."), mode: z.enum(["merge", "replace"]).default("merge"), dryRun: z.boolean().default(false) }),
    req.body
  );
  const { items, errors } = readImport(input.csv);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const years = [...new Set(items.map(item => item.date.slice(0, 4)))];
  const existing = years.length
    ? await db("holidays")
        .where("tenant_id", tenantId)
        .where(inner => years.forEach(year => inner.orWhereBetween("holiday_date", [`${year}-01-01`, `${year}-12-31`])))
        .select("id", "holiday_date", "name")
    : [];
  const byKey = new Map(existing.map(row => [`${row.holiday_date}|${row.name.toLowerCase()}`, row]));
  const plan = items.map(item => ({ ...item, action: input.mode === "merge" && byKey.has(`${item.date}|${item.name.toLowerCase()}`) ? "update" : "create" }));
  const summary = {
    create: plan.filter(item => item.action === "create").length,
    update: plan.filter(item => item.action === "update").length,
    remove: input.mode === "replace" ? existing.length : 0,
    years: years.map(Number).sort(),
    errors,
    preview: plan.slice(0, 50).map(({ line, date, name, type, action }) => ({ line, date, name, type, action })),
  };
  if (input.dryRun || !items.length) return res.json({ ...summary, saved: false });

  const now = nowIso();
  await db.transaction(async trx => {
    if (input.mode === "replace" && existing.length) await trx("holidays").whereIn("id", existing.map(row => row.id)).delete();
    for (const item of plan) {
      const match = byKey.get(`${item.date}|${item.name.toLowerCase()}`);
      if (input.mode === "merge" && match) {
        await trx("holidays").where({ id: match.id }).update({ type: item.type, description: item.description, updated_at: now });
      } else {
        await trx("holidays").insert({ tenant_id: tenantId, holiday_date: item.date, name: item.name, type: item.type, description: item.description, created_by: req.user.id, created_at: now, updated_at: now });
      }
    }
  });
  await recordTenantAudit(db, req, "holiday.import", `${summary.create + summary.update} holidays`, { mode: input.mode, created: summary.create, updated: summary.update, removed: summary.remove, skipped: errors.length });
  res.status(201).json({ ...summary, saved: true });
});

router.get("/export", async (req, res) => {
  const { year } = validate(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) }), req.query);
  const rows = await getDb()("holidays")
    .where("tenant_id", req.user.tenant_id)
    .whereBetween("holiday_date", [`${year}-01-01`, `${year}-12-31`])
    .orderBy("holiday_date");
  const lines = ["date,name,type,description", ...rows.map(row => [row.holiday_date, row.name, row.type, row.description].map(csvCell).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="holidays-${year}.csv"`);
  res.send(lines.join("\r\n"));
});

// ---- Optional holidays: each person picks up to the yearly quota ----
router.post("/:id/pick", requirePermission("attendance.self"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const holiday = await findHoliday(db, req.user.tenant_id, id);
  if (holiday.type !== "optional") throw new HttpError(422, "Only optional holidays can be picked.", { code: "NOT_OPTIONAL" });
  if (holiday.holiday_date < toDay(new Date())) throw new HttpError(422, "That holiday has already passed.", { code: "HOLIDAY_PAST" });
  const year = holiday.holiday_date.slice(0, 4);
  const [{ count }] = await db("holiday_selections as s")
    .join("holidays as h", "h.id", "s.holiday_id")
    .where({ "s.user_id": req.user.id, "h.type": "optional" })
    .whereBetween("h.holiday_date", [`${year}-01-01`, `${year}-12-31`])
    .count({ count: "*" });
  const quota = settingsOf(req).optionalHolidayQuota;
  const already = await db("holiday_selections").where({ holiday_id: id, user_id: req.user.id }).first();
  if (!already && Number(count) >= quota) {
    throw new HttpError(422, `You've already picked ${quota} optional holiday${quota === 1 ? "" : "s"} for ${year}. Drop one to pick another.`, { code: "QUOTA_REACHED" });
  }
  if (!already) await db("holiday_selections").insert({ holiday_id: id, user_id: req.user.id, created_at: nowIso() });
  res.status(201).json({ picked: true });
});

router.delete("/:id/pick", requirePermission("attendance.self"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const holiday = await findHoliday(db, req.user.tenant_id, id);
  if (holiday.holiday_date < toDay(new Date())) throw new HttpError(422, "That holiday has already passed.", { code: "HOLIDAY_PAST" });
  await db("holiday_selections").where({ holiday_id: id, user_id: req.user.id }).delete();
  res.status(204).end();
});

export default router;
