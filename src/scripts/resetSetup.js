// Removes data/config.json so the setup wizard runs again (e.g. to switch between SQLite and PostgreSQL).
// Existing data is NOT deleted or migrated: the old SQLite file / PostgreSQL database stays where it is.
import { deleteConfig, readConfig } from "../config/store.js";

const config = readConfig();
if (!config) {
  console.log("Nothing to reset: setup has not been completed.");
} else {
  deleteConfig();
  console.log(`Setup reset. Previous database (${config.database.client}) was left untouched.`);
  console.log("Restart the server and open the app to run the setup wizard again.");
}
