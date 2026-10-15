// Persists setup results (database choice, JWT secret) in data/config.json.
// The file is created by the setup wizard and is git-ignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DATA_DIR = path.join(SERVER_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

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
        jwtSecret: process.env.JWT_SECRET || "cd4d30820f25a5085f6a18947570778327c47b0f125ceb8de7df86daa52691ccb4c43827a9ec2ef20e8c25462efe9008",
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
