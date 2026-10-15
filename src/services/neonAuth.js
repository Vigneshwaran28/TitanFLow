import jwt from "jsonwebtoken";

let cachedJwks = null;
let lastJwksFetch = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getNeonAuthConfig() {
  return {
    baseUrl: process.env.NEON_AUTH_BASE_URL || null,
    jwksUrl: process.env.NEON_AUTH_JWKS_URL || null,
    isConfigured: Boolean(process.env.NEON_AUTH_BASE_URL || process.env.NEON_AUTH_JWKS_URL),
  };
}

/**
 * Fetch and cache Neon Auth JWKS keys
 */
export async function fetchNeonJwks() {
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
  if (!jwksUrl) throw new Error("NEON_AUTH_JWKS_URL is not configured.");

  const now = Date.now();
  if (cachedJwks && now - lastJwksFetch < JWKS_CACHE_TTL_MS) {
    return cachedJwks;
  }

  const res = await fetch(jwksUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch Neon JWKS: HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  cachedJwks = data;
  lastJwksFetch = now;
  return data;
}

/**
 * Test Neon Auth endpoint connectivity
 */
export async function testAuthConnection() {
  const config = getNeonAuthConfig();
  if (!config.isConfigured) {
    return { ok: false, error: "Neon Auth is not configured." };
  }

  const jwks = await fetchNeonJwks();
  const keyCount = Array.isArray(jwks.keys) ? jwks.keys.length : 0;

  return {
    ok: true,
    baseUrl: config.baseUrl,
    jwksUrl: config.jwksUrl,
    keysFound: keyCount,
    verifiedAt: new Date().toISOString(),
  };
}
