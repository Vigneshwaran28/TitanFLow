import { createApp } from "./app.js";
import { getEdition } from "./config/edition.js";
import { readConfig } from "./config/store.js";
import { closeDb, initDb } from "./db/connection.js";
import { startBroadcastScheduler, stopBroadcastScheduler } from "./services/broadcasts.js";
import { startCelebrationScheduler, stopCelebrationScheduler } from "./services/celebrations.js";
import { attachRealtime } from "./services/realtime.js";
import { closeAllTenantPools, syncAllTenantDatabases } from "./services/tenantDatabases.js";
import { startReminderScheduler, stopReminderScheduler } from "./services/reminderScheduler.js";

const PORT = Number(process.env.PORT) || 4000;

async function main() {
  const edition = getEdition(); // throws on a broken server/edition.json, before anything starts
  if (edition) console.log(`[edition] standalone: ${edition.name} (/${edition.slug}), modules fixed: ${edition.features.join(", ")}`);
  const config = readConfig();
  if (config) {
    await initDb(config.database);
    await syncAllTenantDatabases(); // dedicated tenant databases: new tables and columns, tenant mirrors
    startReminderScheduler();
    startCelebrationScheduler();
    startBroadcastScheduler(); // scheduled provider broadcasts, subscription notices
    console.log(`[db] connected (${config.database.client})`);
  } else {
    console.log("[setup] not configured yet: open the app to run the setup wizard");
  }

  const app = createApp();
  const server = app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT} (live updates on /ws)`));
  const realtime = attachRealtime(server);

  let isShuttingDown = false;
  const shutdown = async (signal = "SHUTDOWN") => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[process] ${signal} received: closing resources gracefully...`);
    try {
      realtime.close();
      stopReminderScheduler();
      stopCelebrationScheduler();
      stopBroadcastScheduler();
      server.close();
      await closeAllTenantPools();
      await closeDb();
      console.log("[process] Graceful shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("[process] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[process] Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[process] Uncaught exception:", error);
    void shutdown("UNCAUGHT_EXCEPTION");
  });
}

main().catch(error => {
  console.error("[startup] failed:", error.message);
  process.exit(1);
});
