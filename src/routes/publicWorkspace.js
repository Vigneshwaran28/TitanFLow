// A workspace's public sign-in branding: GET /api/public/workspaces/:slug (no sign-in).
// Only what the login page shows: never people, data, or settings beyond branding.
import { Router } from "express";
import { getDb } from "../db/connection.js";
import { workspaceMaintenance } from "../services/maintenance.js";
import { customCssProblem, resolveSettings } from "../services/moduleSettings.js";
import { effectiveFeatures } from "../services/tenants.js";
import { HttpError } from "../utils/http.js";

const router = Router();
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

router.get("/:slug", async (req, res) => {
  const slug = String(req.params.slug ?? "").toLowerCase();
  const notFound = new HttpError(404, "We couldn't find that workspace. Check the address with your administrator.", { code: "NOT_FOUND" });
  if (!SLUG.test(slug)) throw notFound;
  const tenant = await getDb()("tenants").where({ slug }).first();
  if (!tenant || tenant.deleted_at) throw notFound; // in the recycle bin: no sign-in page (the slug stays reserved)
  const { branding, company } = resolveSettings(tenant.settings);
  const maintenance = await workspaceMaintenance(getDb(), tenant.maintenance);
  res.set("Cache-Control", "public, max-age=15");
  res.json({
    slug: tenant.slug,
    name: tenant.name,
    active: tenant.status === "active",
    siteTitle: branding.siteTitle || tenant.name,
    tagline: branding.tagline,
    accent: branding.accent,
    logoIcon: branding.logoIcon,
    logoUrl: branding.logoUrl || null,
    login: {
      template: branding.loginTemplate,
      background: branding.loginBackground,
      headline: branding.loginHeadline,
      message: branding.loginMessage,
      highlights: branding.loginHighlights,
      supportContact: branding.supportContact,
      // Sanitized on save; only sent while the workspace has custom CSS switched on (never the app block); re-checked in case of older data.
      ...(branding.customCssEnabled && branding.customCss?.login && !customCssProblem(branding.customCss.login) ? { customCss: branding.customCss.login } : {}),
    },
    // The workspace's look (corners, shadows, type, motion): its sign-in and password pages match the app.
    ui: branding.ui,
    companyName: company.legalName || tenant.name,
    features: effectiveFeatures(tenant.features, resolveSettings(tenant.settings)),
    maintenance, // { active, upcoming }: the sign-in page shows the maintenance notice instead of failing
  });
});

export default router;
