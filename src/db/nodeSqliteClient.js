// Knex client backed by Node's built-in `node:sqlite`, so SQLite needs no native addon
// (no prebuilt download, no Python / Visual Studio build tools).
import { DatabaseSync } from "node:sqlite";
import Client_BetterSQLite3 from "knex/lib/dialects/better-sqlite3/index.js";

export class NodeSqliteClient extends Client_BetterSQLite3 {
  _driver() {
    return DatabaseSync;
  }

  async acquireRawConnection() {
    const options = this.connectionSettings.options || {};
    return new DatabaseSync(this.connectionSettings.filename, { readOnly: !!options.readonly });
  }

  async destroyRawConnection(connection) {
    connection.close();
  }

  async _query(connection, obj) {
    if (!obj.sql) throw new Error("The query is empty");
    if (!connection) throw new Error("No connection provided");

    const statement = connection.prepare(obj.sql);
    const bindings = this._formatBindings(obj.bindings);

    // Statements that return columns (SELECT, PRAGMA, ... RETURNING) are read with all().
    if (statement.columns().length > 0) {
      obj.response = statement.all(...bindings).map((row) => ({ ...row }));
      return obj;
    }

    const response = statement.run(...bindings);
    obj.response = response;
    obj.context = { lastID: response.lastInsertRowid, changes: response.changes };
    return obj;
  }
}

Object.assign(NodeSqliteClient.prototype, { driverName: "node:sqlite" });
