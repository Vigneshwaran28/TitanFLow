// The tenant's work calendar: which days are worked, for one person or for everyone.
// A day is off when its weekday isn't a working day, when it's a Saturday the tenant gives off
// (e.g. 2nd and 4th), when it's a public or company holiday, or when it's an optional holiday the
// person picked. Dates are calendar days (YYYY-MM-DD) and never shift with time zones.

const DAY_MS = 86_400_000;
export const toDate = value => new Date(`${value}T00:00:00Z`);
export const toDay = date => date.toISOString().slice(0, 10);

/** 1 for the first Saturday of the month, 2 for the second, and so on. */
export const weekOfMonth = date => Math.ceil(toDate(date).getUTCDate() / 7);

/**
 * Loads holidays in a date range and returns calendar helpers.
 * @param {import("knex").Knex} db
 * @param {number} tenantId
 * @param {{ workingDays: number[], saturdaysOff?: number[] }} settings - attendance settings
 * @param {{ from: string, to: string, userId?: number }} range - userId adds that person's optional holidays
 */
export async function loadCalendar(db, tenantId, settings, { from, to, userId }) {
  const holidays = await db("holidays").where("tenant_id", tenantId).whereBetween("holiday_date", [from, to]).select("id", "holiday_date", "name", "type");
  const picked = userId
    ? new Set((await db("holiday_selections").where("user_id", userId).whereIn("holiday_id", holidays.map(row => row.id)).select("holiday_id")).map(row => row.holiday_id))
    : new Set();

  const byDate = new Map();
  for (const holiday of holidays) {
    // Optional holidays only count for people who picked them.
    if (holiday.type === "optional" && !picked.has(holiday.id)) continue;
    if (!byDate.has(holiday.holiday_date)) byDate.set(holiday.holiday_date, { name: holiday.name, type: holiday.type });
  }

  const saturdaysOff = new Set(settings.saturdaysOff ?? []);
  const weekendOff = date => {
    const weekday = toDate(date).getUTCDay();
    if (!settings.workingDays.includes(weekday)) return true;
    return weekday === 6 && saturdaysOff.has(weekOfMonth(date));
  };

  const helpers = {
    /** @returns {{ name: string, type: string } | null} */
    holidayOn: date => byDate.get(date) ?? null,
    isWorkingDay: date => !weekendOff(date) && !byDate.has(date),
    /** Why a day is off, for messages; null when it's a working day. */
    reasonOff: date => {
      const holiday = byDate.get(date);
      if (holiday) return `${holiday.name} (holiday)`;
      if (weekendOff(date)) return toDate(date).getUTCDay() === 6 && settings.workingDays.includes(6) ? "a Saturday off" : "a weekend day";
      return null;
    },
    /** Working days between two dates, inclusive. */
    countWorkingDays: (start, end) => {
      let count = 0;
      for (let day = toDate(start); day <= toDate(end); day = new Date(day.getTime() + DAY_MS)) {
        if (helpers.isWorkingDay(toDay(day))) count++;
      }
      return count;
    },
  };
  return helpers;
}
