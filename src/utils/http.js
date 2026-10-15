/** Error with an HTTP status; the error handler turns it into a JSON response. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message - Safe to show to users
   * @param {{ code?: string, errors?: Object<string, string>, data?: Object }} [extra] - data: extra fields for the response body
   */
  constructor(status, message, { code, errors, data } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.data = data;
  }
}

export const nowIso = () => new Date().toISOString();

/**
 * Parse `data` with a zod schema; throws a 422 with field errors on failure.
 * @template T
 * @param {import("zod").ZodType<T>} schema
 * @param {unknown} data
 * @returns {T}
 */
export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const errors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors });
}

/** Parse a route id param or throw 404. */
export function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Not found.");
  return id;
}
