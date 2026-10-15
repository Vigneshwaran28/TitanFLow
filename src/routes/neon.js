import express from "express";
import { getPlatformDb, isDbReady } from "../db/connection.js";
import { getNeonAuthConfig, testAuthConnection } from "../services/neonAuth.js";
import {
  DEFAULT_BUCKET,
  getStorageClient,
  isStorageConfigured,
  listAssets,
  testStorageConnection,
  uploadAsset,
} from "../services/neonStorage.js";

const router = express.Router();

/**
 * GET /api/neon/status
 * Check status and connectivity for all 3 Neon services
 */
router.get("/status", async (req, res) => {
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
 * Verify file upload to Neon Object Storage
 */
router.post("/storage/test-upload", async (req, res) => {
  try {
    const key = `test/upload-${Date.now()}.txt`;
    const body = req.body?.text || "Test upload to Neon Object Storage";
    const uploaded = await uploadAsset(key, body, "text/plain");
    res.json({ ok: true, uploaded });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/neon/storage/assets
 * List assets in the Neon Object Storage bucket
 */
router.get("/storage/assets", async (req, res) => {
  try {
    const items = await listAssets();
    res.json({ ok: true, bucket: DEFAULT_BUCKET, items });
  } catch (error) {
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
