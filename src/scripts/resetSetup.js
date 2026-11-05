// Removes data/config.json so the setup wizard runs again (e.g. to switch between SQLite and PostgreSQL).
// Existing data is NOT deleted or migrated: the old SQLite file / PostgreSQL database stays where it is.
import { pathToFileURL } from "node:url";
import { deleteConfig, readConfig } from "../config/store.js";

export function resetSetup() {
  const config = readConfig();
  if (!config) {
    console.log("Nothing to reset: setup has not been completed.");
  } else {
    deleteConfig();
    console.log(`Setup reset. Previous database (${config.database?.client || "unknown"}) was left untouched.`);
    console.log("Restart the server and open the app to run the setup wizard again.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetSetup();
}
