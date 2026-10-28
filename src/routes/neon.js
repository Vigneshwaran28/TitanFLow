import express from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { readConfig } from "../config/store.js";
import { getPlatformDb, isDbReady } from "../db/connection.js";
import { loadAccess, loadSession, requestedWorkspace, tenantFromRow } from "../middleware/auth.js";
import { ADMIN_AUDIENCE, ADMIN_COOKIE } from "./admin.js";
import { getNeonAuthConfig, testAuthConnection } from "../services/neonAuth.js";
import {
  DEFAULT_BUCKET,
  getStorageClient,
  isStorageConfigured,
  listAssets,
  testStorageConnection,
  uploadAsset,
} from "../services/neonStorage.js";
import { HttpError, validate } from "../utils/http.js";

const router = express.Router();

/**
 * Ensures only authenticated administrators (console admin or workspace admin/owner)
 * can access internal Neon status, storage upload, and asset listings.
 */
async function requireAdminOrOwner(req, res, next) {
  const adminCookie = req.cookies?.[ADMIN_COOKIE];
  const config = readConfig();
  if (!config) throw new HttpError(503, "Setup is not complete.", { code: "SETUP_REQUIRED" });

  // 1. Try console admin
  if (adminCookie) {
    try {
      jwt.verify(adminCookie, config.jwtSecret, { audience: ADMIN_AUDIENCE });
      return next();
    } catch {
      // not a valid admin token, proceed to check workspace session
    }
  }

  // 2. Try workspace owner or manager session
  try {
    if (isDbReady()) {
      const db = getPlatformDb();
      const session = await loadSession(db, req.cookies, requestedWorkspace(req));
      if (!session.problem && session.row) {
        const access = await loadAccess(db, session.row.id, tenantFromRow(session.row).features);
        if (access.isOwner || access.permissions.includes("workspace.users.manage")) {
          return next();
        }
      }
    }
  } catch {
    // fall through to unauthorized
  }

  throw new HttpError(401, "Administrator access required.", { code: "UNAUTHORIZED" });
}

const testUploadSchema = z.object({
  text: z.string().trim().max(10_000, "Upload text payload must not exceed 10,000 characters.").optional(),
});

/**
 * GET /api/neon/status
 * Check status and connectivity for all 3 Neon services (admin/owner only)
 */
router.get("/status", requireAdminOrOwner, async (req, res) => {
  const result = {
    timestamp: new Date().toISOString(),
    postgres: { ok: false, details: null },
    auth: { ok: false, details: null },
    storage: { ok: false, details: null },
  };

  // 1. Check Neon Postgres
  try {
    if (isDbReady()) {
      const db = getPlatformDb();
      const versionResult = await db.raw("SELECT version() as version, current_database() as db");
      result.postgres = {
        ok: true,
        version: versionResult.rows?.[0]?.version?.split(",")?.[0] || "Connected",
        database: versionResult.rows?.[0]?.db,
      };
    } else {
      result.postgres = { ok: false, error: "Database not initialized" };
    }
  } catch (error) {
    result.postgres = { ok: false, error: error.message };
  }

  // 2. Check Neon Auth
  try {
    const authStatus = await testAuthConnection();
    result.auth = authStatus;
  } catch (error) {
    result.auth = { ok: false, error: error.message };
  }

  // 3. Check Neon Object Storage
  try {
    if (isStorageConfigured()) {
      const storageStatus = await testStorageConnection();
      result.storage = storageStatus;
    } else {
      result.storage = { ok: false, error: "Storage not configured" };
    }
  } catch (error) {
    result.storage = { ok: false, error: error.message };
  }

  res.json(result);
});

/**
 * POST /api/neon/storage/test-upload
 * Verify file upload to Neon Object Storage (admin/owner only)
 */
router.post("/storage/test-upload", requireAdminOrOwner, async (req, res) => {
  try {
    const input = validate(testUploadSchema, req.body ?? {});
    const key = `test/upload-${Date.now()}.txt`;
    const body = input.text || "Test upload to Neon Object Storage";
    const uploaded = await uploadAsset(key, body, "text/plain");
    res.json({ ok: true, uploaded });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/neon/storage/assets
 * List assets in the Neon Object Storage bucket (admin/owner only)
 */
router.get("/storage/assets", requireAdminOrOwner, async (req, res) => {
  try {
    const items = await listAssets();
    res.json({ ok: true, bucket: DEFAULT_BUCKET, items });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/neon/auth/config
 * Public auth configuration for clients
 */
router.get("/auth/config", (req, res) => {
  res.json(getNeonAuthConfig());
});

export default router;
