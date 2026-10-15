// Password resets: a person asks from the sign-in page, a workspace admin issues a one-time link.
// Only the sha256 of a link token is stored; the token itself is shown to the admin once.
import crypto from "node:crypto";
import { nowIso } from "../utils/http.js";

/** Requests an admin still has to act on, or links that may still be used. */
export const OPEN_STATUSES = Object.freeze(["requested", "issued"]);

/** 32 random bytes as base64url: always 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newResetToken = () => crypto.randomBytes(32).toString("base64url");

export const hashResetToken = token => crypto.createHash("sha256").update(String(token)).digest("hex");

/** "asha.rao@example.com" → "a***@e***.com" (enough to recognise, not enough to harvest). */
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email).split("@");
  const dot = domain.indexOf(".");
  const host = dot === -1 ? domain : domain.slice(0, dot);
  const suffix = dot === -1 ? "" : domain.slice(dot);
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${suffix}`;
}

/** Issued links past their expiry become `expired` (run before reading or changing a tenant's requests). */
export function expireStaleLinks(db, where = {}) {
  return db("password_resets").where(where).where("status", "issued").where("expires_at", "<", nowIso()).update({ status: "expired" });
}

/**
 * Closes every open request or link of a person, e.g. after their password changed some other way.
 * @param {"used" | "expired" | "dismissed"} status
 */
export function closeOpenResets(db, userId, status, { exceptId } = {}) {
  const query = db("password_resets").where({ user_id: userId }).whereIn("status", OPEN_STATUSES);
  if (exceptId) query.whereNot("id", exceptId);
  return query.update(status === "used" ? { status, used_at: nowIso() } : { status });
}
