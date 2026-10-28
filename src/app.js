import path from "node:path";
import fs from "node:fs";
import compression from "compression";
import cookieParser from "cookie-parser";
import express from "express";
import { SERVER_ROOT } from "./config/store.js";
import { requireAuth, requireFeature, requirePermission } from "./middleware/auth.js";
import { errorHandler, notFound, requireSetup } from "./middleware/errors.js";
import {
  adminRateLimiter,
  authRateLimiter,
  globalRateLimiter,
  publicRateLimiter,
  setupRateLimiter,
} from "./middleware/rateLimit.js";
import { corsHandler, securityHeaders } from "./middleware/security.js";
import { tenantDatabaseContext } from "./middleware/tenantDatabase.js";
import accessRulesRouter from "./routes/accessRules.js";
import adminRouter from "./routes/admin.js";
import announcementsRouter from "./routes/announcements.js";
import attendanceRouter from "./routes/attendance.js";
import authRouter from "./routes/auth.js";
import billingRouter from "./routes/billing.js";
import broadcastsRouter from "./routes/broadcasts.js";
import clinicRouter from "./routes/clinic.js";
import { notificationsRouter, statsRouter } from "./routes/dashboard.js";
import expensesRouter from "./routes/expenses.js";
import holidaysRouter from "./routes/holidays.js";
import inventoryRouter from "./routes/inventory.js";
import listsRouter from "./routes/lists.js";
import logisticsRouter from "./routes/logistics.js";
import messagesRouter from "./routes/messages.js";
import notesRouter from "./routes/notes.js";
import peopleRouter from "./routes/people.js";
import patientPortalRouter from "./routes/patientPortal.js";
import publicQueueRouter from "./routes/publicQueue.js";
import publicStatusRouter from "./routes/publicStatus.js";
import publicTrackingRouter from "./routes/publicTracking.js";
import publicWorkspaceRouter from "./routes/publicWorkspace.js";
import rolesRouter from "./routes/roles.js";
import salesRouter from "./routes/sales.js";
import setupRouter from "./routes/setup.js";
import neonRouter from "./routes/neon.js";
import tasksRouter from "./routes/tasks.js";
import tenantAuditRouter from "./routes/tenantAudit.js";
import meetingsRouter from "./routes/meetings.js";
import teamsRouter from "./routes/teams.js";
import ticketsRouter from "./routes/tickets.js";
import usersRouter from "./routes/users.js";
import workspaceRouter from "./routes/workspace.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(corsHandler);
  // gzip JSON and CSV answers (settings-heavy responses shrink several times); ZIP downloads are already compressed.
  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Global API rate limiter
  app.use("/api", globalRateLimiter);

  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.use("/api/neon", neonRouter);
  app.use("/api/setup", setupRateLimiter, setupRouter);

  app.use("/api", requireSetup);
  // Tenants with a database of their own: the rest of the request runs against it (middleware/tenantDatabase.js).
  app.use("/api", tenantDatabaseContext);
  app.use("/api/public/status", publicRateLimiter, publicStatusRouter); // maintenance windows, for the maintenance page
  app.use("/api/public/workspaces", publicRateLimiter, publicWorkspaceRouter); // a workspace's sign-in page branding
  app.use("/api/public/queue", publicRateLimiter, publicQueueRouter); // patients follow their clinic token
  app.use("/api/patient", publicRateLimiter, patientPortalRouter); // clinic patient portal: its own sign-in (patient number + PIN), never a staff session
  app.use("/api/public/track", publicRateLimiter, publicTrackingRouter); // no sign-in: customers follow a shipment by its tracking code
  app.use("/api/auth", authRateLimiter, authRouter);
  // The provider console. Its address is deliberately not "/admin" (the obvious first guess).
  app.use("/api/bunny", adminRateLimiter, adminRouter);
  // Two gates per module: the tenant must be licensed for it (FEATURES in services/tenants.js), and the
  // person must hold at least one of its permissions (services/permissions.js). Finer checks live in each router.
  const gate = (feature, ...permissions) => [requireAuth, requireFeature(feature), requirePermission(...permissions)];
  app.use("/api/lists", gate("tasks", "tasks.use"), listsRouter);
  app.use("/api/tasks", gate("tasks", "tasks.use"), tasksRouter);
  app.use("/api/stats", gate("tasks", "tasks.use"), statsRouter);
  app.use("/api/notifications", requireAuth, notificationsRouter);
  app.use("/api/broadcasts", requireAuth, broadcastsRouter); // the provider's announcements and subscription notices
  app.use("/api/tickets", gate("helpdesk", "helpdesk.use", "helpdesk.work"), ticketsRouter);
  app.use(
    "/api/teams",
    requireAuth,
    requireFeature("directory", "helpdesk"),
    requirePermission("directory.view", "directory.teams.manage", "helpdesk.use", "helpdesk.work"), // the help desk's team picker reads teams
    teamsRouter
  );
  app.use("/api/people", requireAuth, peopleRouter); // feeds every module's person pickers
  app.use("/api/users", requireAuth, requirePermission("workspace.users.manage"), usersRouter);
  app.use("/api/roles", requireAuth, rolesRouter);
  app.use("/api/access-rules", requireAuth, accessRulesRouter); // custom access per person, on top of roles
  app.use("/api/audit", requireAuth, requirePermission("workspace.audit.view"), tenantAuditRouter);
  app.use("/api/inventory", gate("inventory", "inventory.view", "inventory.products.edit", "inventory.stock.move", "inventory.products.delete"), inventoryRouter);
  app.use("/api/sales", gate("sales", "sales.view", "sales.edit", "sales.orders.confirm", "sales.delete"), salesRouter);
  app.use("/api/attendance", gate("attendance", "attendance.self", "attendance.team.view", "attendance.leave.approve"), attendanceRouter);
  app.use("/api/holidays", gate("attendance", "attendance.self", "attendance.team.view", "attendance.leave.approve", "attendance.holidays.manage"), holidaysRouter);
  app.use("/api/messages", gate("messaging", "messaging.use", "messaging.groups.create"), messagesRouter);
  // Everyone in a licensed workspace may read the announcements addressed to them (everyone, or their roles);
  // posting and managing are permissions checked inside the router.
  app.use("/api/announcements", requireAuth, requireFeature("announcements"), announcementsRouter);
  app.use("/api/notes", gate("notes", "notes.use", "notes.manage"), notesRouter);
  app.use("/api/expenses", gate("expenses", "expenses.submit", "expenses.approve", "expenses.pay"), expensesRouter);
  app.use("/api/billing", gate("billing", "billing.view", "billing.edit", "billing.issue", "billing.payments.record", "billing.delete"), billingRouter);
  app.use("/api/logistics", gate("logistics", "logistics.view", "logistics.edit", "logistics.dispatch", "logistics.deliver", "logistics.fleet.manage"), logisticsRouter);
  app.use(
    "/api/clinic",
    gate("clinic", "clinic.schedule.view", "clinic.appointments.manage", "clinic.patients.manage", "clinic.practitioner", "clinic.records.view", "clinic.providers.manage", "clinic.vitals.record"),
    clinicRouter
  );
  app.use("/api/meetings", requireAuth, meetingsRouter);
  app.use("/api/workspace", requireAuth, workspaceRouter);
  app.use("/api", notFound);

  // Production: serve the built client and fall back to index.html for client-side routes.
  const clientDist = path.resolve(SERVER_ROOT, "../client/dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(clientDist, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
