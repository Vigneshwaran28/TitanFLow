// The schema as data: every table with its columns, keys, foreign keys, and indexes, read from a fresh SQLite database
// built by the migrations (so it can never drift from them). Used to create the tables of a dedicated tenant database
// on any engine (only the tables its modules need), to add tables and columns when a tenant gets more modules or the
// app gets new migrations, and to copy the platform database to another engine.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import knexFactory from "knex";
import { familyOf } from "./dialects.js";
import { migrationSource } from "./migrations.js";
import { NodeSqliteClient } from "./nodeSqliteClient.js";

/**
 * @typedef {Object} CatalogColumn
 * @property {string} name
 * @property {"increments"|"integer"|"bigInteger"|"string"|"text"|"boolean"|"double"|"decimal"} kind
 * @property {number} [length]   string length
 * @property {boolean} nullable
 * @property {string|number|boolean|null} default
 */
/**
 * @typedef {Object} CatalogForeignKey
 * @property {string[]} columns
 * @property {string} table
 * @property {string[]} references
 * @property {string|null} onDelete
 */
/**
 * @typedef {Object} CatalogTable
 * @property {string} name
 * @property {CatalogColumn[]} columns
 * @property {string[]} primary     the primary key columns (an increments column is its own key)
 * @property {CatalogForeignKey[]} foreignKeys
 * @property {{ name: string, columns: string[], unique: boolean }[]} indexes
 */

/** Knex's own bookkeeping, never part of an application schema. */
const INTERNAL = new Set(["knex_migrations", "knex_migrations_lock", "sqlite_sequence"]);

/** @type {Promise<Map<string, CatalogTable>> | null} */
let cached = null;

/** The catalog (built once per process, about a second). */
export function getCatalog() {
  cached ??= buildCatalog().catch(error => {
    cached = null;
    throw error;
  });
  return cached;
}

async function buildCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-schema-"));
  const filename = path.join(dir, "schema.db");
  const knex = knexFactory({ client: NodeSqliteClient, connection: { filename }, useNullAsDefault: true, pool: { min: 1, max: 1 }, log: { warn() {}, error() {}, deprecate() {}, debug() {} } });
  try {
    await knex.raw("PRAGMA foreign_keys = ON");
    await knex.migrate.latest({ migrationSource });
    const names = (await knex.raw("select name, sql from sqlite_master where type = 'table' order by name")).filter(row => !INTERNAL.has(row.name));
    const tables = new Map();
    for (const { name, sql } of names) tables.set(name, await readTable(knex, name, sql));
    return tables;
  } finally {
    await knex.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const quote = name => `"${name.replace(/"/g, '""')}"`;

function parseDefault(raw, kind) {
  if (raw === null || raw === undefined) return null;
  let value = String(raw);
  if (/^'.*'$/s.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
  else if (/^null$/i.test(value)) return null;
  else if (/^current_timestamp$/i.test(value)) return null;
  if (kind === "boolean") return value === "1" || value.toLowerCase() === "true";
  if (kind === "integer" || kind === "bigInteger" || kind === "double" || kind === "decimal") return Number.isFinite(Number(value)) ? Number(value) : null;
  return value;
}

function columnKind(type, isAutoIncrement) {
  const lower = String(type).toLowerCase();
  if (isAutoIncrement) return { kind: "increments" };
  const varchar = lower.match(/^(?:varchar|character varying|nvarchar|char)\s*\((\d+)\)/);
  if (varchar) return { kind: "string", length: Number(varchar[1]) };
  if (lower.startsWith("varchar")) return { kind: "string", length: 255 };
  if (lower === "text" || lower.includes("clob") || lower === "json") return { kind: "text" };
  if (lower === "boolean" || lower === "bool" || lower === "tinyint(1)") return { kind: "boolean" };
  if (lower === "bigint") return { kind: "bigInteger" };
  if (lower.startsWith("int") || lower === "integer") return { kind: "integer" };
  if (lower.startsWith("decimal") || lower.startsWith("numeric")) return { kind: "decimal" };
  if (lower.startsWith("float") || lower.startsWith("real") || lower.startsWith("double")) return { kind: "double" };
  if (lower === "datetime" || lower === "date" || lower === "timestamp") return { kind: "string", length: 30 };
  return { kind: "text" };
}

async function readTable(knex, name, createSql) {
  const info = await knex.raw(`pragma table_info(${quote(name)})`);
  const keys = info.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
  const autoIncrement = keys.length === 1 && /^integer$/i.test(keys[0].type) && /autoincrement/i.test(createSql ?? "") ? keys[0].name : null;
  const columns = info.map(column => {
    const { kind, length } = columnKind(column.type, column.name === autoIncrement);
    return { name: column.name, kind, ...(length ? { length } : {}), nullable: !column.notnull && column.pk === 0, default: column.name === autoIncrement ? null : parseDefault(column.dflt_value, kind) };
  });

  const fkRows = await knex.raw(`pragma foreign_key_list(${quote(name)})`);
  const byId = new Map();
  for (const row of fkRows) {
    if (!byId.has(row.id)) byId.set(row.id, { columns: [], table: row.table, references: [], onDelete: row.on_delete && row.on_delete !== "NO ACTION" ? row.on_delete : null });
    const fk = byId.get(row.id);
    fk.columns[row.seq] = row.from;
    fk.references[row.seq] = row.to ?? "id";
  }

  const indexes = [];
  for (const index of await knex.raw(`pragma index_list(${quote(name)})`)) {
    if (index.origin === "pk") continue;
    const cols = (await knex.raw(`pragma index_info(${quote(index.name)})`)).sort((a, b) => a.seqno - b.seqno).map(row => row.name);
    if (!cols.length || cols.some(column => !column)) continue;
    indexes.push({ name: index.name.startsWith("sqlite_autoindex") ? `${name}_${cols.join("_")}_unique` : index.name, columns: cols, unique: Boolean(index.unique) });
  }

  return { name, columns, primary: keys.map(column => column.name), foreignKeys: [...byId.values()], indexes };
}

// ---- Creating tables on any engine ----

/** Index and constraint names stay under the 63/64-character limits of PostgreSQL and MySQL. */
function shortName(name) {
  if (name.length <= 60) return name;
  return `${name.slice(0, 51)}_${crypto.createHash("sha1").update(name).digest("hex").slice(0, 8)}`;
}

/** MySQL's 65,535-byte row limit (utf8mb4: 4 bytes a character): long unindexed strings become TEXT. */
function mysqlTextColumns(table) {
  const indexed = new Set(table.indexes.flatMap(index => index.columns).concat(table.primary, table.foreignKeys.flatMap(fk => fk.columns)));
  const long = table.columns.filter(column => column.kind === "string" && column.length > 255 && !indexed.has(column.name));
  const bytes = table.columns.reduce((sum, column) => sum + (column.kind === "string" ? column.length * 4 + 2 : 12), 0);
  // Under the limit with room to spare: keep them (they stay varchar, like the other engines).
  return bytes < 60_000 ? new Set() : new Set(long.map(column => column.name));
}

/**
 * Creates one table from the catalog. Foreign keys to tables outside `present` are left out (the module that owns
 * the other table isn't licensed); addForeignKeys() adds them later, when it is.
 * @param {import("knex").Knex} knex
 * @param {CatalogTable} table
 * @param {Set<string>} present tables that exist (or are being created) in this database
 */
export function createTable(knex, table, present) {
  const family = familyOf(knex);
  const asText = family === "mysql" ? mysqlTextColumns(table) : new Set();
  const fkColumns = new Set(table.foreignKeys.flatMap(fk => fk.columns));
  return knex.schema.createTable(table.name, builder => {
    for (const column of table.columns) defineColumn(builder, column, { family, asText: asText.has(column.name), unsigned: family === "mysql" && fkColumns.has(column.name) });
    const increments = table.columns.some(column => column.kind === "increments");
    if (!increments && table.primary.length) builder.primary(table.primary, shortName(`${table.name}_pkey`));
    for (const fk of table.foreignKeys) {
      if (!present.has(fk.table)) continue;
      const foreign = builder.foreign(fk.columns, shortName(`${table.name}_${fk.columns.join("_")}_foreign`)).references(fk.references).inTable(fk.table);
      if (fk.onDelete) foreign.onDelete(fk.onDelete);
    }
    for (const index of table.indexes) {
      if (family === "mysql" && index.columns.some(name => table.columns.find(column => column.name === name)?.kind === "text")) continue;
      if (index.unique) builder.unique(index.columns, shortName(index.name));
      else builder.index(index.columns, shortName(index.name));
    }
    if (family === "mysql") {
      builder.engine("InnoDB");
      builder.charset("utf8mb4");
      builder.collate("utf8mb4_unicode_ci");
    }
  });
}

function defineColumn(builder, column, { family, asText, unsigned, adding = false }) {
  let col;
  switch (column.kind) {
    case "increments":
      col = builder.increments(column.name).primary();
      return col;
    case "integer":
      col = builder.integer(column.name);
      if (unsigned) col.unsigned();
      break;
    case "bigInteger":
      col = builder.bigInteger(column.name);
      break;
    case "string":
      col = asText ? builder.text(column.name) : builder.string(column.name, column.length ?? 255);
      break;
    case "boolean":
      col = builder.boolean(column.name);
      break;
    case "double":
      col = builder.double(column.name);
      break;
    case "decimal":
      col = builder.decimal(column.name, 14, 4);
      break;
    default:
      col = builder.text(column.name);
  }
  // A column added to a table with rows needs a default (or must allow nulls) to be NOT NULL.
  const notNull = !column.nullable && !(adding && column.default === null);
  if (notNull) col.notNullable();
  else col.nullable();
  const textual = column.kind === "text" || asText;
  if (column.default !== null && column.default !== undefined && !(family === "mysql" && textual)) col.defaultTo(column.default);
  return col;
}

/** Table names in an order where every table comes after the tables it references (cycles are broken arbitrarily). */
export function creationOrder(catalog, names) {
  const wanted = new Set(names);
  const order = [];
  const state = new Map();
  const visit = name => {
    if (state.get(name) === "done" || !wanted.has(name)) return;
    if (state.get(name) === "visiting") return; // a cycle: its foreign key is added afterwards
    state.set(name, "visiting");
    for (const fk of catalog.get(name)?.foreignKeys ?? []) if (fk.table !== name) visit(fk.table);
    state.set(name, "done");
    order.push(name);
  };
  [...wanted].sort().forEach(visit);
  return order;
}

/** The tables of a database (lower-cased names). */
export async function existingTables(knex) {
  const family = familyOf(knex);
  if (family === "sqlite") return new Set((await knex.raw("select name from sqlite_master where type = 'table'")).map(row => row.name));
  if (family === "mysql") {
    const [rows] = await knex.raw("select table_name as name from information_schema.tables where table_schema = database()");
    return new Set(rows.map(row => row.name ?? row.NAME ?? row.TABLE_NAME));
  }
  const result = await knex.raw("select table_name as name from information_schema.tables where table_schema = current_schema()");
  return new Set(result.rows.map(row => row.name));
}

/**
 * Makes a database have (at least) these tables with every catalog column: missing tables are created in dependency
 * order, missing columns are added (additive only: nothing is ever dropped), and foreign keys whose target table now
 * exists are added where the engine allows it. Returns what changed.
 * @param {import("knex").Knex} knex
 * @param {string[]} names
 */
export async function syncTables(knex, names) {
  const catalog = await getCatalog();
  const family = familyOf(knex);
  const known = names.filter(name => catalog.has(name));
  const before = await existingTables(knex);
  const present = new Set([...before, ...known]);
  const created = [];
  const addedColumns = [];
  for (const name of creationOrder(catalog, known)) {
    const table = catalog.get(name);
    if (!before.has(name)) {
      await createTable(knex, table, present);
      created.push(name);
      continue;
    }
    const columns = await knex(name).columnInfo();
    const missing = table.columns.filter(column => !Object.hasOwn(columns, column.name));
    if (missing.length) {
      await knex.schema.alterTable(name, builder => {
        for (const column of missing) defineColumn(builder, column, { family, asText: false, unsigned: false, adding: true });
      });
      addedColumns.push(...missing.map(column => `${name}.${column.name}`));
    }
  }
  // Foreign keys of tables made earlier, whose target only exists now (SQLite can't add them to an existing table).
  if (family !== "sqlite") {
    for (const name of known.filter(item => before.has(item))) {
      for (const fk of catalog.get(name).foreignKeys) {
        if (before.has(fk.table) || !present.has(fk.table)) continue;
        try {
          await knex.schema.alterTable(name, builder => {
            const foreign = builder.foreign(fk.columns, shortName(`${name}_${fk.columns.join("_")}_foreign`)).references(fk.references).inTable(fk.table);
            if (fk.onDelete) foreign.onDelete(fk.onDelete);
          });
        } catch (error) {
          console.warn(`[schema] foreign key ${name}(${fk.columns}) -> ${fk.table} not added: ${error.message}`);
        }
      }
    }
  }
  return { created, addedColumns };
}

/** Knex's migration bookkeeping tables (the same shape knex creates). */
export async function createMigrationTables(knex) {
  if (!(await knex.schema.hasTable("knex_migrations"))) {
    await knex.schema.createTable("knex_migrations", table => {
      table.increments("id").primary();
      table.string("name", 255);
      table.integer("batch");
      table.timestamp("migration_time");
    });
  }
  if (!(await knex.schema.hasTable("knex_migrations_lock"))) {
    await knex.schema.createTable("knex_migrations_lock", table => {
      table.increments("index").primary();
      table.integer("is_locked");
    });
    await knex("knex_migrations_lock").insert({ is_locked: 0 });
  }
}

/**
 * A fresh platform database built from the catalog, with every migration recorded as done. Used on engines the
 * migrations weren't written for (MySQL / MariaDB): the result is the same schema a fresh migrated database has.
 */
export async function bootstrapSchema(knex) {
  const catalog = await getCatalog();
  await syncTables(knex, [...catalog.keys()]);
  await createMigrationTables(knex);
  const now = new Date();
  for (const name of await migrationSource.getMigrations()) await knex("knex_migrations").insert({ name, batch: 1, migration_time: now });
}

/** The catalog as the console shows it: each table's columns and how it links to the others. */
export async function describeTables(names) {
  const catalog = await getCatalog();
  return names
    .filter(name => catalog.has(name))
    .map(name => {
      const table = catalog.get(name);
      return {
        name,
        columns: table.columns.length,
        primary: table.columns.some(column => column.kind === "increments") ? ["id"] : table.primary,
        references: table.foreignKeys.map(fk => ({ columns: fk.columns, table: fk.table, onDelete: fk.onDelete })),
      };
    });
}
