// First-run wizard API: choose SQLite or PostgreSQL, test it, and create the provider console account.
// No workspace is created here: the provider signs in to the console (/bunny) and creates each tenant there.
// Standalone edition (config/edition.js): no console account; the wizard imports the exported workspace instead.
import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { getEdition, importFilePath, publicEdition } from "../config/edition.js";
import { isConfigured, readConfig, writeConfig } from "../config/store.js";
import { closeDb, initDb, testConnection } from "../db/connection.js";
import { databaseSchema, describeConnectionError } from "../db/dialects.js";
import { importTenantData, isEmptyDatabase } from "../services/tenantData.js";
import { startConsoleSession } from "./admin.js";
import { startBroadcastScheduler } from "../services/broadcasts.js";
import { startCelebrationScheduler } from "../services/celebrations.js";
import { startReminderScheduler } from "../services/reminderScheduler.js";
import { HttpError, nowIso, validate } from "../utils/http.js";

const router = Router();

// SQLite, PostgreSQL, MySQL, or MariaDB (db/dialects.js).

/** The provider console's sign-in (stored in data/config.json with the password hashed). */
const consoleSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Use at least 3 characters.")
    .max(60, "Use at most 60 characters.")
    .regex(/^[\w.@+-]+$/, "Use letters, numbers, and . _ @ + - only."),
  password: z.string().min(10, "Use at least 10 characters.").max(128),
});

function assertNotConfigured() {
  if (isConfigured()) throw new HttpError(409, "Setup has already been completed.", { code: "ALREADY_CONFIGURED" });
}

router.get("/status", (req, res) => {
  const config = readConfig();
  res.json({ configured: Boolean(config), client: config?.database.client ?? null, edition: publicEdition() });
});

/** Standalone edition: the export the wizard will import (null on the platform). */
function readImportFile() {
  const file = importFilePath();
  if (!fs.existsSync(file)) throw new HttpError(500, `The data file to import is missing (${file}). Copy data/tenant-export.json from the export next to the server folder.`, { code: "IMPORT_FILE_MISSING" });
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HttpError(500, "The data file to import can't be read. Use the data/tenant-export.json that came with the export.", { code: "IMPORT_INVALID" });
  }
}

/** Standalone edition: what the wizard is about to import (workspace, counts). */
router.get("/import-summary", (req, res) => {
  assertNotConfigured();
  const edition = getEdition();
  if (!edition) throw new HttpError(404, "Not found.");
  const document = readImportFile();
  const counts = document.counts ?? {};
  res.json({
    workspace: { slug: edition.slug, name: edition.name },
    features: edition.features,
    exportedAt: document.exportedAt ?? edition.exportedAt,
    users: Number(counts.users ?? 0),
    rows: Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0),
  });
});

/** Set while an import runs, so a second click can't start another one. */
let importing = false;

/** Standalone edition: create the schema, import the workspace, and save the setup. */
async function completeStandalone(req, res, database) {
  if (importing) throw new HttpError(409, "The import is already running. Wait a moment, then reload the page.", { code: "IMPORT_RUNNING" });
  importing = true;
  try {
    await runStandaloneImport(req, res, database);
  } finally {
    importing = false;
  }
}

async function runStandaloneImport(req, res, database) {
  const edition = getEdition();
  const document = readImportFile();
  if (document.tenant?.slug && document.tenant.slug !== edition.slug) {
    throw new HttpError(422, "The data file belongs to another workspace than this app. Use the files from the same export.", { code: "IMPORT_MISMATCH" });
  }
  try {
    await testConnection(database, { createDatabase: Boolean(req.body?.createDatabase) });
  } catch (error) {
    throw new HttpError(400, describeConnectionError(error), { code: "CONNECTION_FAILED" });
  }

  const db = await initDb(database);
  let imported;
  try {
    if (!(await isEmptyDatabase(db))) {
      throw new HttpError(409, "This database already contains TaskFlow data, so nothing was imported. Choose a new SQLite file name or an empty PostgreSQL database.", { code: "DATABASE_NOT_EMPTY" });
    }
    const now = nowIso();
    imported = await importTenantData(db, document, {
      // A self-hosted workspace: always active, never expires, no provider maintenance, licensed as the edition says.
      adjustTenant: row => ({
        ...row,
        slug: edition.slug,
        status: "active",
        features: JSON.stringify(edition.features),
        ...("industry" in row ? { industry: edition.industry ?? row.industry ?? null } : {}),
        ...("deleted_at" in row ? { deleted_at: null, deleted_by: null } : {}),
        ...("subscription_ends_on" in row ? { subscription_ends_on: null, plan: "Self-hosted" } : {}),
        ...("maintenance" in row ? { maintenance: null } : {}),
        updated_at: now,
      }),
    });
  } catch (error) {
    await closeDb(); // not configured: the next attempt starts over
    if (error instanceof HttpError) throw error;
    if (error?.code === "DATABASE_NOT_EMPTY") throw new HttpError(409, error.message, { code: error.code });
    if (String(error?.code ?? "").startsWith("IMPORT_")) throw new HttpError(422, error.message, { code: error.code });
    console.error("[setup] import failed:", error);
    throw new HttpError(500, `The import failed and nothing was saved: ${error.message}`, { code: "IMPORT_FAILED" });
  }

  writeConfig({ database, jwtSecret: crypto.randomBytes(48).toString("hex"), configuredAt: nowIso(), edition: { slug: edition.slug, importedAt: nowIso() } });
  startReminderScheduler();
  startCelebrationScheduler();
  startBroadcastScheduler();
  const users = imported.users ?? 0;
  res.status(201).json({ configured: true, tenants: 1, imported, users, workspace: { slug: edition.slug, name: edition.name }, next: `/${edition.slug}/login` });
}

router.post("/test-connection", async (req, res) => {
  assertNotConfigured();
  const database = validate(databaseSchema, req.body?.database);
  try {
    const result = await testConnection(database, { createDatabase: Boolean(req.body?.createDatabase) });
    res.json(result);
  } catch (error) {
    throw new HttpError(400, describeConnectionError(error), { code: "CONNECTION_FAILED" });
  }
});

router.post("/complete", async (req, res) => {
  assertNotConfigured();
  const database = validate(databaseSchema, req.body?.database);
  if (getEdition()) return completeStandalone(req, res, database);
  const account = validate(consoleSchema, req.body?.console);

  try {
    await testConnection(database, { createDatabase: Boolean(req.body?.createDatabase) });
  } catch (error) {
    throw new HttpError(400, describeConnectionError(error), { code: "CONNECTION_FAILED" });
  }

  // Creates or upgrades the schema. An existing database keeps its tenants; a new one starts empty.
  const db = await initDb(database);
  const [{ count }] = await db("tenants").whereNull("deleted_at").count({ count: "*" });

  writeConfig({
    database,
    jwtSecret: crypto.randomBytes(48).toString("hex"),
    console: { username: account.username, passwordHash: await bcrypt.hash(account.password, 12) },
    configuredAt: nowIso(),
  });
  startReminderScheduler();
  startCelebrationScheduler();
  startBroadcastScheduler();
  startConsoleSession(res, account.username); // straight into the console to create the first tenant
  res.status(201).json({ configured: true, tenants: Number(count) });
});

export default router;
