// Platform status for pages without a session: GET /api/public/status[?workspace=<slug>] (no sign-in).
// The maintenance page polls it to know when to send people back to the app.
import { Router } from "express";
import { getDb } from "../db/connection.js";
import { activeWindow, getGlobalMaintenance, parseMaintenance, upcomingWindow } from "../services/maintenance.js";

const router = Router();
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

router.get("/", async (req, res) => {
  const db = getDb();
  const slug = String(req.query.workspace ?? "").toLowerCase();
  const global = await getGlobalMaintenance(db);
  // An unknown workspace is answered like the platform alone, so this can't be used to find workspaces.
  const tenant = SLUG.test(slug) ? await db("tenants").where({ slug }).whereNull("deleted_at").first("maintenance") : null;
  const window = parseMaintenance(tenant?.maintenance);
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, maintenance: { active: activeWindow(global, window), upcoming: upcomingWindow(global, window) } });
});

export default router;
