// Billing math and numbering, shared by every invoice and quote route. Money is rounded to 2 decimals per line,
// then totals are summed from the rounded lines so the printed document always adds up.

export const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** Today as YYYY-MM-DD (UTC, like expense dates). */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** A YYYY-MM-DD date moved by whole days. */
export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Prices resolved lines and adds them up.
 * subtotal is before discounts; each line's line_subtotal is after its discount and before tax.
 * @param {Array<{ quantity: number, unit_price: number, discount_pct: number, tax_rate: number }>} lines
 */
export function priceLines(lines) {
  const totals = { subtotal: 0, discount_total: 0, tax_total: 0, total: 0 };
  const priced = lines.map((line, index) => {
    const gross = round2(line.quantity * line.unit_price);
    const lineSubtotal = round2(line.quantity * line.unit_price * (1 - line.discount_pct / 100));
    const lineTax = round2((lineSubtotal * line.tax_rate) / 100);
    totals.subtotal += gross;
    totals.discount_total += round2(gross - lineSubtotal);
    totals.tax_total += lineTax;
    return { ...line, position: index, line_subtotal: lineSubtotal, line_tax: lineTax, line_total: round2(lineSubtotal + lineTax) };
  });
  totals.subtotal = round2(totals.subtotal);
  totals.discount_total = round2(totals.discount_total);
  totals.tax_total = round2(totals.tax_total);
  totals.total = round2(totals.subtotal - totals.discount_total + totals.tax_total);
  return { lines: priced, totals };
}

/**
 * The next free number for a tenant and kind: prefix + the highest numeric suffix in use + 1, padded to 4.
 * Call inside the transaction that inserts the document.
 */
export async function nextNumber(trx, tenantId, kind, prefix) {
  const rows = await trx("invoices").where({ tenant_id: tenantId, kind }).where("number", "like", `${prefix}%`).select("number");
  const highest = rows.reduce((max, row) => {
    const suffix = row.number.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

/** True for a unique-constraint failure on SQLite, Postgres, or MySQL. */
export const isUniqueViolation = error => error?.code === "23505" || error?.code === "ER_DUP_ENTRY" || /unique|duplicate/i.test(String(error?.message));
