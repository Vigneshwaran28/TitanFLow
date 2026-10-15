// A workspace's security restrictions (settings.security, see moduleSettings.js): password rules, how long a
// sign-in lasts, and which email domains accounts may use. Every place that sets a password or creates an
// account goes through these checks, so the rules hold no matter which screen was used.
import { DEFAULT_SETTINGS } from "./moduleSettings.js";
import { HttpError } from "../utils/http.js";

const DEFAULTS = DEFAULT_SETTINGS.security;

/** The policy from resolved settings (or defaults when a caller has none, e.g. the provider console). */
export const policyOf = settings => ({ ...DEFAULTS, ...(settings?.security ?? {}) });

/** Why a new password breaks the policy, or null when it's fine. */
export function passwordProblem(policy, password) {
  const { passwordMinLength, passwordRequireMixed } = policyOf({ security: policy });
  const value = String(password ?? "");
  if (value.length < passwordMinLength) return `Use at least ${passwordMinLength} characters.`;
  if (passwordRequireMixed && !(/[A-Za-z]/.test(value) && /\d/.test(value))) return "Use both letters and numbers.";
  return null;
}

/** Throws a 422 with the problem on `field` (the form field that holds the password). */
export function assertPasswordAllowed(policy, password, field = "password") {
  const problem = passwordProblem(policy, password);
  if (problem) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { [field]: problem } });
}

/** Why this email can't be used for an account in the workspace, or null. */
export function emailDomainProblem(policy, email) {
  const domains = policyOf({ security: policy }).allowedEmailDomains;
  if (!domains.length) return null;
  const domain = String(email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  if (domains.includes(domain)) return null;
  return `Your workspace only allows ${domains.map(value => `@${value}`).join(", ")} addresses.`;
}

export function assertEmailAllowed(policy, email, field = "email") {
  const problem = emailDomainProblem(policy, email);
  if (problem) throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors: { [field]: problem } });
}

/** How long a sign-in lasts, in hours. */
export const sessionHoursOf = settings => policyOf(settings).sessionHours;
