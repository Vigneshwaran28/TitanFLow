// Builds Knex instances for SQLite, PostgreSQL, MySQL, or MariaDB from a saved config. The platform database holds
// the provider's data and every tenant without a database of its own; getDb() returns the database of the current
// request or job (db/context.js), which is the platform database unless a dedicated tenant database applies.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import knexFactory from "knex";
import { SERVER_ROOT } from "../config/store.js";
import { currentDatabase } from "./context.js";
import { familyOf } from "./dialects.js";
import { migrationSource } from "./migrations.js";
import { NodeSqliteClient } from "./nodeSqliteClient.js";

/** @type {import("knex").Knex | null} */
let db = null;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const requireDriver = createRequire(import.meta.url);

// Connection probes fail on purpose while the user tries settings; keep the console clean.
const quietLog = { warn() {}, error() {}, deprecate() {}, debug() {} };
const probeConfig = (config, options) => ({ ...buildKnexConfig(config, options), log: quietLog });

/** An absolute path for a SQLite file named relative to the server folder (its folder is created). */
export function sqlitePath(filename) {
  const file = path.resolve(SERVER_ROOT, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/**
 * @param {import("../config/store.js").DatabaseConfig} config
 * @param {{ databaseOverride?: string | null, pool?: { min: number, max: number } }} [options]
 * @returns {import("knex").Knex.Config}
 */
export function buildKnexConfig(config, { databaseOverride, pool } = {}) {
  if (config.client === "sqlite") {
    return {
      client: NodeSqliteClient,
      connection: { filename: sqlitePath(config.filename) },
      useNullAsDefault: true,
      pool: {
        afterCreate(conn, done) {
          conn.exec("PRAGMA foreign_keys = ON");
          conn.exec("PRAGMA journal_mode = WAL");
          conn.exec("PRAGMA busy_timeout = 5000");
          done();
        },
      },
    };
  }

  if (config.client === "mysql" || config.client === "mariadb") {
    return {
      client: "mysql2",
      connection: {
        host: config.host,
        port: Number(config.port),
        // null: connect to the server only (to create the database)
        database: databaseOverride === null ? undefined : (databaseOverride ?? config.database),
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 8000,
        charset: "utf8mb4",
        // Sums and averages come back as numbers, like on the other databases.
        supportBigNumbers: true,
        decimalNumbers: true,
      },
      pool: pool ?? { min: 0, max: 10 },
    };
  }

  const connectionString = config.connectionString || (config.client === "postgres" ? process.env.DATABASE_URL : null);
  if (connectionString) {
    return {
      client: "pg",
      connection: {
        connectionString,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
      },
      pool: pool ?? { min: 0, max: 10 },
    };
  }

  return {
    client: "pg",
    connection: {
      host: config.host,
      port: Number(config.port),
      database: databaseOverride ?? config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000,
    },
    pool: pool ?? { min: 0, max: 10 },
  };
}

/** Refuses an engine whose driver isn't installed, with the command that installs it. */
export function assertDriver(config) {
  if (config.client !== "mysql" && config.client !== "mariadb") return;
  try {
    requireDriver.resolve("mysql2");
  } catch {
    throw Object.assign(new Error("The MySQL / MariaDB driver isn't installed on the server. Run: npm install mysql2 --prefix server"), { code: "DRIVER_MISSING" });
  }
}

/** A new Knex instance for a config (the caller destroys it). */
export function createKnex(config, options) {
  assertDriver(config);
  return knexFactory(buildKnexConfig(config, options));
}

/**
 * Verifies the connection. For PostgreSQL, MySQL, and MariaDB, optionally creates the database when it doesn't exist.
 * @param {import("../config/store.js").DatabaseConfig} config
 * @param {{ createDatabase?: boolean }} [options]
 * @returns {Promise<{ ok: true, version: string, createdDatabase: boolean }>}
 */
export async function testConnection(config, { createDatabase = false } = {}) {
  assertDriver(config);
  let createdDatabase = false;
  let probe = knexFactory(probeConfig(config));
  try {
    const version = await readVersion(probe, config.client);
    return { ok: true, version, createdDatabase };
  } catch (error) {
    await probe.destroy();
    probe = null;

    const mysql = config.client === "mysql" || config.client === "mariadb";
    const missingDatabase = (config.client === "postgres" && error.code === "3D000") || (mysql && error.code === "ER_BAD_DB_ERROR");
    if (!missingDatabase || !createDatabase) throw error;
    if (!IDENTIFIER.test(config.database)) {
      throw Object.assign(new Error("Database name may only contain letters, numbers, underscores, and dashes."), { code: "INVALID_DB_NAME" });
    }

    const admin = knexFactory(probeConfig(config, { databaseOverride: mysql ? null : "postgres" }));
    try {
      if (mysql) await admin.raw("CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", [config.database]);
      else await admin.raw(`CREATE DATABASE "${config.database}"`);
      createdDatabase = true;
    } finally {
      await admin.destroy();
    }

    const retry = knexFactory(probeConfig(config));
    try {
      const version = await readVersion(retry, config.client);
      return { ok: true, version, createdDatabase };
    } finally {
      await retry.destroy();
    }
  } finally {
    if (probe) await probe.destroy();
  }
}

/** "SQLite 3.50.4", "PostgreSQL 16.3", "MySQL 8.4.2", "MariaDB 11.4.2". */
export async function readVersion(knex, client) {
  if (client === "sqlite") {
    const row = await knex.raw("select sqlite_version() as version");
    return `SQLite ${row[0]?.version ?? ""}`.trim();
  }
  if (client === "mysql" || client === "mariadb") {
    const [rows] = await knex.raw("select version() as version");
    const version = String(rows[0]?.version ?? "");
    return version.toLowerCase().includes("mariadb") ? `MariaDB ${version.split("-")[0]}` : `MySQL ${version.split("-")[0]}`;
  }
  const result = await knex.raw("select version() as version");
  return String(result.rows[0]?.version ?? "PostgreSQL").split(",")[0];
}

/** Opens the platform database and brings its schema up to date. */
export async function initDb(config) {
  if (db) await db.destroy();
  db = createKnex(config);
  // MySQL / MariaDB start from the schema catalog (the migrations were written for SQLite and PostgreSQL); later
  // migrations then run on top as usual.
  if (familyOf(db) === "mysql" && !(await db.schema.hasTable("knex_migrations"))) {
    const { bootstrapSchema } = await import("./schemaCatalog.js");
    await bootstrapSchema(db);
  }
  await db.migrate.latest({ migrationSource });
  return db;
}

/** The database of the current request or job: a dedicated tenant database, or the platform database. */
export function getDb() {
  const current = currentDatabase();
  if (current) return current.db;
  return getPlatformDb();
}

/** The platform database: the tenant registry, the console's audit log, broadcasts, and platform settings. */
export function getPlatformDb() {
  if (!db) throw new Error("Database is not initialized. Complete setup first.");
  return db;
}

export const isDbReady = () => Boolean(db);

export async function closeDb() {
  if (db) await db.destroy();
  db = null;
}

/**
 * Insert a row and return its numeric id on every dialect (MySQL has no RETURNING: it answers the new id).
 * @param {import("knex").Knex | import("knex").Knex.Transaction} knex
 * @param {string} table
 * @param {Object} data
 */
export async function insertAndGetId(knex, table, data) {
  if (familyOf(knex) === "mysql") {
    const [id] = await knex(table).insert(data);
    return Number(id);
  }
  const [row] = await knex(table).insert(data).returning("id");
  return typeof row === "object" ? row.id : row;
}
