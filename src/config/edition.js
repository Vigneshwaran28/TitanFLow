// The edition this server runs as. Normally the multi-tenant platform. A tenant exported from the provider console
// as a standalone app ships a server/edition.json: then this server is a single-tenant install of that one workspace,
// with the provider console switched off, the licensed modules fixed, and a setup wizard that imports the exported data.
// Without the file nothing changes. TASKFLOW_EDITION_FILE points elsewhere (tests, Docker).
import fs from "node:fs";
import path from "node:path";
import { SERVER_ROOT } from "./store.js";

/**
 * @typedef {Object} StandaloneEdition
 * @property {"standalone"} mode
 * @property {string} slug - the workspace address (/<slug>)
 * @property {string} name
 * @property {string[]} features - licensed modules, fixed
 * @property {string} industry
 * @property {string} exportedAt
 * @property {string} sourceVersion
 * @property {string} schemaVersion - latest migration of the exporting server
 * @property {string} dataFile - the export to import, relative to the server folder
 */

const EDITION_FILE = process.env.TASKFLOW_EDITION_FILE ? path.resolve(SERVER_ROOT, process.env.TASKFLOW_EDITION_FILE) : path.join(SERVER_ROOT, "edition.json");

/** @type {StandaloneEdition | null | undefined} */
let cached;

/** The standalone edition, or null on the normal platform. Read once per process. */
export function getEdition() {
  if (cached !== undefined) return cached;
  cached = null;
  if (!fs.existsSync(EDITION_FILE)) return cached;
  const data = JSON.parse(fs.readFileSync(EDITION_FILE, "utf8"));
  if (data?.mode !== "standalone" || typeof data.slug !== "string" || !Array.isArray(data.features)) {
    throw new Error(`${EDITION_FILE} is not a valid standalone edition file.`);
  }
  cached = Object.freeze({ ...data, features: Object.freeze([...data.features]) });
  return cached;
}

export const isStandalone = () => getEdition() !== null;

/** Where the exported tenant data lives (TASKFLOW_IMPORT_FILE overrides). */
export function importFilePath() {
  const edition = getEdition();
  const file = process.env.TASKFLOW_IMPORT_FILE || edition?.dataFile || "../data/tenant-export.json";
  return path.resolve(SERVER_ROOT, file);
}

/** What the web app needs to know (GET /api/setup/status). */
export function publicEdition() {
  const edition = getEdition();
  return edition ? { mode: edition.mode, slug: edition.slug, name: edition.name, features: edition.features, industry: edition.industry ?? "custom" } : null;
}
