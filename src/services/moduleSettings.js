// Per-tenant module settings. Each tenant stores only what it changed; reads merge it over these defaults,
// so new settings appear for existing tenants automatically.
import { z } from "zod";
import { HttpError } from "../utils/http.js";

export const TICKET_CATEGORIES = ["it_support", "access", "hardware", "software", "hr", "facilities", "finance", "other"];
export const LEAVE_TYPES = ["annual", "sick", "casual", "unpaid", "other"];
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // Sunday = 0
export const APPOINTMENT_TYPES = ["consultation", "follow_up", "procedure", "teleconsult", "vaccination", "lab_test", "checkup"];
export const LOGIN_TEMPLATES = ["split", "centered", "banner", "minimal", "corporate"];
export const LOGIN_BACKGROUNDS = ["indigo", "ocean", "sunset", "forest", "midnight", "rose", "plain"];
export const PAYMENT_METHODS =["cash", "card", "bank_transfer", "upi", "cheque", "other"];

export const DEFAULT_SETTINGS = Object.freeze({
  helpdesk: {
    sla: {
      urgent: { response: 1, resolution: 4 },
      high: { response: 4, resolution: 24 },
      medium: { response: 8, resolution: 72 },
      low: { response: 24, resolution: 120 },
    },
    categories: TICKET_CATEGORIES,
  },
  attendance: {
    autoCheckIn: true, // signing in for the day records attendance
    workdayStart: "09:30",
    lateAfterMinutes: 15,
    workingDays: [1, 2, 3, 4, 5],
    halfDayLeave: true,
    leaveTypes: LEAVE_TYPES,
    annualAllowance: 18, // days of annual leave per calendar year
    saturdaysOff: [], // when Saturday is a working day: which Saturdays of the month are off, e.g. [2, 4]
    optionalHolidayQuota: 2, // optional holidays each person may pick per year
  },
  inventory: {
    units: ["pcs", "box", "pack", "kg", "g", "l", "ml", "m", "set", "pair"],
    lowStockAlerts: true, // notify admins when a product drops to its reorder level
  },
  sales: {
    currency: "INR", // mirrors company.currency (kept for older clients)
  },
  billing: {
    invoicePrefix: "INV-",
    quotePrefix: "QT-",
    taxLabel: "GST",
    defaultTaxRate: 18, // percent, prefilled on new lines
    paymentTermsDays: 15, // due date = issue date + this
    quoteValidityDays: 30,
    paymentMethods: PAYMENT_METHODS,
    defaultNotes: "Thank you for your business.",
    defaultTerms: "",
  },
  logistics: {
    shipmentPrefix: "SHP-",
    publicTracking: true, // anyone with a tracking code can see a shipment's progress (no personal details)
    requireProofOfDelivery: true, // delivering needs the name of who received it
  },
  clinic: {
    mrnPrefix: "MRN-",
    appointmentTypes: APPOINTMENT_TYPES,
    defaultSlotMinutes: 15,
    allowOverbooking: false, // true: a practitioner can have overlapping appointments
    bookingWindowDays: 90, // how far ahead appointments can be booked
  },
  messaging: {
    allowGroups: true, // who may create groups is the "Create group chats" permission
  },
  expenses: {
    categories: ["Travel", "Meals", "Office supplies", "Software", "Training", "Other"],
    maxAmount: null, // per claim; null = no limit
  },
  // Workspace-wide (not tied to a module):
  celebrations: {
    birthdays: "everyone", // everyone: greet the person and tell colleagues; self: only greet the person; off
    anniversaries: "everyone",
  },
  branding: {
    siteTitle: "", // browser tab and sidebar title; empty = the workspace name
    tagline: "", // shown under the title
    accent: "indigo", // default accent colour for everyone in the workspace
    lockAccent: false, // true: people can't pick their own accent
    style: "classic", // default look (web: hooks/useTheme.tsx STYLES)
    lockStyle: false, // true: people can't pick their own style
    // The workspace's own sign-in page (/w/<slug>/login): a layout template plus its words.
    loginTemplate: "split", // split, centered, banner, minimal, corporate
    loginBackground: "indigo", // gradient preset behind the template
    loginHeadline: "", // empty = "Sign in to <title>"
    loginMessage: "",
    loginHighlights: [], // up to 5 short lines (empty = the workspace's modules)
    supportContact: "", // shown under the form: who to ask for an account or a password reset
    // Logo: one of LOGO_ICONS on the brand colour, or an image link (used in the sidebar, sign-in page, and browser tab).
    logoIcon: "check",
    logoUrl: "",
    // The app's background picture (an image link) and how much the page colour dims it, 0-90 percent.
    backgroundImage: "",
    backgroundDim: 40,
    // Tenant-written CSS (sanitized on save, see customCssProblem): one block for /<slug>/login, one for the app.
    customCssEnabled: false,
    customCss: { login: "", app: "" },
    allowUserCss: true, // false: people can't add their own CSS (Settings → Appearance → My custom CSS)
    // The look of every UI element for the whole workspace, on top of the style preset (web: app/globals.css data-ui-*).
    // "default" keeps what the style preset does.
    ui: {
      radius: "default", // corners: none, small, default, large, pill
      shadow: "default", // depth: none, soft, default, strong
      surface: "default", // cards: default, flat, bordered, elevated
      font: "default", // typeface: default (the preset's), system, inter, jakarta, plex, serif, mono
      textSize: "default", // default, sm, lg, xl
      density: "default", // default, compact, spacious
      buttonShape: "default", // default, rounded, pill, square
      animation: "standard", // none, subtle, standard, lively: how much moves
      speed: "normal", // slow, normal, fast: how long it takes
      pageTransition: "none", // none, fade, slide, zoom: pages entering
      hover: "none", // none, lift, glow, scale: cards and buttons under the pointer
    },
  },
  company: {
    legalName: "", // printed on invoices; empty = the workspace name
    address: "",
    taxId: "",
    email: "",
    phone: "",
    website: "",
    currency: "INR", // every amount in the workspace
  },
  // Help for people new to the workspace (web: features/help): guided tours and the help centre.
  help: {
    enabled: true, // false: no tours, tips, or help centre for anyone
    autoStart: true, // the welcome tour opens at a person's first sign-in, a module's tour at their first visit
    helpCenter: true, // the "?" menu with guides and replayable tours
    disabledTours: [], // tour keys switched off (welcome, or a module key)
    welcomeMessage: "", // shown on the first step of the welcome tour (empty = the default greeting)
  },
  // Restrictions the workspace's admins set for everyone in it (services/securityPolicy.js enforces them).
  security: {
    passwordMinLength: 8, // new passwords: chosen, temporary, and reset-link ones
    passwordRequireMixed: false, // true: at least one letter and one number
    sessionHours: 168, // a sign-in lasts this long (7 days), then people sign in again
    allowedEmailDomains: [], // new and imported accounts must use one of these (empty = any domain)
    disabledModules: [], // licensed modules the workspace switched off for everyone (re-enable any time)
  },
});

/** Choices for branding.ui (web: features/workspace/utils/uiOptions.ts lists the same). */
export const UI_OPTIONS = Object.freeze({
  radius: ["none", "small", "default", "large", "pill"],
  shadow: ["none", "soft", "default", "strong"],
  surface: ["default", "flat", "bordered", "elevated"],
  font: ["default", "system", "inter", "jakarta", "plex", "serif", "mono"],
  textSize: ["default", "sm", "lg", "xl"],
  density: ["default", "compact", "spacious"],
  buttonShape: ["default", "rounded", "pill", "square"],
  animation: ["none", "subtle", "standard", "lively"],
  speed: ["slow", "normal", "fast"],
  pageTransition: ["none", "fade", "slide", "zoom"],
  hover: ["none", "lift", "glow", "scale"],
});

/** Settings keys that belong to the workspace rather than a licensed module. */
export const WORKSPACE_KEYS = Object.freeze(["celebrations", "branding", "company", "security", "help"]);
/** Tours the workspace can switch off: the welcome tour and one per module (web: features/help/tours.ts). */
export const TOUR_KEYS = Object.freeze(["welcome", "tasks", "helpdesk", "directory", "messaging", "announcements", "inventory", "sales", "billing", "logistics", "attendance", "expenses", "clinic", "notes", "admin"]);
export const SESSION_HOUR_CHOICES = Object.freeze([8, 12, 24, 72, 168, 336, 720]);
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const ACCENTS = ["indigo", "blue", "teal", "emerald", "amber", "rose", "violet", "slate", "cyan", "fuchsia", "lime", "orange"];
export const STYLES = ["classic", "business", "glass", "midnight", "minimal", "soft", "contrast", "neon", "ocean", "sunset", "forest"];
/** Logo icons a workspace can pick (web: components/shared/logoIcons.ts). */
export const LOGO_ICONS = [
  "check", "briefcase", "building", "store", "rocket", "zap", "star", "heart-pulse", "stethoscope", "truck", "package",
  "graduation-cap", "leaf", "globe", "shield", "layers", "sparkles", "coffee", "wrench", "landmark",
];

/**
 * An image link that is safe to put in CSS url() and <img src>: http(s) only, no quotes, brackets, spaces, or
 * backslashes (they could break out of url("…")). "" = none.
 */
export const imageUrlSchema = z
  .string()
  .trim()
  .max(1000, "Use a link under 1000 characters.")
  .refine(value => value === "" || /^https?:\/\/[^\s"'()<>\\]+$/i.test(value), "Use an image link starting with https:// (no spaces or quotes).");

// ---- Custom CSS: runs on every member's screen, and the sign-in block on the page that holds passwords ----
// Mirrored in web/src/features/workspace/utils/customCss.ts (keep the two lists in step).
export const CUSTOM_CSS_MAX = 20_000;

/** [pattern, why] — checked on the CSS as written and again with comments removed (so `ur/**\/l(` can't slip by). */
const CSS_FORBIDDEN = [
  [/url\s*\(/i, "url() isn't allowed: it can load remote files or leak what people type."],
  [/image-set\s*\(/i, "image-set() isn't allowed: it can load remote files."],
  [/(^|[^\w-])src\s*\(/i, "src() isn't allowed: it can load remote files."],
  [/@import/i, "@import isn't allowed."],
  [/@charset/i, "@charset isn't allowed."],
  [/@namespace/i, "@namespace isn't allowed."],
  [/@font-face/i, "@font-face isn't allowed (it loads font files)."],
  [/expression\s*\(/i, "expression() isn't allowed."],
  [/behavior\s*:/i, "behavior: isn't allowed."],
  [/-moz-binding/i, "-moz-binding isn't allowed."],
  [/javascript\s*:/i, "javascript: isn't allowed."],
  [/<\/style/i, "</style isn't allowed."],
  [/<script/i, "<script isn't allowed."],
  [/\\/, "Backslash escapes aren't allowed (they can hide blocked words)."],
  // eslint-disable-next-line no-control-regex
  [/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/, "Remove the invisible control characters."],
];

/** Line endings as \n (CRLF and lone CR). */
export const normalizeCss = css => String(css ?? "").replace(/\r\n?/g, "\n");

/** Why this CSS can't be saved, or null when it's fine. */
export function customCssProblem(css) {
  const text = normalizeCss(css);
  if (text.length > CUSTOM_CSS_MAX) return `Keep custom CSS under ${CUSTOM_CSS_MAX.toLocaleString("en-US")} characters.`;
  const withoutComments = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
  for (const [pattern, why] of CSS_FORBIDDEN) {
    if (pattern.test(text) || pattern.test(withoutComments)) return why;
  }
  return null;
}

/** Personal CSS (users.preferences.customCss) has a smaller limit: it only restyles one person's screen. */
export const USER_CSS_MAX = 10_000;

/** Why this personal CSS can't be saved (same rules as the workspace's, smaller limit), or null. */
export function userCssProblem(css) {
  const text = normalizeCss(css);
  if (text.length > USER_CSS_MAX) return `Keep your CSS under ${USER_CSS_MAX.toLocaleString("en-US")} characters.`;
  return customCssProblem(text);
}

const cssBlock = z
  .string()
  .transform(normalizeCss)
  .superRefine((css, ctx) => {
    const problem = customCssProblem(css);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const hours = z.number().min(0.25, "At least 15 minutes.").max(2000, "At most 2000 hours.");
const slaLevel = z
  .object({ response: hours, resolution: hours })
  .refine(level => level.resolution >= level.response, { message: "Resolution can't be faster than the first response." });

/** Every key optional: a PATCH sends only the module (or field) being changed. */
export const settingsSchema = z
  .object({
    helpdesk: z
      .object({
        sla: z.object({ urgent: slaLevel, high: slaLevel, medium: slaLevel, low: slaLevel }).partial(),
        categories: z.array(z.enum(TICKET_CATEGORIES)).min(1, "Keep at least one category."),
      })
      .partial(),
    attendance: z
      .object({
        autoCheckIn: z.boolean(),
        workdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30."),
        lateAfterMinutes: z.number().int().min(0).max(240),
        workingDays: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one working day."),
        halfDayLeave: z.boolean(),
        leaveTypes: z.array(z.enum(LEAVE_TYPES)).min(1, "Keep at least one leave type."),
        annualAllowance: z.number().int().min(0).max(365),
        saturdaysOff: z.array(z.number().int().min(1).max(5)).max(5),
        optionalHolidayQuota: z.number().int().min(0).max(30),
      })
      .partial(),
    inventory: z
      .object({
        units: z.array(z.string().trim().min(1).max(20)).min(1, "Keep at least one unit.").max(40),
        lowStockAlerts: z.boolean(),
      })
      .partial(),
    sales: z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code like INR or USD.") }).partial(),
    messaging: z.object({ allowGroups: z.boolean() }).partial(),
    expenses: z
      .object({
        categories: z.array(z.string().trim().min(1).max(60)).min(1, "Keep at least one category.").max(40),
        maxAmount: z.number().positive().max(1e12).nullable(),
      })
      .partial(),
    billing: z
      .object({
        invoicePrefix: z.string().trim().max(10),
        quotePrefix: z.string().trim().max(10),
        taxLabel: z.string().trim().min(1).max(20),
        defaultTaxRate: z.number().min(0).max(100),
        paymentTermsDays: z.number().int().min(0).max(365),
        quoteValidityDays: z.number().int().min(1).max(365),
        paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1, "Keep at least one payment method."),
        defaultNotes: z.string().trim().max(1000),
        defaultTerms: z.string().trim().max(2000),
      })
      .partial(),
    logistics: z.object({ shipmentPrefix: z.string().trim().max(10), publicTracking: z.boolean(), requireProofOfDelivery: z.boolean() }).partial(),
    clinic: z
      .object({
        mrnPrefix: z.string().trim().max(10),
        appointmentTypes: z.array(z.enum(APPOINTMENT_TYPES)).min(1, "Keep at least one appointment type."),
        defaultSlotMinutes: z.number().int().min(5).max(240),
        allowOverbooking: z.boolean(),
        bookingWindowDays: z.number().int().min(1).max(730),
      })
      .partial(),
    company: z
      .object({
        legalName: z.string().trim().max(160),
        address: z.string().trim().max(500),
        taxId: z.string().trim().max(40),
        email: z.union([z.literal(""), z.string().trim().email("Enter a valid email.").max(255)]),
        phone: z.string().trim().max(40),
        website: z.string().trim().max(200),
        currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code like INR or USD."),
      })
      .partial(),
    celebrations: z.object({ birthdays: z.enum(["everyone", "self", "off"]), anniversaries: z.enum(["everyone", "self", "off"]) }).partial(),
    security: z
      .object({
        passwordMinLength: z.number().int().min(8, "At least 8 characters.").max(64, "At most 64 characters."),
        passwordRequireMixed: z.boolean(),
        sessionHours: z.number().int().refine(value => SESSION_HOUR_CHOICES.includes(value), "Pick one of the offered session lengths."),
        allowedEmailDomains: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              .transform(value => value.replace(/^@/, ""))
              .refine(value => DOMAIN.test(value), "Use domains like example.com.")
          )
          .max(20, "Use at most 20 domains.")
          .transform(list => [...new Set(list)]),
        // Checked against the licence in routes/workspace.js (the schema doesn't know the tenant).
        disabledModules: z.array(z.string().regex(/^[a-z]+$/)).max(20).transform(list => [...new Set(list)]),
      })
      .partial(),
    help: z
      .object({
        enabled: z.boolean(),
        autoStart: z.boolean(),
        helpCenter: z.boolean(),
        disabledTours: z.array(z.enum(TOUR_KEYS)).max(TOUR_KEYS.length).transform(list => [...new Set(list)]),
        welcomeMessage: z.string().trim().max(400, "Keep the message under 400 characters."),
      })
      .partial()
      .strict(),
    branding: z
      .object({
        siteTitle: z.string().trim().max(60, "Keep the title under 60 characters."),
        tagline: z.string().trim().max(120),
        accent: z.enum(ACCENTS),
        logoIcon: z.string().trim().min(1).max(80),
        logoUrl: imageUrlSchema,
        backgroundImage: imageUrlSchema,
        backgroundDim: z.number().int().min(0).max(90),
        lockAccent: z.boolean(),
        style: z.enum(STYLES),
        lockStyle: z.boolean(),
        loginTemplate: z.enum(LOGIN_TEMPLATES),
        loginBackground: z.enum(LOGIN_BACKGROUNDS),
        loginHeadline: z.string().trim().max(120, "Keep the headline under 120 characters."),
        loginMessage: z.string().trim().max(300, "Keep the message under 300 characters."),
        loginHighlights: z.array(z.string().trim().min(1).max(80, "Keep each highlight under 80 characters.")).max(5, "Use at most 5 highlights."),
        supportContact: z.string().trim().max(160),
        customCssEnabled: z.boolean(),
        customCss: z.object({ login: cssBlock, app: cssBlock }).partial().strict(),
        allowUserCss: z.boolean(),
        ui: z
          .object(Object.fromEntries(Object.entries(UI_OPTIONS).map(([key, values]) => [key, z.enum(values, { error: `Choose one of: ${values.join(", ")}.` })])))
          .partial()
          .strict(),
      })
      .partial(),
  })
  .partial()
  .strict(); // unknown module keys are a mistake worth reporting, not ignoring

/**
 * Like validate(settingsSchema, body), but branding problems also report under their own field
 * ("branding.logoUrl", "branding.customCss.login", …) as well as "branding", so forms can show them inline.
 */
export function validateSettings(body) {
  const result = settingsSchema.safeParse(body);
  if (result.success) return result.data;
  const errors = {};
  for (const issue of result.error.issues) {
    const path = issue.path.map(String);
    if (path[0] === "branding" && path[1]) errors[path.slice(0, path[1] === "customCss" && path[2] ? 3 : 2).join(".")] ??= issue.message;
    errors[path[0] ?? "form"] ??= issue.message;
  }
  throw new HttpError(422, "Please fix the highlighted fields.", { code: "VALIDATION_ERROR", errors });
}

const isPlainObject = value => value && typeof value === "object" && !Array.isArray(value);

/** Deep merge for plain objects; arrays and scalars from `patch` replace the base. */
export function mergeDeep(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = mergeDeep(base[key], value);
  return result;
}

/** Stored JSON (possibly null or partial) -> complete settings. */
export function resolveSettings(json) {
  let stored = {};
  try {
    stored = JSON.parse(json || "{}") ?? {};
  } catch {
    stored = {};
  }
  const settings = mergeDeep(DEFAULT_SETTINGS, stored);
  // One workspace currency: company.currency, falling back to the older sales.currency.
  const currency = stored.company?.currency ?? stored.sales?.currency ?? DEFAULT_SETTINGS.company.currency;
  settings.company = { ...settings.company, currency };
  settings.sales = { ...settings.sales, currency };
  return settings;
}

/** Applies a validated patch to stored JSON and returns the new JSON to save. */
export function applySettingsPatch(json, patch) {
  let stored = {};
  try {
    stored = JSON.parse(json || "{}") ?? {};
  } catch {
    stored = {};
  }
  // sales.currency is an alias for company.currency.
  if (patch.sales?.currency) {
    const { currency, ...sales } = patch.sales;
    patch = { ...patch, company: { ...patch.company, currency } };
    if (Object.keys(sales).length) patch.sales = sales;
    else delete patch.sales;
  }
  const next = mergeDeep(stored, patch);
  if (next.sales) delete next.sales.currency;
  return JSON.stringify(next);
}
