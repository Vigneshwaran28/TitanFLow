// The module catalog: how licensable modules relate to each other and which ones each industry offers.
// Single source of truth for the provider console (GET /api/bunny/tenants returns it, so the web never duplicates
// these rules) and for tenant validation (routes/admin.js). Documented in docs/MODULES.md.
//
// requires: hard dependencies. A module can't be licensed without them (the console ticks them automatically).
// enhances: soft links. Both work alone; together they share data (shown as "works well with" hints).
import { FEATURES } from "./tenants.js";

/** @typedef {"tasks"|"helpdesk"|"directory"|"messaging"|"announcements"|"inventory"|"sales"|"billing"|"logistics"|"attendance"|"expenses"|"clinic"|"notes"} FeatureKey */

/** @type {Readonly<Record<FeatureKey, { requires: FeatureKey[], enhances: FeatureKey[], note?: string }>>} */
export const MODULE_RELATIONS = Object.freeze({
  tasks: { requires: [], enhances: [] },
  // Tickets are routed to teams, and teams are run in Teams & people.
  helpdesk: { requires: ["directory"], enhances: [], note: "Tickets are routed to teams, which are managed in Teams & people." },
  directory: { requires: [], enhances: ["helpdesk", "attendance"] },
  messaging: { requires: [], enhances: ["directory"] },
  announcements: { requires: [], enhances: [] },
  // Products are shared: sales orders take stock, invoices pick products.
  inventory: { requires: [], enhances: ["sales", "billing"], note: "Products are shared with sales orders and invoices." },
  // Orders take stock only when inventory is licensed; won deals become orders, orders become invoices.
  sales: { requires: [], enhances: ["inventory", "billing", "logistics"], note: "Orders take stock when Inventory is on and can be invoiced in Billing." },
  // Billing has its own customer list, but invoices from sales orders and product lines need those modules.
  billing: { requires: [], enhances: ["sales", "inventory"], note: "Invoices can come from sales orders and use inventory products." },
  // Shipments can be booked for sales orders and their customers.
  logistics: { requires: [], enhances: ["sales", "billing"], note: "Shipments can be booked for sales orders and their customers." },
  attendance: { requires: [], enhances: ["directory", "clinic"] },
  expenses: { requires: [], enhances: [] },
  // Self-contained; a pharmacy uses inventory, consultations are billed in billing, and duty rosters use attendance.
  clinic: { requires: [], enhances: ["billing", "inventory", "attendance"], note: "Use Inventory as the pharmacy and Billing for consultation fees." },
  notes: { requires: [], enhances: [] },
});

/** Modules every industry may use: running a team, not a line of business. */
export const COMMON_MODULES = Object.freeze(["tasks", "helpdesk", "directory", "messaging", "announcements", "attendance", "expenses", "notes"]);

/**
 * Industries a tenant belongs to. allowed: what may be licensed (common modules plus the industry's own);
 * recommended: what a new tenant of that industry starts with.
 */
export const INDUSTRIES = Object.freeze([
  {
    key: "hospital",
    label: "Hospital / clinic",
    description: "Appointments, patients, visits, and prescriptions, with a pharmacy (inventory) and billing.",
    modules: ["clinic", "billing", "inventory"],
    recommended: ["clinic", "billing", "inventory", "directory", "attendance", "announcements", "messaging", "tasks"],
  },
  {
    key: "logistics",
    label: "Logistics",
    description: "Shipments, dispatch, fleet, and tracking, with orders, stock, and invoicing.",
    modules: ["logistics", "sales", "billing", "inventory"],
    recommended: ["logistics", "sales", "billing", "inventory", "directory", "attendance", "expenses", "messaging"],
  },
  {
    key: "retail",
    label: "Retail & trading",
    description: "Customers, orders, stock, invoices, and expenses.",
    modules: ["sales", "inventory", "billing"],
    recommended: ["sales", "inventory", "billing", "expenses", "directory", "attendance", "announcements"],
  },
  {
    key: "services",
    label: "Professional services",
    description: "A help desk, tasks, and a sales pipeline with quotes and invoices.",
    modules: ["sales", "billing"],
    recommended: ["helpdesk", "directory", "tasks", "sales", "billing", "expenses", "messaging", "notes"],
  },
  {
    key: "custom",
    label: "Custom",
    description: "Mix any modules. No industry rules apply.",
    modules: [...FEATURES],
    recommended: ["helpdesk", "directory", "tasks"],
  },
].map(industry => {
  const allowed = FEATURES.filter(key => COMMON_MODULES.includes(key) || industry.modules.includes(key));
  return Object.freeze({ ...industry, allowed, recommended: FEATURES.filter(key => industry.recommended.includes(key)) });
}));

export const INDUSTRY_KEYS = Object.freeze(INDUSTRIES.map(industry => industry.key));
export const DEFAULT_INDUSTRY = "custom";

/** @param {string | null | undefined} key */
export const industryOf = key => INDUSTRIES.find(industry => industry.key === key) ?? INDUSTRIES.find(industry => industry.key === DEFAULT_INDUSTRY);

const LABELS = Object.freeze({
  tasks: "Tasks",
  helpdesk: "Help desk",
  directory: "Teams & people",
  messaging: "Messages",
  announcements: "Announcements",
  inventory: "Inventory",
  sales: "Sales",
  billing: "Billing",
  logistics: "Logistics",
  attendance: "Attendance",
  expenses: "Expenses",
  clinic: "Clinic",
  notes: "Notes",
});
export const moduleLabel = key => LABELS[key] ?? key;
const listOf = keys => keys.map(moduleLabel).join(", ");

/** Every module a set needs: the set plus its requirements, transitively. */
export function withRequirements(features) {
  const result = new Set(features);
  const queue = [...features];
  while (queue.length) {
    for (const dependency of MODULE_RELATIONS[queue.shift()]?.requires ?? []) {
      if (!result.has(dependency)) {
        result.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return FEATURES.filter(key => result.has(key));
}

/** Modules of `features` that `industryKey` doesn't offer. */
export const modulesOutside = (industryKey, features) => features.filter(key => !industryOf(industryKey).allowed.includes(key));

/**
 * Problems with licensing `features` to a tenant of `industryKey`, as field errors ({ features?, industry? }).
 * An empty object means the combination is valid.
 */
export function checkModules(industryKey, features) {
  const industry = industryOf(industryKey);
  const errors = {};
  const outside = features.filter(key => !industry.allowed.includes(key));
  if (outside.length) {
    const message = `${listOf(outside)} ${outside.length === 1 ? "isn't" : "aren't"} part of ${industry.label}. Remove ${outside.length === 1 ? "it" : "them"} first, or choose Custom.`;
    errors.features = message;
    errors.industry = message;
    return errors;
  }
  const missing = [];
  for (const key of features) {
    const needs = (MODULE_RELATIONS[key]?.requires ?? []).filter(dependency => !features.includes(dependency));
    if (needs.length) missing.push(`${moduleLabel(key)} needs ${listOf(needs)}`);
  }
  if (missing.length) errors.features = `${missing.join("; ")}. Turn ${missing.length === 1 ? "it" : "them"} on too.`;
  return errors;
}

/** The catalog as the console's web app reads it. */
export function moduleCatalog() {
  return {
    common: COMMON_MODULES,
    modules: Object.fromEntries(FEATURES.map(key => [key, { requires: MODULE_RELATIONS[key].requires, enhances: MODULE_RELATIONS[key].enhances, note: MODULE_RELATIONS[key].note ?? null }])),
    industries: INDUSTRIES.map(({ key, label, description, allowed, recommended }) => ({ key, label, description, allowed, recommended })),
    defaultIndustry: DEFAULT_INDUSTRY,
  };
}
