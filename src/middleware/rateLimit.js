// Industrial-standard, memory-safe in-memory sliding-window rate limiter middleware.
// Complies with RFC 6585 (429 Too Many Requests) and provides standard RateLimit headers.
import { HttpError } from "../utils/http.js";

/**
 * Creates an Express rate limiting middleware.
 * @param {Object} options
 * @param {number} [options.windowMs=60000] - Time window in milliseconds
 * @param {number} [options.max=100] - Max allowed requests per window
 * @param {string} [options.message] - Custom message on rate limit exceeded
 * @param {string} [options.code="TOO_MANY_REQUESTS"] - Error code
 * @param {(req: import("express").Request) => string} [options.keyGenerator] - Custom key generator
 * @param {(req: import("express").Request) => boolean} [options.skip] - Condition to skip rate limiting
 */
export function createRateLimiter({
  windowMs = 60 * 1000,
  max = 100,
  message = "Too many requests. Please slow down and try again later.",
  code = "TOO_MANY_REQUESTS",
  keyGenerator = req => req.ip || req.socket?.remoteAddress || "unknown",
  skip = () => false,
} = {}) {
  // Store: key -> { count: number, resetAt: number }
  const store = new Map();

  // Periodic pruning every 60s to avoid memory leaks
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }, Math.min(windowMs, 60_000));
  // Unref so timer doesn't prevent Node from exiting
  if (cleanupTimer.unref) cleanupTimer.unref();

  return function rateLimiter(req, res, next) {
    if (skip(req)) return next();

    const key = keyGenerator(req);
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
    } else {
      entry.count += 1;
    }

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

    // Standard RFC RateLimit headers
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetSeconds);

    if (entry.count > max) {
      res.setHeader("Retry-After", resetSeconds);
      throw new HttpError(429, message, { code, retryAfterSeconds: resetSeconds });
    }

    next();
  };
}

/** Global API rate limiter: 600 req/min per IP to prevent DoS */
export const globalRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: "Too many requests from this address. Please wait a minute.",
  code: "RATE_LIMIT_GLOBAL",
});

/** Auth rate limiter: 20 req/min per IP for sensitive sign-in/reset routes */
export const authRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many authentication attempts. Please wait a minute before trying again.",
  code: "RATE_LIMIT_AUTH",
});

/** Setup rate limiter: 25 req/min per IP */
export const setupRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 25,
  message: "Too many setup attempts. Please slow down.",
  code: "RATE_LIMIT_SETUP",
});

/** Admin console rate limiter: 40 req/min per IP */
export const adminRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 40,
  message: "Too many admin requests. Please wait a moment.",
  code: "RATE_LIMIT_ADMIN",
});

/** Public tracking/queue rate limiter: 120 req/min per IP */
export const publicRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many public requests. Please slow down.",
  code: "RATE_LIMIT_PUBLIC",
});
