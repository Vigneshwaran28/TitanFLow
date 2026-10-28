import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DATA_DIR = path.join(SERVER_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

let runtimeSecret = null;

/**
 * Returns a cryptographically secure JWT secret.
 * Prioritizes JWT_SECRET env var; generates an ephemeral 48-byte random secret if missing.
 */
function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!runtimeSecret) {
    runtimeSecret = crypto.randomBytes(48).toString("hex");
    if (process.env.NODE_ENV === "production") {
      console.warn("[security] WARNING: JWT_SECRET is not configured in environment. Generated an ephemeral secret for this session.");
    }
  }
  return runtimeSecret;
}

/**
 * @typedef {Object} SqliteConfig
 * @property {"sqlite"} client
 * @property {string} filename - Relative to the server folder, e.g. "data/taskflow.db"
 */

/**
 * @typedef {Object} PostgresConfig
 * @property {"postgres"} client
 * @property {string} host
 * @property {number} port
 * @property {string} database
 * @property {string} user
 * @property {string} password
 * @property {boolean} ssl
 */

/** @typedef {SqliteConfig | PostgresConfig} DatabaseConfig */

/**
 * @typedef {Object} AppConfig
 * @property {DatabaseConfig} database
 * @property {string} jwtSecret
 * @property {string} configuredAt
 */

/** @returns {AppConfig | null} */
export function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (process.env.DATABASE_URL) {
      return {
        database: {
          client: "postgres",
          connectionString: process.env.DATABASE_URL,
          ssl: true,
        },
        jwtSecret: getJwtSecret(),
        configuredAt: new Date().toISOString(),
      };
    }
    return null;
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (process.env.DATABASE_URL) {
    config.database = {
      client: "postgres",
      connectionString: process.env.DATABASE_URL,
      ssl: true,
    };
  }
  return config;
}

/** @param {AppConfig} config */
export function writeConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function deleteConfig() {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

export function isConfigured() {
  return readConfig() !== null;
}
