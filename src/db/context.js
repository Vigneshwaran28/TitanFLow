// Which database the current request or job works on. Tenants either share the platform database (the default) or
// have a dedicated one (services/tenantDatabases.js). Middleware and jobs run their work inside runWithDatabase(), and
// getDb() (db/connection.js) returns that database; everything outside a tenant context gets the platform database.
import { AsyncLocalStorage } from "node:async_hooks";

/** The key of the platform database (tenants that have no database of their own). */
export const PLATFORM_KEY = "platform";

/** @typedef {{ key: string, tenantId: number | null, db: import("knex").Knex }} DatabaseEntry */

/** @type {AsyncLocalStorage<DatabaseEntry>} */
const storage = new AsyncLocalStorage();

/**
 * Runs fn with `entry` as the current database (and everything it awaits).
 * @template T
 * @param {DatabaseEntry} entry
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithDatabase(entry, fn) {
  return storage.run(entry, fn);
}

/** The current database entry, or null outside any tenant context (the platform database applies). */
export function currentDatabase() {
  return storage.getStore() ?? null;
}

/** "platform", or "tenant:<id>" for a dedicated tenant database. Live updates use it to keep user ids apart. */
export function currentDbKey() {
  return storage.getStore()?.key ?? PLATFORM_KEY;
}
