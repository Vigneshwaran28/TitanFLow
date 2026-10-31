// Industrial-standard security headers and CORS middleware for TaskFlow.

/**
 * Attaches industry-standard security defense headers to every HTTP response.
 */
export function securityHeaders(req, res, next) {
  // Prevent MIME-sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Clickjacking defense
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  // Leakage defense on referrers
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Disable flawed legacy browser XSS filters that could be abused
  res.setHeader("X-XSS-Protection", "0");

  // Restrict sensitive browser APIs
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
  );

  // Cross-Origin policies
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");

  // Content Security Policy
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' ws: wss: https:; frame-ancestors 'self';"
  );

  // Enforce HSTS when running on HTTPS or behind an SSL-terminating reverse proxy
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  if (isHttps || process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  next();
}

/**
 * Parse and validate allowed origins for CORS.
 */
function isAllowedOrigin(origin, host) {
  if (!origin) return true; // Server-to-server or same-origin requests

  const customAllowed = (process.env.ALLOWED_ORIGINS || process.env.TASKFLOW_ALLOWED_ORIGINS || "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

  if (customAllowed.includes(origin)) return true;

  try {
    const originUrl = new URL(origin);

    // Localhost or loopback origins permitted only in non-production environments
    if (process.env.NODE_ENV !== "production") {
      if (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1" || originUrl.hostname === "::1") {
        return true;
      }
    }

    const trustedHosts = (process.env.TRUSTED_HOSTS || process.env.TASKFLOW_TRUSTED_HOSTS || "")
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(Boolean);

    if (trustedHosts.length > 0) {
      return trustedHosts.includes(originUrl.hostname.toLowerCase());
    }

    const configuredHost = (process.env.APP_URL || process.env.PUBLIC_URL || process.env.TASKFLOW_URL)
      ? new URL(process.env.APP_URL || process.env.PUBLIC_URL || process.env.TASKFLOW_URL).hostname
      : null;
    if (configuredHost && originUrl.hostname.toLowerCase() === configuredHost.toLowerCase()) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Robust CORS middleware for API endpoints.
 */
export function corsHandler(req, res, next) {
  const origin = req.headers.origin;
  const host = req.headers.host;

  if (origin && isAllowedOrigin(origin, host)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Workspace, Cookie, X-Requested-With, Cache-Control, Accept"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
  }

  res.setHeader("Vary", "Origin");

  // Handle preflight OPTIONS
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
}
