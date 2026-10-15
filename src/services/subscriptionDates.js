// Subscription dates of a tenant: when it ends, its grace period, and whether access has stopped.
// Pure functions with no imports (middleware/auth.js uses them, and must not pull in the database or realtime).
// Days are UTC calendar days (YYYY-MM-DD). A subscription with no end date never expires.

/** Today as YYYY-MM-DD (UTC). */
export const utcToday = (date = new Date()) => date.toISOString().slice(0, 10);

/** YYYY-MM-DD plus n days. */
export function addDaysTo(day, days) {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The last day the tenant can still sign in: the end date plus the grace days; null = no end. */
export function lastAccessDay(endsOn, graceDays) {
  if (!endsOn) return null;
  return addDaysTo(endsOn, Math.max(0, Number(graceDays) || 0));
}

/** True once the end date and the grace period have both passed: nobody in the tenant can sign in. */
export function subscriptionExpired(endsOn, graceDays, today = utcToday()) {
  const last = lastAccessDay(endsOn, graceDays);
  return Boolean(last) && today > last;
}

/** Days before the end date on which admins get an automatic notice. */
export const NOTICE_THRESHOLDS = Object.freeze([30, 14, 7, 3, 1, 0]);

/** Within this many days of the end date a subscription counts as "ending soon". */
export const ENDING_SOON_DAYS = 30;

/**
 * The console's and the tenant's view of a subscription.
 * state: none (no end date), active, ending (within 30 days), grace (ended, still has access), expired (access stopped).
 * @param {{ plan?: string | null, subscription_starts_on?: string | null, subscription_ends_on?: string | null, grace_days?: number | null }} row
 */
export function subscriptionSummary(row, today = utcToday()) {
  const endsOn = row.subscription_ends_on ?? null;
  const graceDays = Number(row.grace_days ?? 0);
  const graceEndsOn = lastAccessDay(endsOn, graceDays);
  const daysLeft = endsOn ? daysBetween(today, endsOn) : null;
  let state = "none";
  if (endsOn) {
    if (today > graceEndsOn) state = "expired";
    else if (today > endsOn) state = "grace";
    else if (daysLeft <= ENDING_SOON_DAYS) state = "ending";
    else state = "active";
  }
  return {
    plan: row.plan ?? "",
    startsOn: row.subscription_starts_on ?? null,
    endsOn,
    graceDays,
    graceEndsOn,
    daysLeft,
    state,
  };
}
