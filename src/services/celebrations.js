// Birthdays and work anniversaries: age calculation, upcoming dates, and the daily greetings job.
// Colleagues only ever see the day and month of a birthday (never the year), and only when the person
// allows it. Each greeting is sent once per person, kind, and year (celebration_notices is unique on that).
import { getPlatformDb } from "../db/connection.js";
import { runInTenant, tenantDb } from "./tenantDatabases.js";
import { resolveSettings } from "./moduleSettings.js";
import { nowIso } from "../utils/http.js";

const INTERVAL_MS = 10 * 60 * 1000;
let timer = null;
let running = false;

const localToday = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const isLeap = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Completed years between a YYYY-MM-DD date and `on` (default today). */
export function yearsSince(date, on = localToday()) {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  const [ty, tm, td] = on.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** This year's occurrence of a month-day; 29 Feb falls on 28 Feb in other years. */
export function occurrence(date, year) {
  const [, m, d] = date.split("-").map(Number);
  const day = m === 2 && d === 29 && !isLeap(year) ? 28 : d;
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The next occurrence on or after `from`. */
export function nextOccurrence(date, from = localToday()) {
  const year = Number(from.slice(0, 4));
  const thisYear = occurrence(date, year);
  return thisYear >= from ? thisYear : occurrence(date, year + 1);
}

/**
 * Birthdays (that people share) and work anniversaries in the next `days` days, soonest first.
 * @returns {Promise<{ user: { id: number, name: string, jobTitle: string | null }, kind: "birthday" | "anniversary", date: string, isToday: boolean, years: number | null }[]>}
 */
export async function upcomingCelebrations(db, tenantId, settings, { days = 30, from = localToday() } = {}) {
  const users = await db("users").where({ tenant_id: tenantId, is_active: true }).select("id", "name", "job_title", "date_of_birth", "joined_on", "show_birthday");
  const until = new Date(`${from}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + days);
  const limit = until.toISOString().slice(0, 10);
  const items = [];
  for (const user of users) {
    const person = { id: user.id, name: user.name, jobTitle: user.job_title };
    if (settings.celebrations.birthdays !== "off" && user.date_of_birth && user.show_birthday) {
      const date = nextOccurrence(user.date_of_birth, from);
      if (date <= limit) items.push({ user: person, kind: "birthday", date, isToday: date === from, years: null });
    }
    if (settings.celebrations.anniversaries !== "off" && user.joined_on) {
      const date = nextOccurrence(user.joined_on, from);
      const years = yearsSince(user.joined_on, date);
      if (date <= limit && years >= 1) items.push({ user: person, kind: "anniversary", date, isToday: date === from, years });
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.user.name.localeCompare(b.user.name));
}

/** Records the notice; false if this greeting was already sent (the unique index decides). */
async function claimNotice(db, tenantId, userId, kind, year) {
  try {
    await db("celebration_notices").insert({ tenant_id: tenantId, user_id: userId, kind, year, created_at: nowIso() });
    return true;
  } catch {
    return false;
  }
}

async function notify(db, userIds, title, body) {
  if (!userIds.length) return;
  const createdAt = nowIso();
  await db("notifications").insert(userIds.map(userId => ({ user_id: userId, task_id: null, ticket_id: null, title: title.slice(0, 255), body: body.slice(0, 500), is_read: false, created_at: createdAt })));
}

/** Sends today's greetings for every active tenant. Safe to run often. */
export async function processCelebrations(today = localToday()) {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const year = Number(today.slice(0, 4));
    for (const tenant of await getPlatformDb()("tenants").where("status", "active").whereNull("deleted_at").select("id", "settings")) {
      sent += await runInTenant(tenant.id, () => greetTenant(tenantDb(tenant.id), tenant, today, year));
    }
    return sent;
  } catch (error) {
    console.error("[celebrations]", error.message);
    return sent;
  } finally {
    running = false;
  }
}

/** Today's greetings for one tenant, in its own database. */
async function greetTenant(db, tenant, today, year) {
  let sent = 0;
  const settings = resolveSettings(tenant.settings);
  for (const item of await upcomingCelebrationsForToday(db, tenant.id, settings, today)) {
    if (!(await claimNotice(db, tenant.id, item.user.id, item.kind, year))) continue;
    const first = item.user.name.split(" ")[0];
    const mode = item.kind === "birthday" ? settings.celebrations.birthdays : settings.celebrations.anniversaries;
    if (item.kind === "birthday") {
      await notify(db, [item.user.id], `Happy birthday, ${first}!`, "Wishing you a wonderful year ahead from everyone at work.");
    } else {
      await notify(db, [item.user.id], `Happy ${item.years}-year work anniversary, ${first}!`, `Thank you for ${item.years} year${item.years === 1 ? "" : "s"} with the team.`);
    }
    if (mode === "everyone" && (item.kind === "anniversary" || item.shared)) {
      const colleagues = (await db("users").where({ tenant_id: tenant.id, is_active: true }).whereNot("id", item.user.id).select("id").limit(500)).map(row => row.id);
      await notify(
        db,
        colleagues,
        item.kind === "birthday" ? `It's ${item.user.name}'s birthday today` : `${item.user.name}: ${item.years} year${item.years === 1 ? "" : "s"} with the team`,
        item.kind === "birthday" ? "Send them a message to wish them well." : "Congratulate them on their work anniversary."
      );
    }
    sent++;
  }
  return sent;
}

/** Today's birthdays (whether or not shared: the person is still greeted) and anniversaries. */
async function upcomingCelebrationsForToday(db, tenantId, settings, today) {
  const users = await db("users").where({ tenant_id: tenantId, is_active: true }).select("id", "name", "date_of_birth", "joined_on", "show_birthday");
  const year = Number(today.slice(0, 4));
  const items = [];
  for (const user of users) {
    if (settings.celebrations.birthdays !== "off" && user.date_of_birth && occurrence(user.date_of_birth, year) === today) {
      items.push({ user, kind: "birthday", shared: Boolean(user.show_birthday) });
    }
    if (settings.celebrations.anniversaries !== "off" && user.joined_on && occurrence(user.joined_on, year) === today) {
      const years = yearsSince(user.joined_on, today);
      if (years >= 1) items.push({ user, kind: "anniversary", years });
    }
  }
  return items;
}

export function startCelebrationScheduler() {
  if (timer) return;
  processCelebrations();
  timer = setInterval(processCelebrations, INTERVAL_MS);
  timer.unref();
}

export function stopCelebrationScheduler() {
  clearInterval(timer);
  timer = null;
}
