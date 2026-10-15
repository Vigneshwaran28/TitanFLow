// The database engines TaskFlow runs on, their connection settings (validated the same way in the setup wizard, the
// console's platform database switch, and a tenant's dedicated database), and the few SQL fragments that differ.
import { z } from "zod";

/**
 * client: the key stored in config; driver: the knex client; family: which SQL dialect the queries are written for.
 * MySQL and MariaDB share the mysql2 driver.
 */
export const ENGINES = Object.freeze({
  sqlite: { label: "SQLite", family: "sqlite", driver: "node:sqlite", defaultPort: null, note: "A file on this server. No database server needed; best for one machine." },
  postgres: { label: "PostgreSQL", family: "postgres", driver: "pg", defaultPort: 5432, note: "PostgreSQL 12 or newer (also Amazon RDS, Azure, Supabase, Neon)." },
  mysql: { label: "MySQL", family: "mysql", driver: "mysql2", defaultPort: 3306, note: "MySQL 8.0.16 or newer (also Amazon RDS / Aurora, Azure, PlanetScale)." },
  mariadb: { label: "MariaDB", family: "mysql", driver: "mysql2", defaultPort: 3306, note: "MariaDB 10.5 or newer." },
});

export const ENGINE_KEYS = Object.freeze(Object.keys(ENGINES));

const sqliteSchema = z.object({
  client: z.literal("sqlite"),
  filename: z
    .string()
    .trim()
    .min(1, "File name is required.")
    .regex(/^[\w./-]+\.(db|sqlite|sqlite3)$/, "Use a relative path ending in .db, .sqlite, or .sqlite3.")
    .refine(value => !value.includes("..") && !value.startsWith("/"), "The path must stay inside the server folder."),
});

const serverFields = {
  host: z.string().trim().min(1, "Host is required.").max(255),
  port: z.coerce.number().int().min(1, "Invalid port.").max(65535, "Invalid port."),
  database: z
    .string()
    .trim()
    .min(1, "Database name is required.")
    .max(63, "Use at most 63 characters.")
    .regex(/^[A-Za-z_][A-Za-z0-9_$-]*$/, "Use letters, numbers, underscores, and dashes."),
  user: z.string().trim().min(1, "User is required.").max(120),
  password: z.string().max(500).default(""),
  ssl: z.boolean().default(false),
};

export const databaseSchema = z.discriminatedUnion("client", [
  sqliteSchema,
  z.object({ client: z.literal("postgres"), ...serverFields }),
  z.object({ client: z.literal("mysql"), ...serverFields }),
  z.object({ client: z.literal("mariadb"), ...serverFields }),
]);

/** The SQL family of a live knex instance: "sqlite", "postgres", or "mysql". */
export function familyOf(knex) {
  const dialect = knex?.client?.dialect ?? knex?.client?.config?.client;
  if (dialect === "sqlite3" || dialect === "better-sqlite3") return "sqlite";
  if (dialect === "mysql" || dialect === "mysql2") return "mysql";
  return "postgres";
}

/** " escape '\\'" for LIKE patterns escaped with a backslash; MySQL uses the backslash already (and can't parse '\'). */
export const likeEscape = knex => (familyOf(knex) === "mysql" ? "" : " escape '\\'");

/** SQL that concatenates the given SQL expressions (|| on SQLite and PostgreSQL, concat() on MySQL). */
export function concatSql(knex, ...parts) {
  return familyOf(knex) === "mysql" ? `concat(${parts.join(", ")})` : parts.join(" || ");
}

/** A config with the password left out, for the console (the password is never sent back). */
export function publicDatabaseConfig(config) {
  if (!config) return null;
  if (config.client === "sqlite") return { client: "sqlite", label: ENGINES.sqlite.label, filename: config.filename };
  return { client: config.client, label: ENGINES[config.client]?.label ?? config.client, host: config.host, port: Number(config.port), database: config.database, user: config.user, ssl: Boolean(config.ssl), hasPassword: Boolean(config.password) };
}

/** "SQLite (data/acme.db)" or "MySQL acme@db.example.com:3306". */
export function describeDatabase(config) {
  if (!config) return "Platform database";
  if (config.client === "sqlite") return `SQLite (${config.filename})`;
  return `${ENGINES[config.client]?.label ?? config.client} ${config.database}@${config.host}:${config.port}`;
}

/** Driver errors in words a person setting up a database can act on. */
export function describeConnectionError(error) {
  const byCode = {
    ECONNREFUSED: "Could not reach the server. Check the host and port, and that the database server is running.",
    ENOTFOUND: "Host not found. Check the host name.",
    ETIMEDOUT: "Connection timed out. Check the host, port, and firewall.",
    "28P01": "Authentication failed. Check the user name and password.",
    "28000": "This user is not allowed to connect. Check pg_hba.conf or the user's permissions.",
    "3D000": "The database does not exist. Tick \"Create the database if it doesn't exist\" or create it first.",
    "42501": "This user cannot create databases. Create it first, or use a user with CREATEDB.",
    ER_ACCESS_DENIED_ERROR: "Authentication failed. Check the user name and password.",
    ER_DBACCESS_DENIED_ERROR: "This user may not use that database. Grant it access, or use another user.",
    ER_BAD_DB_ERROR: "The database does not exist. Tick \"Create the database if it doesn't exist\" or create it first.",
    ER_NOT_SUPPORTED_AUTH_MODE: "The server asks for an authentication method the driver doesn't support. Use caching_sha2_password or mysql_native_password.",
    HANDSHAKE_SSL_ERROR: "The secure (SSL) connection failed. Check the SSL setting.",
    DRIVER_MISSING: error.message,
    INVALID_DB_NAME: error.message,
    NOT_EMPTY: error.message,
  };
  return byCode[error.code] ?? `Connection failed: ${error.message}`;
}
