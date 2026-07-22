/**
 * Builds data/ledger.db — the whole demo dataset.
 *
 * Deterministic by construction: one mulberry32 stream from a fixed seed, and
 * every date derived from the calendar constants below rather than the clock.
 * Re-running produces a byte-identical dataset, which is what makes the numbers
 * in a screenshot still true tomorrow.
 *
 * The invoice snapshot is computed here with the same arithmetic as
 * lib/billing.ts `buildStatement` (rounding at the line, subtotals as sums of
 * rounded lines) so the stored invoice reconciles exactly with what the app
 * recomputes from the raw rows.
 *
 *   node scripts/seed.mjs [--force]
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { costOf, loadPricing } from "./pricing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "ledger.db");
const SCHEMA_PATH = path.join(HERE, "schema.sql");

// ── Calendar (the only source of "now" in this script) ───────────────────────

const SPAN_START = "2026-04-01";
const SPAN_END = "2026-07-21";
const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07"];
const COMPLETE_MONTHS = ["2026-04", "2026-05", "2026-06"];
/**
 * Calendar month ends, not data ends: an invoice period must match
 * `monthPeriod()` in lib/queries.ts exactly or the app cannot find the stored
 * invoice for the month. July simply has no rows past the 21st.
 */
const MONTH_END = {
  "2026-04": "2026-04-30",
  "2026-05": "2026-05-31",
  "2026-06": "2026-06-30",
  "2026-07": "2026-07-31",
};
/** Invoice issue date = the 5th of the following month. */
const MONTH_ISSUE = {
  "2026-04": "2026-05-05",
  "2026-05": "2026-06-05",
  "2026-06": "2026-07-05",
};
/** Adoption ramp: April is light, July is heaviest. */
const MONTH_ADOPTION = {
  "2026-04": { rowChance: 0.55, tokenMult: 0.62 },
  "2026-05": { rowChance: 0.72, tokenMult: 0.84 },
  "2026-06": { rowChance: 0.88, tokenMult: 1.12 },
  "2026-07": { rowChance: 0.96, tokenMult: 1.46 },
};

const FIRM = "Meridian Advisory LLP";

// ── PRNG ────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260721);

const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const randRange = (lo, hi) => lo + rng() * (hi - lo);
const chance = (p) => rng() < p;

function pick(arr) {
  const i = Math.floor(rng() * arr.length);
  return arr[Math.min(i, arr.length - 1)];
}

/** `entries` is [[value, weight], ...]. */
function pickWeighted(entries) {
  let total = 0;
  for (const e of entries) total += e[1];
  let r = rng() * total;
  for (const e of entries) {
    r -= e[1];
    if (r <= 0) return e[0];
  }
  return entries[entries.length - 1][0];
}

function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ── Dates, without the Date object ──────────────────────────────────────────

/** Days since 1970-01-01 (Hinnant's days_from_civil). */
function dayNum(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isoFromDayNum(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) /
      365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(
    d,
  ).padStart(2, "0")}`;
}

function addDays(iso, n) {
  return isoFromDayNum(dayNum(iso) + n);
}

/** 0 = Sunday. 1970-01-01 was a Thursday. */
function weekday(iso) {
  return (((dayNum(iso) + 4) % 7) + 7) % 7;
}

function isWeekday(iso) {
  const w = weekday(iso);
  return w >= 1 && w <= 5;
}

/** Inclusive weekday list between two ISO dates. */
function weekdaysBetween(from, to) {
  const out = [];
  const hi = dayNum(to);
  for (let d = dayNum(from); d <= hi; d++) {
    const iso = isoFromDayNum(d);
    if (isWeekday(iso)) out.push(iso);
  }
  return out;
}

const maxDate = (a, b) => (a > b ? a : b);
const minDate = (a, b) => (a < b ? a : b);
const monthOf = (iso) => iso.slice(0, 7);

// ── Money ───────────────────────────────────────────────────────────────────

/** Mirrors round2 in lib/billing.ts. */
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + Number.EPSILON)) / 100;
}

function sum(ns) {
  let t = 0;
  for (const n of ns) t += n;
  return t;
}

function ratio(a, b) {
  return b === 0 ? null : a / b;
}

// ── Reference data ──────────────────────────────────────────────────────────

const pricing = loadPricing();
const RATES = pricing.rates;
const SEAT_COST = {};
for (const s of pricing.seats) SEAT_COST[s.plan] = s.monthlyCost;

const GRADE_RATES = {
  partner: { bill: 520, cost: 218 },
  principal: { bill: 420, cost: 176 },
  manager: { bill: 330, cost: 139 },
  senior_consultant: { bill: 260, cost: 109 },
  consultant: { bill: 195, cost: 82 },
  analyst: { bill: 140, cost: 59 },
};
const GRADE_RANK = {
  partner: 0,
  principal: 1,
  manager: 2,
  senior_consultant: 3,
  consultant: 4,
  analyst: 5,
};

const CLIENTS = [
  {
    id: "cl_northgate",
    name: "Northgate Financial",
    industry: "Retail banking",
    initials: "NF",
    currency: "USD",
    payment_terms_days: 30,
    billing_contact_name: "Fiona Ashcroft",
    billing_contact_email: "fiona.ashcroft@northgatefinancial.com",
    region: "EMEA — London",
  },
  {
    id: "cl_helix",
    name: "Helix Health",
    industry: "Healthcare payer",
    initials: "HH",
    currency: "USD",
    payment_terms_days: 45,
    billing_contact_name: "Darnell Weeks",
    billing_contact_email: "darnell.weeks@helixhealth.com",
    region: "North America — Chicago",
  },
  {
    id: "cl_vantor",
    name: "Vantor Industries",
    industry: "Industrial manufacturing",
    initials: "VI",
    currency: "USD",
    payment_terms_days: 60,
    billing_contact_name: "Annika Vogt",
    billing_contact_email: "annika.vogt@vantor-industries.de",
    region: "DACH — Munich",
  },
  {
    id: "cl_kestrel",
    name: "Kestrel Telecom",
    industry: "Telecommunications",
    initials: "KT",
    currency: "USD",
    payment_terms_days: 45,
    billing_contact_name: "Gareth Pemberton",
    billing_contact_email: "gareth.pemberton@kestreltelecom.co.uk",
    region: "UK — Manchester",
  },
  {
    id: "cl_bureau",
    name: "Bureau of Civic Records",
    industry: "Public sector",
    initials: "BC",
    currency: "USD",
    payment_terms_days: 60,
    billing_contact_name: "Lorna Deveraux",
    billing_contact_email: "l.deveraux@civicrecords.gov",
    region: "North America — Sacramento",
  },
];

const PEOPLE = [
  ["Alistair Vance", "partner", "Financial Services", "London"],
  ["Marguerite Osei", "partner", "Public Sector", "Washington DC"],
  ["Klaus Brenner", "partner", "Operations", "Munich"],
  ["Priya Raghunathan", "principal", "Data & AI", "London"],
  ["Daniel Okonjo", "principal", "Technology Strategy", "Chicago"],
  ["Sofia Lindqvist", "principal", "Data & AI", "Stockholm"],
  ["Hugo Marchetti", "principal", "Financial Services", "Milan"],
  ["Rachel Kirby", "principal", "Operations", "Manchester"],
  ["Tomas Ferreira", "manager", "Data & AI", "Lisbon"],
  ["Ingrid Halvorsen", "manager", "Technology Strategy", "Oslo"],
  ["Michael Doyle", "manager", "Financial Services", "Dublin"],
  ["Aisha Rahman", "manager", "Public Sector", "Toronto"],
  ["Lucas Meyer", "manager", "Operations", "Munich"],
  ["Emma Whitfield", "manager", "Data & AI", "Manchester"],
  ["Ravi Chandrasekaran", "manager", "Technology Strategy", "Chicago"],
  ["Camille Fournier", "manager", "Financial Services", "Paris"],
  ["Owen Brightwell", "senior_consultant", "Data & AI", "London"],
  ["Nadia Petrova", "senior_consultant", "Technology Strategy", "Berlin"],
  ["Jonas Keller", "senior_consultant", "Operations", "Munich"],
  ["Freya Sandberg", "senior_consultant", "Data & AI", "Stockholm"],
  ["Peter Nowak", "senior_consultant", "Financial Services", "Warsaw"],
  ["Grace Odumosu", "senior_consultant", "Public Sector", "Chicago"],
  ["Ben Alderton", "senior_consultant", "Technology Strategy", "Manchester"],
  ["Marta Reyes", "senior_consultant", "Operations", "Madrid"],
  ["Simon Achterberg", "senior_consultant", "Data & AI", "Amsterdam"],
  ["Lena Fischer", "consultant", "Data & AI", "Munich"],
  ["Callum Roe", "consultant", "Financial Services", "London"],
  ["Yuki Tanabe", "consultant", "Technology Strategy", "Chicago"],
  ["Sara Mendel", "consultant", "Operations", "Manchester"],
  ["Tobias Lund", "consultant", "Data & AI", "Copenhagen"],
  ["Naomi Cartwright", "consultant", "Public Sector", "Sacramento"],
  ["Dev Mistry", "analyst", "Data & AI", "London"],
  ["Hannah Boyle", "analyst", "Financial Services", "Manchester"],
  ["Andre Silva", "analyst", "Public Sector", "Chicago"],
];

const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, "_");
const initialsOf = (name) =>
  name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const consultants = PEOPLE.map(([name, grade, practice, location]) => ({
  id: `co_${slug(name)}`,
  name,
  email: `${slug(name).replace(/_/g, ".")}@meridianadvisory.com`,
  grade,
  practice,
  location,
  initials: initialsOf(name),
  default_bill_rate: GRADE_RATES[grade].bill,
  default_cost_rate: GRADE_RATES[grade].cost,
  active: 1,
}));

const consultantById = new Map(consultants.map((c) => [c.id, c]));
const byGrade = {};
for (const g of Object.keys(GRADE_RATES)) {
  byGrade[g] = consultants.filter((c) => c.grade === g);
}

/** Has usage in July but logs no hours — makes the unallocable residual visible. */
const NO_JULY_HOURS = "co_andre_silva";

const APPROVERS = consultants
  .filter((c) => c.grade === "partner" || c.grade === "manager")
  .map((c) => c.name);

// ── Projects and workstreams ────────────────────────────────────────────────

const PROJECTS = [
  {
    id: "pr_ngf_core",
    client_id: "cl_northgate",
    code: "NGF-2026-01",
    name: "Core banking platform modernisation",
    status: "active",
    engagement_type: "time_and_materials",
    start_date: "2026-01-12",
    end_date: "2026-12-18",
    contract_value: 3_150_000,
    engagement_partner: "Alistair Vance",
    delivery_lead: "Priya Raghunathan",
    po_number: "NGF-PO-44718",
    ai_policy_default: "markup",
    ai_markup_pct_default: 0.2,
  },
  {
    id: "pr_hhx_claims",
    client_id: "cl_helix",
    code: "HHX-2026-01",
    name: "Claims platform re-architecture",
    status: "active",
    engagement_type: "time_and_materials",
    start_date: "2026-01-05",
    end_date: "2026-12-18",
    contract_value: 2_740_000,
    engagement_partner: "Marguerite Osei",
    delivery_lead: "Daniel Okonjo",
    po_number: "HHX-PO-90211",
    ai_policy_default: "markup",
    ai_markup_pct_default: 0.25,
  },
  {
    id: "pr_ngf_reg",
    client_id: "cl_northgate",
    code: "NGF-2026-02",
    name: "Regulatory reporting automation",
    status: "active",
    engagement_type: "capped_tm",
    start_date: "2026-02-16",
    end_date: "2026-09-30",
    contract_value: 780_000,
    engagement_partner: "Alistair Vance",
    delivery_lead: "Michael Doyle",
    po_number: "NGF-PO-44903",
    ai_policy_default: "at_cost",
    ai_markup_pct_default: 0,
  },
  {
    id: "pr_vti_factory",
    client_id: "cl_vantor",
    code: "VTI-2026-03",
    name: "Smart factory data foundation",
    status: "active",
    engagement_type: "time_and_materials",
    start_date: "2026-02-09",
    end_date: "2026-11-30",
    contract_value: 1_460_000,
    engagement_partner: "Klaus Brenner",
    delivery_lead: "Lucas Meyer",
    po_number: "VTI-PO-2026-118",
    ai_policy_default: "markup",
    ai_markup_pct_default: 0.15,
  },
  {
    id: "pr_ktl_netops",
    client_id: "cl_kestrel",
    code: "KTL-2026-02",
    name: "Network operations automation",
    status: "active",
    engagement_type: "capped_tm",
    start_date: "2026-01-26",
    end_date: "2026-10-30",
    contract_value: 1_120_000,
    engagement_partner: "Klaus Brenner",
    delivery_lead: "Rachel Kirby",
    po_number: "KTL-PO-77320",
    ai_policy_default: "markup",
    ai_markup_pct_default: 0.18,
  },
  {
    id: "pr_hhx_provider",
    client_id: "cl_helix",
    code: "HHX-2026-04",
    name: "Provider data quality remediation",
    status: "active",
    engagement_type: "fixed_fee",
    start_date: "2026-03-02",
    end_date: "2026-08-28",
    contract_value: 640_000,
    engagement_partner: "Marguerite Osei",
    delivery_lead: "Aisha Rahman",
    po_number: "HHX-PO-90588",
    ai_policy_default: "absorbed",
    ai_markup_pct_default: 0,
  },
  {
    id: "pr_ktl_care",
    client_id: "cl_kestrel",
    code: "KTL-2026-05",
    name: "Customer care AI enablement",
    status: "active",
    engagement_type: "fixed_fee",
    start_date: "2026-04-06",
    end_date: "2026-09-25",
    contract_value: 520_000,
    engagement_partner: "Alistair Vance",
    delivery_lead: "Emma Whitfield",
    po_number: "KTL-PO-77661",
    ai_policy_default: "at_cost",
    ai_markup_pct_default: 0,
  },
  {
    id: "pr_bcr_records",
    client_id: "cl_bureau",
    code: "BCR-2026-01",
    name: "Records digitisation programme",
    status: "closing",
    engagement_type: "time_and_materials",
    start_date: "2026-01-05",
    end_date: "2026-07-31",
    contract_value: 905_000,
    engagement_partner: "Marguerite Osei",
    delivery_lead: "Grace Odumosu",
    po_number: "BCR-PO-0264",
    ai_policy_default: "absorbed",
    ai_markup_pct_default: 0,
  },
];

const projectById = new Map(PROJECTS.map((p) => [p.id, p]));

/**
 * Workstream definitions. `aiPolicy` set here overrides the project default —
 * three of them do, so the inheritance logic is visible in the UI.
 */
const WS_DEFS = [
  // NGF-2026-01
  {
    project_id: "pr_ngf_core",
    code: "WS1",
    name: "Discovery & current-state assessment",
    status: "complete",
    start_date: "2026-01-12",
    end_date: "2026-04-30",
    budget_hours: 1180,
    blended: 268,
    description:
      "Current-state architecture review, gap analysis and target-state options for the core banking estate.",
  },
  {
    project_id: "pr_ngf_core",
    code: "WS2",
    name: "Core platform build",
    status: "active",
    start_date: "2026-02-02",
    end_date: "2026-11-27",
    budget_hours: 2560,
    blended: 292,
    description:
      "Build and integration of the deposits and payments services on the target core platform.",
  },
  {
    project_id: "pr_ngf_core",
    code: "WS3",
    name: "Data migration",
    status: "active",
    start_date: "2026-03-02",
    end_date: "2026-10-30",
    budget_hours: 1640,
    blended: 254,
    aiPolicy: "at_cost",
    aiMarkup: 0,
    description:
      "Extract, reconcile and load 14 years of account history into the target data model.",
  },
  {
    project_id: "pr_ngf_core",
    code: "WS4",
    name: "Change & enablement",
    status: "active",
    start_date: "2026-04-01",
    end_date: "2026-12-11",
    budget_hours: 720,
    blended: 236,
    description:
      "Operating-model design, branch and contact-centre readiness, and colleague training.",
  },
  // HHX-2026-01
  {
    project_id: "pr_hhx_claims",
    code: "WS1",
    name: "Claims adjudication re-architecture",
    status: "active",
    start_date: "2026-01-05",
    end_date: "2026-12-11",
    budget_hours: 2480,
    blended: 312,
    hardest: true,
    description:
      "Decomposition of the monolithic adjudication engine into rules, pricing and payment services.",
  },
  {
    project_id: "pr_hhx_claims",
    code: "WS2",
    name: "Integration & interoperability",
    status: "active",
    start_date: "2026-02-02",
    end_date: "2026-11-27",
    budget_hours: 1420,
    blended: 284,
    description:
      "FHIR interfaces, clearinghouse connectivity and partner onboarding for the new claims services.",
  },
  {
    project_id: "pr_hhx_claims",
    code: "WS3",
    name: "Test automation",
    status: "active",
    start_date: "2026-03-16",
    end_date: "2026-10-30",
    budget_hours: 980,
    blended: 242,
    aiPolicy: "absorbed",
    aiMarkup: 0,
    description:
      "Regression suite, synthetic claim generation and release-gate automation.",
  },
  // NGF-2026-02
  {
    project_id: "pr_ngf_reg",
    code: "WS1",
    name: "Regulatory reporting build",
    status: "active",
    start_date: "2026-02-16",
    end_date: "2026-09-30",
    budget_hours: 1240,
    blended: 276,
    pinnedModel: "claude-opus-4-7",
    description:
      "COREP and liquidity return automation, with lineage from source system to submitted return.",
  },
  {
    project_id: "pr_ngf_reg",
    code: "WS2",
    name: "Controls testing & assurance",
    status: "active",
    start_date: "2026-03-16",
    end_date: "2026-09-18",
    budget_hours: 610,
    blended: 258,
    description:
      "Design-effectiveness testing of the reporting controls and remediation tracking.",
  },
  // VTI-2026-03
  {
    project_id: "pr_vti_factory",
    code: "WS1",
    name: "Plant data foundation build",
    status: "active",
    start_date: "2026-02-09",
    end_date: "2026-11-13",
    budget_hours: 1720,
    blended: 274,
    description:
      "Unified namespace, historian ingestion and contextualised asset model across four plants.",
  },
  {
    project_id: "pr_vti_factory",
    code: "WS2",
    name: "OT/IT convergence assessment",
    status: "complete",
    start_date: "2026-02-09",
    end_date: "2026-05-29",
    budget_hours: 540,
    blended: 288,
    description:
      "Network segmentation, identity and change-control assessment across the OT estate.",
  },
  {
    project_id: "pr_vti_factory",
    code: "WS3",
    name: "Predictive maintenance pilot",
    status: "active",
    start_date: "2026-04-13",
    end_date: "2026-10-16",
    budget_hours: 860,
    blended: 262,
    description:
      "Failure-mode modelling and pilot deployment on the Munich press line.",
  },
  // KTL-2026-02
  {
    project_id: "pr_ktl_netops",
    code: "WS1",
    name: "Fault management automation",
    status: "active",
    start_date: "2026-01-26",
    end_date: "2026-10-16",
    budget_hours: 1480,
    blended: 266,
    description:
      "Alarm correlation, automated diagnosis and closed-loop remediation for the access network.",
  },
  {
    project_id: "pr_ktl_netops",
    code: "WS2",
    name: "Assurance & test automation",
    status: "active",
    start_date: "2026-03-02",
    end_date: "2026-09-25",
    budget_hours: 720,
    blended: 244,
    description:
      "Service-assurance regression packs and automated pre-release validation.",
  },
  {
    project_id: "pr_ktl_netops",
    code: "WS3",
    name: "Field operations enablement",
    status: "active",
    start_date: "2026-04-06",
    end_date: "2026-10-30",
    budget_hours: 480,
    blended: 228,
    description:
      "Engineer-facing runbooks, mobile workflow changes and regional rollout support.",
  },
  // HHX-2026-04 (fixed fee)
  {
    project_id: "pr_hhx_provider",
    code: "WS1",
    name: "Provider record remediation",
    status: "active",
    start_date: "2026-03-02",
    end_date: "2026-08-28",
    budget_hours: 1120,
    blended: 258,
    fixed_fee_amount: 385_000,
    aiPolicy: "markup",
    aiMarkup: 0.18,
    description:
      "Match, merge and remediate 1.9m provider records against authoritative sources.",
  },
  {
    project_id: "pr_hhx_provider",
    code: "WS2",
    name: "Data stewardship enablement",
    status: "active",
    start_date: "2026-04-01",
    end_date: "2026-08-14",
    budget_hours: 420,
    blended: 232,
    fixed_fee_amount: 175_000,
    description:
      "Stewardship operating model, exception queues and ongoing quality reporting.",
  },
  // KTL-2026-05 (fixed fee)
  {
    project_id: "pr_ktl_care",
    code: "WS1",
    name: "Care assistant deployment",
    status: "active",
    start_date: "2026-04-06",
    end_date: "2026-09-25",
    budget_hours: 780,
    blended: 296,
    fixed_fee_amount: 305_000,
    description:
      "Assisted-response deployment across two contact centres, with quality and safety review.",
  },
  {
    project_id: "pr_ktl_care",
    code: "WS2",
    name: "Knowledge base rebuild",
    status: "active",
    start_date: "2026-04-20",
    end_date: "2026-09-11",
    budget_hours: 380,
    blended: 218,
    fixed_fee_amount: 145_000,
    description:
      "Consolidation and rewrite of 3,400 care articles into a retrieval-ready knowledge base.",
  },
  // BCR-2026-01
  {
    project_id: "pr_bcr_records",
    code: "WS1",
    name: "Records digitisation delivery",
    status: "active",
    start_date: "2026-01-05",
    end_date: "2026-07-31",
    budget_hours: 1340,
    blended: 224,
    description:
      "Ingestion, classification and indexing of the civil registry back-file.",
  },
  {
    project_id: "pr_bcr_records",
    code: "WS2",
    name: "Regulatory reporting & audit trail",
    status: "active",
    start_date: "2026-02-16",
    end_date: "2026-07-31",
    budget_hours: 520,
    blended: 240,
    description:
      "Statutory reporting pack, retention rules and end-to-end audit trail for digitised records.",
  },
  {
    project_id: "pr_bcr_records",
    code: "WS3",
    name: "Change & enablement",
    status: "complete",
    start_date: "2026-01-19",
    end_date: "2026-06-30",
    budget_hours: 310,
    blended: 212,
    description:
      "Counter-staff process redesign and training for the digitised records workflow.",
  },
];

const workstreams = WS_DEFS.map((w, i) => ({
  id: `ws_${w.project_id.slice(3)}_${w.code.toLowerCase()}`,
  project_id: w.project_id,
  code: w.code,
  name: w.name,
  lead_consultant_id: null,
  status: w.status,
  start_date: w.start_date,
  end_date: w.end_date,
  budget_hours: w.budget_hours,
  budget_amount: Math.round((w.budget_hours * w.blended) / 500) * 500,
  // Kept so the budget calibration below can re-derive the amount after it has
  // seen how many hours were actually generated.
  _blended: w.blended,
  fixed_fee_amount: w.fixed_fee_amount ?? null,
  ai_policy: w.aiPolicy ?? null,
  ai_markup_pct: w.aiPolicy ? (w.aiMarkup ?? 0) : null,
  description: w.description,
  _hardest: w.hardest === true,
  _pinnedModel: w.pinnedModel ?? null,
  _index: i,
}));

const wsById = new Map(workstreams.map((w) => [w.id, w]));
const wsByProject = new Map();
for (const w of workstreams) {
  const list = wsByProject.get(w.project_id);
  if (list) list.push(w);
  else wsByProject.set(w.project_id, [w]);
}

// ── Rate cards ──────────────────────────────────────────────────────────────

const rateCards = [];
for (const p of PROJECTS) {
  for (const grade of Object.keys(GRADE_RATES)) {
    const delta = randRange(-0.12, 0.12);
    const bill = Math.round((GRADE_RATES[grade].bill * (1 + delta)) / 5) * 5;
    rateCards.push({
      id: `rc_${p.id.slice(3)}_${grade}`,
      project_id: p.id,
      grade,
      bill_rate: bill,
      cost_rate: Math.round(bill * 0.42),
      currency: "USD",
      effective_from: p.start_date,
    });
  }
}

const rateCardsByProject = new Map();
for (const rc of rateCards) {
  const list = rateCardsByProject.get(rc.project_id);
  if (list) list.push(rc);
  else rateCardsByProject.set(rc.project_id, [rc]);
}

// ── Staffing ────────────────────────────────────────────────────────────────

/**
 * Each project draws a fixed grade mix from global, rotating grade pools. With
 * three partners and eight projects the pools necessarily overlap, so several
 * consultants end up on two clients — which is exactly what the untagged-usage
 * allocation needs in order to be interesting.
 */
const POOL_MIX = [
  ["partner", 1],
  ["principal", 1],
  ["manager", 2],
  ["senior_consultant", 3],
  ["consultant", 2],
  ["analyst", 1],
];

const gradeCursor = {};
for (const g of Object.keys(GRADE_RATES)) gradeCursor[g] = 0;

const poolByProject = new Map();
for (const p of PROJECTS) {
  const pool = [];
  for (const [grade, n] of POOL_MIX) {
    const list = byGrade[grade];
    for (let k = 0; k < n; k++) {
      pool.push(list[gradeCursor[grade] % list.length]);
      gradeCursor[grade] += 1;
    }
  }
  poolByProject.set(p.id, pool);
}

const assignments = [];
for (const ws of workstreams) {
  const pool = poolByProject.get(ws.project_id) ?? [];
  const n = Math.min(pool.length, randInt(4, 7));
  const members = shuffled(pool).slice(0, n);

  // Lead is the most senior non-partner on the workstream; partners sponsor,
  // they do not run delivery.
  let lead = null;
  for (const m of members) {
    if (m.grade === "partner") continue;
    if (!lead || GRADE_RANK[m.grade] < GRADE_RANK[lead.grade]) lead = m;
  }
  ws.lead_consultant_id = (lead ?? members[0] ?? null)?.id ?? null;

  for (const m of members) {
    let alloc;
    if (m.grade === "partner") alloc = pick([20, 20, 30]);
    else if (m.grade === "principal") alloc = pick([30, 40, 50]);
    else if (m.grade === "manager") alloc = pick([50, 60, 70, 80]);
    else alloc = pick([60, 70, 80, 90, 100]);

    assignments.push({
      id: `as_${ws.id.slice(3)}_${m.id.slice(3)}`,
      consultant_id: m.id,
      workstream_id: ws.id,
      allocation_pct: alloc,
      bill_rate_override: null,
      start_date: ws.start_date,
      end_date: ws.end_date,
    });
  }
}

// Two negotiated rates, deterministic by position so they are stable.
for (const idx of [11, 47]) {
  const a = assignments[idx % assignments.length];
  if (!a) continue;
  const c = consultantById.get(a.consultant_id);
  if (!c) continue;
  a.bill_rate_override = Math.round((c.default_bill_rate * 1.1) / 5) * 5;
}

const assignmentsByWs = new Map();
for (const a of assignments) {
  const list = assignmentsByWs.get(a.workstream_id);
  if (list) list.push(a);
  else assignmentsByWs.set(a.workstream_id, [a]);
}
const assignmentKey = (consultantId, wsId) => `${consultantId}|${wsId}`;
const assignmentIndex = new Map(
  assignments.map((a) => [assignmentKey(a.consultant_id, a.workstream_id), a]),
);

// ── Time entries ────────────────────────────────────────────────────────────

const ACTIVITY_NARRATIVES = {
  DELIV: [
    "Build and unit test of {ws} components",
    "Implemented reconciliation logic for {ws}",
    "Drafted target-state design for {ws}",
    "Pair build session on {ws} with client engineers",
    "Refactored ingestion pipeline within {ws}",
    "Configured environments for {ws} release candidate",
  ],
  WORKSHOP: [
    "Facilitated client working session on {ws}",
    "Requirements workshop with process owners — {ws}",
    "Design review workshop with client architects",
    "Stakeholder alignment session on {ws} scope",
  ],
  ANALYSIS: [
    "Data profiling and gap analysis for {ws}",
    "Cost and benefit modelling for {ws} options",
    "Reviewed source-system extracts supporting {ws}",
    "Analysed defect trends across {ws}",
  ],
  QA: [
    "Regression pack execution for {ws}",
    "Defect triage and retest — {ws}",
    "Reviewed test coverage for {ws} release",
    "Quality review of {ws} deliverable pack",
  ],
  PMO: [
    "Weekly delivery reporting and plan maintenance",
    "Risk and issue log review with delivery lead",
    "Resource plan update and forecast refresh",
    "Steering pack preparation for {ws}",
  ],
  TRAVEL: [
    "Travel to client site for {ws} workshops",
    "Return travel from client site",
    "Travel to plant walkthrough",
  ],
};

function activityFor(grade) {
  if (grade === "partner") {
    return pickWeighted([
      ["WORKSHOP", 4],
      ["PMO", 4],
      ["ANALYSIS", 2],
      ["TRAVEL", 1],
    ]);
  }
  if (grade === "principal" || grade === "manager") {
    return pickWeighted([
      ["DELIV", 5],
      ["WORKSHOP", 3],
      ["ANALYSIS", 3],
      ["PMO", 3],
      ["QA", 1],
      ["TRAVEL", 1],
    ]);
  }
  return pickWeighted([
    ["DELIV", 11],
    ["ANALYSIS", 3],
    ["QA", 3],
    ["WORKSHOP", 1],
    ["PMO", 1],
    ["TRAVEL", 0.5],
  ]);
}

function statusFor(workDate) {
  const m = monthOf(workDate);
  if (m === "2026-04" || m === "2026-05") return "invoiced";
  if (m === "2026-06") return chance(0.78) ? "invoiced" : "approved";
  // July is the open month: mostly approved, with a pending tail near the end.
  if (workDate >= "2026-07-16") {
    return pickWeighted([
      ["approved", 10],
      ["submitted", 1.1],
      ["draft", 0.8],
    ]);
  }
  return chance(0.99) ? "approved" : "submitted";
}

const timeEntries = [];
let teSeq = 0;

/**
 * A consultant split across several workstreams still only has one working day,
 * so their daily hours are shared out in proportion to allocation rather than
 * being generated per assignment in isolation.
 */
const allocTotalByConsultant = new Map();
for (const a of assignments) {
  allocTotalByConsultant.set(
    a.consultant_id,
    (allocTotalByConsultant.get(a.consultant_id) ?? 0) + a.allocation_pct,
  );
}
const WORKING_DAY_HOURS = 7.6;
/** Nobody bills more than this in a day, however many workstreams they touch. */
const DAY_CAP_HOURS = 9.5;
const dayTotals = new Map();

for (const ws of workstreams) {
  const from = maxDate(ws.start_date, SPAN_START);
  const to = minDate(ws.end_date, SPAN_END);
  if (from > to) continue;
  const days = weekdaysBetween(from, to);

  for (const a of assignmentsByWs.get(ws.id) ?? []) {
    const c = consultantById.get(a.consultant_id);
    if (!c) continue;
    const dayChance = 0.68 + (a.allocation_pct / 100) * 0.3;
    const share = a.allocation_pct / Math.max(allocTotalByConsultant.get(c.id) ?? 100, 100);
    const base = WORKING_DAY_HOURS * share;

    for (const day of days) {
      if (c.id === NO_JULY_HOURS && day >= "2026-07-01") continue;
      if (!chance(dayChance)) continue;

      const entries = chance(0.32) ? 2 : 1;
      let remaining = base;

      for (let k = 0; k < entries; k++) {
        const target =
          entries === 1 ? base * randRange(0.7, 1.25) : remaining * randRange(0.45, 0.7);
        const dayKey = `${c.id}|${day}`;
        const logged = dayTotals.get(dayKey) ?? 0;
        const headroom = Math.floor((DAY_CAP_HOURS - logged) * 2) / 2;
        if (headroom < 1.5) break;

        const hours = Math.min(8, headroom, Math.max(1.5, Math.round(target * 2) / 2));
        remaining = Math.max(1.5, remaining - hours);
        dayTotals.set(dayKey, logged + hours);

        const activity = activityFor(c.grade);
        const nonBillableChance = activity === "PMO" || activity === "TRAVEL" ? 0.33 : 0.008;
        const billable = chance(nonBillableChance) ? 0 : 1;
        const status = statusFor(day);
        const approved = status === "approved" || status === "invoiced";

        teSeq += 1;
        timeEntries.push({
          id: `te_${String(teSeq).padStart(6, "0")}`,
          consultant_id: c.id,
          workstream_id: ws.id,
          work_date: day,
          hours,
          billable,
          activity_code: activity,
          narrative: pick(ACTIVITY_NARRATIVES[activity]).replace("{ws}", ws.name),
          status,
          approved_by: approved ? pick(APPROVERS) : null,
          invoice_id: null,
        });
      }
    }
  }
}

// ── Calibrate budgets against the hours actually generated ──────────────────
//
// The hours above come out of allocation percentages, working-day caps and a
// calendar. A budget picked by hand independently of that has no relationship to
// it, and the first version of this seed proved it: eight of twenty-two
// workstreams landed between 115% and 258% of budget, so the dashboard flagged
// every engagement as over and read as broken rather than as a portfolio worth
// looking at.
//
// So the budget is derived from the hours, not guessed alongside them. For each
// workstream we know the hours logged and how far through its calendar it is, and
// we choose a target *pace* — budget consumed relative to schedule elapsed:
//
//   pace < 1      under-running: comfortable, reads "on budget"
//   pace ≈ 1.1    running hot: the engine's run-rate projection flags "watch"
//   pace > 1.25   genuinely over by the period end
//
//   budget = hours / (elapsed x pace)
//
// Buckets are assigned by workstream index, so the distribution is fixed run to
// run. Completed workstreams are always given a comfortable pace — a finished
// piece of work that blew its budget is a different (and rarer) story than one
// still running hot, and putting it in the demo just muddies the signal.
const BUDGET_PACE = [
  0.72, 0.8, 0.66, 0.9, 0.75, 0.84, 0.7, 0.88, 0.78, 0.68, 0.86, 0.74, 0.82, 0.64,
  1.08, 1.12, 1.06, 1.14, // watch
  1.34, 1.28, // over
  0.76, 0.7,
];

// Hours and billable value per workstream. The value is resolved through the same
// precedence the app uses (assignment override → project rate card → consultant
// default) and counts the same entries a statement would, so the budget is
// calibrated against the number the dashboard will actually show. Deriving the
// amount from a single blended rate instead leaves the two out of step: a
// senior-skewed team bills above blended, which pushed one workstream to 162% of
// budget while its hours were on plan.
const hoursByWs = new Map();
const valueByWs = new Map();
for (const t of timeEntries) {
  hoursByWs.set(t.workstream_id, (hoursByWs.get(t.workstream_id) ?? 0) + t.hours);
  if (t.billable !== 1) continue;
  if (t.status !== "approved" && t.status !== "invoiced") continue;
  const c = consultantById.get(t.consultant_id);
  const ws = wsById.get(t.workstream_id);
  if (!c || !ws) continue;
  const cards = rateCardsByProject.get(ws.project_id) ?? [];
  const value = t.hours * resolveBillRate(c, ws.id, cards, t.work_date);
  valueByWs.set(t.workstream_id, (valueByWs.get(t.workstream_id) ?? 0) + value);
}

for (const ws of workstreams) {
  const hours = hoursByWs.get(ws.id) ?? 0;
  if (hours === 0) continue; // nothing logged; the hand-set budget is as good as any

  const span = dayNum(ws.end_date) - dayNum(ws.start_date);
  const elapsedDays = dayNum(minDate(ws.end_date, SPAN_END)) - dayNum(ws.start_date);
  const elapsed = span <= 0 ? 1 : Math.min(1, Math.max(0.15, elapsedDays / span));

  const pace = ws.status === "complete" ? 0.82 : (BUDGET_PACE[ws._index] ?? 0.8);
  const consumed = elapsed * pace;

  // Rounded to numbers a budget would plausibly be written as.
  ws.budget_hours = Math.max(80, Math.round(hours / consumed / 20) * 20);
  const value = valueByWs.get(ws.id) ?? hours * ws._blended;
  ws.budget_amount = Math.max(20_000, Math.round(value / consumed / 500) * 500);
}

// consultant → date → workstream ids worked
const workedByConsultantDay = new Map();
for (const t of timeEntries) {
  const key = `${t.consultant_id}|${t.work_date}`;
  const set = workedByConsultantDay.get(key);
  if (set) set.add(t.workstream_id);
  else workedByConsultantDay.set(key, new Set([t.workstream_id]));
}

// ── Claude usage ────────────────────────────────────────────────────────────

const SURFACES = [
  ["claude_code", 62],
  ["api", 20],
  ["agent_sdk", 12],
  ["claude_ai_seat", 6],
];

function modelFor(ws) {
  if (ws && ws._pinnedModel && chance(0.55)) return ws._pinnedModel;
  const weights = [
    ["claude-opus-4-8", 38],
    ["claude-sonnet-5", 32],
    ["claude-haiku-4-5", 16],
    ["claude-sonnet-4-6", 7],
  ];
  if (ws && ws._hardest) weights.push(["claude-fable-5", 9]);
  return pickWeighted(weights);
}

/** Agentic shapes: cache reads dominate, output is small. */
function tokensFor(model, surface, mult) {
  const scale =
    (model === "claude-haiku-4-5" ? 0.55 : model === "claude-fable-5" ? 1.25 : 1) *
    (surface === "claude_ai_seat" ? 0.35 : surface === "api" ? 0.8 : 1) *
    mult;

  const inputTokens = Math.round(randRange(260_000, 1_150_000) * scale);
  const cacheReadTokens = Math.round(inputTokens * randRange(5, 20));
  const outputTokens = Math.round(inputTokens * randRange(0.05, 0.18));
  const cacheWriteTokens = Math.round(inputTokens * randRange(0.18, 0.9));
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

const usage = [];
let usageSeq = 0;

function pushUsage(consultantId, day, wsId, attribution, ws) {
  const adoption = MONTH_ADOPTION[monthOf(day)] ?? MONTH_ADOPTION["2026-07"];
  const model = modelFor(ws);
  const surface = pickWeighted(SURFACES);
  const t = tokensFor(model, surface, adoption.tokenMult);
  const cacheWriteTtl = chance(0.18) ? "1h" : "5m";
  const batch =
    model === "claude-haiku-4-5" && surface === "api"
      ? chance(0.45)
      : surface === "api"
        ? chance(0.06)
        : chance(0.01);

  const sessions = randInt(1, 4);
  const cost = costOf(RATES, model, day, {
    ...t,
    cacheWriteTtl,
    batch,
  });

  usageSeq += 1;
  usage.push({
    id: `cu_${String(usageSeq).padStart(6, "0")}`,
    consultant_id: consultantId,
    workstream_id: attribution === "unattributed" ? null : wsId,
    usage_date: day,
    model,
    surface,
    requests: sessions * randInt(9, 64),
    sessions,
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    cache_read_tokens: t.cacheReadTokens,
    cache_write_tokens: t.cacheWriteTokens,
    cache_write_ttl: cacheWriteTtl,
    batch: batch ? 1 : 0,
    cost_usd: cost,
    attribution,
    invoice_id: null,
  });
}

// Iterate consultant/day in a stable order so the PRNG stream is reproducible.
const usageDays = weekdaysBetween(SPAN_START, SPAN_END);
for (const c of consultants) {
  for (const day of usageDays) {
    const worked = workedByConsultantDay.get(`${c.id}|${day}`);
    const adoption = MONTH_ADOPTION[monthOf(day)] ?? MONTH_ADOPTION["2026-07"];

    if (!worked || worked.size === 0) {
      // The one consultant with July usage and no hours: untagged spend that
      // cannot be allocated to any engagement, which the residual must show.
      if (c.id === NO_JULY_HOURS && day >= "2026-07-01" && chance(0.8)) {
        pushUsage(c.id, day, null, "unattributed", null);
      }
      continue;
    }
    if (!chance(adoption.rowChance)) continue;

    const wsIds = [...worked];
    const rows = 1 + (chance(0.7) ? 1 : 0) + (chance(0.35) ? 1 : 0);
    for (let k = 0; k < rows; k++) {
      const wsId = wsIds[Math.min(Math.floor(rng() * wsIds.length), wsIds.length - 1)];
      const ws = wsId ? wsById.get(wsId) : undefined;
      const attribution = pickWeighted([
        ["tagged", 62],
        ["inferred", 26],
        ["unattributed", 12],
      ]);
      pushUsage(c.id, day, wsId ?? null, attribution, ws ?? null);
    }
  }
}

// ── Seats ───────────────────────────────────────────────────────────────────

const seats = [];
for (const c of consultants) {
  const plan = c.grade === "partner" || c.grade === "principal" ? "enterprise" : "team";
  for (const month of MONTHS) {
    seats.push({
      id: `se_${c.id.slice(3)}_${month.replace("-", "")}`,
      consultant_id: c.id,
      plan,
      month,
      monthly_cost: SEAT_COST[plan] ?? 30,
    });
  }
}

// ── Milestones (fixed-fee workstreams only) ─────────────────────────────────

const MILESTONE_SCHEDULE = [
  { due: "2026-04-30", status: "invoiced", share: 0.3 },
  { due: "2026-05-29", status: "invoiced", share: 0.25 },
  { due: "2026-06-30", status: "delivered", share: 0.25 },
  { due: "2026-07-31", status: "pending", share: 0.2 },
];

const MILESTONE_NAMES = [
  "Baseline established and remediation plan signed off",
  "First tranche delivered and accepted",
  "Second tranche delivered and accepted",
  "Final tranche and handover to run",
];

const milestones = [];
for (const ws of workstreams) {
  if (ws.fixed_fee_amount == null) continue;
  const count = randInt(3, 4);
  const schedule = MILESTONE_SCHEDULE.slice(4 - count);
  const shareTotal = sum(schedule.map((s) => s.share));
  schedule.forEach((s, i) => {
    if (s.due < ws.start_date) return;
    milestones.push({
      id: `ms_${ws.id.slice(3)}_${i + 1}`,
      workstream_id: ws.id,
      name: MILESTONE_NAMES[(4 - count + i) % MILESTONE_NAMES.length],
      due_date: s.due,
      amount: round2((ws.fixed_fee_amount * s.share) / shareTotal),
      status: s.status,
    });
  });
}

// ── Rate resolution (mirrors lib/billing.ts) ────────────────────────────────

function latestCard(cards, grade, date) {
  let best;
  for (const c of cards) {
    if (c.grade !== grade) continue;
    if (c.effective_from > date) continue;
    if (!best || c.effective_from > best.effective_from) best = c;
  }
  return best;
}

function resolveBillRate(consultant, wsId, cards, date) {
  const a = assignmentIndex.get(assignmentKey(consultant.id, wsId));
  if (a && a.bill_rate_override != null) return a.bill_rate_override;
  const card = latestCard(cards, consultant.grade, date);
  if (card) return card.bill_rate;
  return consultant.default_bill_rate;
}

function resolveCostRate(consultant, cards, date) {
  const card = latestCard(cards, consultant.grade, date);
  return card ? card.cost_rate : consultant.default_cost_rate;
}

function effectivePolicy(ws, project) {
  const policy = ws.ai_policy ?? project.ai_policy_default;
  const markupPct = ws.ai_markup_pct ?? project.ai_markup_pct_default;
  return { policy, markupPct: policy === "markup" ? markupPct : 0 };
}

// ── Invoices ────────────────────────────────────────────────────────────────

const GRADE_LABEL = {
  partner: "Partner",
  principal: "Principal",
  manager: "Manager",
  senior_consultant: "Senior Consultant",
  consultant: "Consultant",
  analyst: "Analyst",
};
const AI_POLICY_LABEL = {
  markup: "Rebilled with markup",
  at_cost: "Rebilled at cost",
  absorbed: "Absorbed by firm",
};
const MODEL_DISPLAY = {};
for (const r of RATES) MODEL_DISPLAY[r.model] = r.displayName;

const BILLABLE_STATUSES = new Set(["approved", "invoiced"]);

/** Assigned consultants per project — the untagged pool's membership test. */
const consultantsByProject = new Map();
for (const a of assignments) {
  const ws = wsById.get(a.workstream_id);
  if (!ws) continue;
  const set = consultantsByProject.get(ws.project_id);
  if (set) set.add(a.consultant_id);
  else consultantsByProject.set(ws.project_id, new Set([a.consultant_id]));
}

function periodOf(month) {
  return { start: `${month}-01`, end: MONTH_END[month] };
}

function globalHoursFor(period) {
  const out = new Map();
  for (const t of timeEntries) {
    if (t.work_date < period.start || t.work_date > period.end) continue;
    out.set(t.consultant_id, (out.get(t.consultant_id) ?? 0) + t.hours);
  }
  return out;
}

const invoices = [];
const invoiceLines = [];
const timeInvoiceAssignments = []; // [timeEntryId, invoiceId]
const usageInvoiceAssignments = [];

let invoiceSeq = 400;

for (const month of MONTHS) {
  const period = periodOf(month);
  const globalHours = globalHoursFor(period);
  const isComplete = COMPLETE_MONTHS.includes(month);

  for (const project of PROJECTS) {
    const client = CLIENTS.find((c) => c.id === project.client_id);
    if (!client) continue;
    const wss = wsByProject.get(project.id) ?? [];
    const wsIds = new Set(wss.map((w) => w.id));
    const cards = rateCardsByProject.get(project.id) ?? [];
    const projectConsultants = consultantsByProject.get(project.id) ?? new Set();

    const entries = timeEntries.filter(
      (t) =>
        wsIds.has(t.workstream_id) &&
        t.work_date >= period.start &&
        t.work_date <= period.end,
    );
    const attributedUsage = usage.filter(
      (u) =>
        u.workstream_id !== null &&
        wsIds.has(u.workstream_id) &&
        u.usage_date >= period.start &&
        u.usage_date <= period.end,
    );
    const untaggedUsage = usage.filter(
      (u) =>
        u.workstream_id === null &&
        projectConsultants.has(u.consultant_id) &&
        u.usage_date >= period.start &&
        u.usage_date <= period.end,
    );

    // Allocation of the untagged pool, per lib/billing.ts allocateUnattributed.
    const poolByConsultant = new Map();
    let poolCost = 0;
    for (const u of untaggedUsage) {
      poolByConsultant.set(
        u.consultant_id,
        (poolByConsultant.get(u.consultant_id) ?? 0) + u.cost_usd,
      );
      poolCost += u.cost_usd;
    }
    const hoursByConsultantWs = new Map();
    for (const t of entries) {
      let per = hoursByConsultantWs.get(t.consultant_id);
      if (!per) {
        per = new Map();
        hoursByConsultantWs.set(t.consultant_id, per);
      }
      per.set(t.workstream_id, (per.get(t.workstream_id) ?? 0) + t.hours);
    }
    const allocByWs = new Map();
    for (const [consultantId, cost] of poolByConsultant) {
      const per = hoursByConsultantWs.get(consultantId);
      const inScope = per ? sum([...per.values()]) : 0;
      const denominator = globalHours.get(consultantId) ?? inScope;
      if (denominator <= 0) continue;
      if (!per) continue;
      for (const [wsId, h] of per) {
        allocByWs.set(wsId, (allocByWs.get(wsId) ?? 0) + cost * (h / denominator));
      }
    }
    const shareByWs = new Map();
    if (poolCost > 0) {
      for (const [wsId, cost] of allocByWs) shareByWs.set(wsId, cost / poolCost);
    }

    const lines = [];
    let totalCost = 0;

    for (const ws of wss) {
      const { policy, markupPct } = effectivePolicy(ws, project);
      const absorbed = policy === "absorbed";

      // Labor by grade.
      const grades = new Map();
      for (const t of entries) {
        if (t.workstream_id !== ws.id) continue;
        const c = consultantById.get(t.consultant_id);
        if (!c) continue;
        const counts = t.billable === 1 && BILLABLE_STATUSES.has(t.status);
        const billRate = counts ? resolveBillRate(c, ws.id, cards, t.work_date) : 0;
        const costRate = resolveCostRate(c, cards, t.work_date);
        let acc = grades.get(c.grade);
        if (!acc) {
          acc = { hours: 0, billable: 0, cost: 0, rateWeighted: 0, costWeighted: 0 };
          grades.set(c.grade, acc);
        }
        acc.hours += t.hours;
        acc.billable += t.hours * billRate;
        acc.cost += t.hours * costRate;
        if (counts) acc.rateWeighted += t.hours;
        acc.costWeighted += t.hours;
      }

      const laborByGrade = [...grades.entries()]
        .map(([grade, acc]) => ({
          grade,
          hours: acc.hours,
          billRate: acc.rateWeighted > 0 ? acc.billable / acc.rateWeighted : 0,
          costRate: acc.costWeighted > 0 ? acc.cost / acc.costWeighted : 0,
          billable: round2(acc.billable),
          cost: round2(acc.cost),
        }))
        .sort((a, b) => b.billable - a.billable);

      for (const g of laborByGrade) {
        if (g.hours === 0) continue;
        lines.push({
          workstream_id: ws.id,
          kind: "labor",
          description: `Professional services — ${GRADE_LABEL[g.grade]}`,
          qty: round2(g.hours),
          unit: "hrs",
          unit_price: round2(g.billRate),
          amount: g.billable,
          meta: {
            cost: g.cost,
            margin: round2(g.billable - g.cost),
            marginPct: ratio(g.billable - g.cost, g.billable),
          },
        });
      }
      const laborCost = round2(sum(laborByGrade.map((g) => g.cost)));

      // Fixed-fee milestones landing in the period.
      const wsMilestones = milestones.filter(
        (m) =>
          m.workstream_id === ws.id &&
          m.status !== "pending" &&
          m.due_date >= period.start &&
          m.due_date <= period.end,
      );
      for (const m of wsMilestones) {
        lines.push({
          workstream_id: ws.id,
          kind: "fixed_fee",
          description: `Milestone — ${m.name}`,
          qty: 1,
          unit: "milestone",
          unit_price: round2(m.amount),
          amount: round2(m.amount),
          meta: {},
        });
      }

      // Claude usage by model.
      const models = new Map();
      let attributedCost = 0;
      for (const u of attributedUsage) {
        if (u.workstream_id !== ws.id) continue;
        attributedCost += u.cost_usd;
        let acc = models.get(u.model);
        if (!acc) {
          acc = { tokens: 0, requests: 0, cost: 0 };
          models.set(u.model, acc);
        }
        acc.tokens +=
          u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;
        acc.requests += u.requests;
        acc.cost += u.cost_usd;
      }

      const allocatedCost = allocByWs.get(ws.id) ?? 0;
      const aiTotalCost = attributedCost + allocatedCost;

      const byModel = [...models.entries()]
        .map(([model, acc]) => ({ model, ...acc }))
        .sort((a, b) => b.cost - a.cost);

      for (const m of byModel) {
        const mtok = m.tokens / 1_000_000;
        const billed = absorbed ? 0 : round2(m.cost * (1 + markupPct));
        lines.push({
          workstream_id: ws.id,
          kind: "ai_passthrough",
          description: `Claude platform usage — ${MODEL_DISPLAY[m.model] ?? m.model}`,
          qty: Math.round(mtok * 100) / 100,
          unit: "M tokens",
          unit_price: mtok > 0 ? round2(m.cost / mtok) : 0,
          amount: absorbed ? 0 : round2(m.cost),
          meta: {
            cost: round2(m.cost),
            note: absorbed
              ? `Absorbed under ${AI_POLICY_LABEL[policy].toLowerCase()} — not rebilled`
              : `${m.requests.toLocaleString("en-US")} requests`,
            margin: absorbed ? round2(-m.cost) : round2(billed - m.cost),
          },
        });
      }

      if (allocatedCost > 0) {
        lines.push({
          workstream_id: ws.id,
          kind: "ai_passthrough",
          description: "Claude platform usage — allocated share of untagged sessions",
          qty: Math.round((shareByWs.get(ws.id) ?? 0) * 1000) / 10,
          unit: "% of pool",
          unit_price: round2(allocatedCost),
          amount: absorbed ? 0 : round2(allocatedCost),
          meta: {
            cost: round2(allocatedCost),
            note: "Allocated pro-rata by hours logged by the same consultants",
          },
        });
      }

      if (policy === "markup" && markupPct > 0 && aiTotalCost > 0) {
        const markupAmount = round2(aiTotalCost * markupPct);
        lines.push({
          workstream_id: ws.id,
          kind: "ai_markup",
          description: `AI platform management fee (${Math.round(markupPct * 100)}%)`,
          qty: 1,
          unit: "fee",
          unit_price: markupAmount,
          amount: markupAmount,
          meta: { cost: 0, margin: markupAmount, marginPct: 1 },
        });
      }

      totalCost += round2(laborCost + aiTotalCost);
    }

    if (lines.length === 0) continue;

    invoiceSeq += 1;
    const id = `inv_${project.id.slice(3)}_${month.replace("-", "")}`;
    const number = `MA-2026-${String(invoiceSeq).padStart(4, "0")}`;
    const status = isComplete ? (month === "2026-06" ? "issued" : "paid") : "draft";
    const issued = isComplete ? MONTH_ISSUE[month] : null;
    const due = issued ? addDays(issued, client.payment_terms_days) : null;

    const byKind = (kind) =>
      round2(sum(lines.filter((l) => l.kind === kind).map((l) => l.amount)));
    const subtotalLabor = byKind("labor");
    const subtotalAi = byKind("ai_passthrough");
    const subtotalMarkup = byKind("ai_markup");
    const subtotalFixed = byKind("fixed_fee");
    const total = round2(subtotalLabor + subtotalAi + subtotalMarkup + subtotalFixed);

    invoices.push({
      id,
      project_id: project.id,
      number,
      period_start: period.start,
      period_end: period.end,
      status,
      issued_date: issued,
      due_date: due,
      currency: client.currency,
      subtotal_labor: subtotalLabor,
      subtotal_ai_cost: subtotalAi,
      ai_markup_amount: subtotalMarkup,
      subtotal_fixed_fee: subtotalFixed,
      discount_amount: 0,
      tax_rate: 0,
      tax_amount: 0,
      total,
      notes: `${project.code} — ${project.name}. PO ${project.po_number}. Cost to serve ${round2(
        totalCost,
      ).toFixed(2)} USD.`,
    });

    lines.forEach((l, i) => {
      invoiceLines.push({
        id: `il_${id.slice(4)}_${String(i + 1).padStart(3, "0")}`,
        invoice_id: id,
        workstream_id: l.workstream_id,
        kind: l.kind,
        sort: i + 1,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unit_price: l.unit_price,
        amount: l.amount,
        meta_json: JSON.stringify(l.meta ?? {}),
      });
    });

    // Only closed months carry an invoice link on the underlying rows.
    if (isComplete) {
      for (const t of entries) timeInvoiceAssignments.push([t.id, id]);
      for (const u of attributedUsage) usageInvoiceAssignments.push([u.id, id]);
    }
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

const settings = [
  ["firm_name", FIRM],
  ["firm_address", "18 Finsbury Circus, London EC2M 7EB, United Kingdom"],
  ["tax_rate", "0"],
  ["default_ai_markup_pct", "0.20"],
  ["unattributed_policy", "allocate_by_hours"],
  ["approver_name", "Alistair Vance"],
  ["data_generated_from", SPAN_START],
  ["data_generated_to", SPAN_END],
];

// ── Write ───────────────────────────────────────────────────────────────────

const force = process.argv.includes("--force");

mkdirSync(DATA_DIR, { recursive: true });

if (existsSync(DB_PATH)) {
  if (!force) {
    console.log(
      `data/ledger.db already exists — leaving it alone.\n` +
        `Re-run with --force to delete and rebuild it.`,
    );
    process.exit(0);
  }
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(SCHEMA_PATH, "utf8"));

function insertAll(table, columns, rows) {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`,
  );
  for (const row of rows) {
    stmt.run(...columns.map((c) => normalise(row[c])));
  }
  return rows.length;
}

function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

const modelPricingRows = RATES.map((r) => ({
  model: r.model,
  display_name: r.displayName,
  tier: r.tier,
  effective_from: r.effectiveFrom,
  input_per_mtok: r.inputPerMTok,
  output_per_mtok: r.outputPerMTok,
  cache_read_per_mtok: r.cacheReadPerMTok,
  cache_write_5m_per_mtok: r.cacheWrite5mPerMTok,
  cache_write_1h_per_mtok: r.cacheWrite1hPerMTok,
  note: r.note ?? "",
}));

db.exec("BEGIN");
try {
  insertAll(
    "clients",
    [
      "id",
      "name",
      "industry",
      "initials",
      "currency",
      "payment_terms_days",
      "billing_contact_name",
      "billing_contact_email",
      "region",
    ],
    CLIENTS,
  );

  insertAll(
    "consultants",
    [
      "id",
      "name",
      "email",
      "grade",
      "practice",
      "location",
      "initials",
      "default_bill_rate",
      "default_cost_rate",
      "active",
    ],
    consultants,
  );

  insertAll(
    "projects",
    [
      "id",
      "client_id",
      "code",
      "name",
      "status",
      "engagement_type",
      "start_date",
      "end_date",
      "contract_value",
      "currency",
      "engagement_partner",
      "delivery_lead",
      "po_number",
      "ai_policy_default",
      "ai_markup_pct_default",
    ],
    PROJECTS.map((p) => ({ ...p, currency: "USD" })),
  );

  insertAll(
    "workstreams",
    [
      "id",
      "project_id",
      "code",
      "name",
      "lead_consultant_id",
      "status",
      "start_date",
      "end_date",
      "budget_hours",
      "budget_amount",
      "fixed_fee_amount",
      "ai_policy",
      "ai_markup_pct",
      "description",
    ],
    workstreams,
  );

  insertAll(
    "rate_cards",
    ["id", "project_id", "grade", "bill_rate", "cost_rate", "currency", "effective_from"],
    rateCards,
  );

  insertAll(
    "assignments",
    [
      "id",
      "consultant_id",
      "workstream_id",
      "allocation_pct",
      "bill_rate_override",
      "start_date",
      "end_date",
    ],
    assignments,
  );

  insertAll(
    "milestones",
    ["id", "workstream_id", "name", "due_date", "amount", "status"],
    milestones,
  );

  insertAll("model_pricing", Object.keys(modelPricingRows[0]), modelPricingRows);

  insertAll(
    "time_entries",
    [
      "id",
      "consultant_id",
      "workstream_id",
      "work_date",
      "hours",
      "billable",
      "activity_code",
      "narrative",
      "status",
      "approved_by",
      "invoice_id",
    ],
    timeEntries,
  );

  insertAll(
    "claude_usage",
    [
      "id",
      "consultant_id",
      "workstream_id",
      "usage_date",
      "model",
      "surface",
      "requests",
      "sessions",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_ttl",
      "batch",
      "cost_usd",
      "attribution",
      "invoice_id",
    ],
    usage,
  );

  insertAll(
    "claude_seats",
    ["id", "consultant_id", "plan", "month", "monthly_cost"],
    seats,
  );

  insertAll(
    "invoices",
    [
      "id",
      "project_id",
      "number",
      "period_start",
      "period_end",
      "status",
      "issued_date",
      "due_date",
      "currency",
      "subtotal_labor",
      "subtotal_ai_cost",
      "ai_markup_amount",
      "subtotal_fixed_fee",
      "discount_amount",
      "tax_rate",
      "tax_amount",
      "total",
      "notes",
    ],
    invoices,
  );

  insertAll(
    "invoice_lines",
    [
      "id",
      "invoice_id",
      "workstream_id",
      "kind",
      "sort",
      "description",
      "qty",
      "unit",
      "unit_price",
      "amount",
      "meta_json",
    ],
    invoiceLines,
  );

  insertAll("settings", ["key", "value"], settings.map(([key, value]) => ({ key, value })));

  const linkTime = db.prepare("UPDATE time_entries SET invoice_id = ? WHERE id = ?");
  for (const [entryId, invoiceId] of timeInvoiceAssignments) linkTime.run(invoiceId, entryId);

  const linkUsage = db.prepare("UPDATE claude_usage SET invoice_id = ? WHERE id = ?");
  for (const [usageId, invoiceId] of usageInvoiceAssignments) linkUsage.run(invoiceId, usageId);

  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}

// ── Summary ─────────────────────────────────────────────────────────────────

const TABLES = [
  "clients",
  "consultants",
  "projects",
  "workstreams",
  "rate_cards",
  "assignments",
  "milestones",
  "time_entries",
  "claude_usage",
  "claude_seats",
  "model_pricing",
  "invoices",
  "invoice_lines",
  "settings",
];

function scalar(sql, params = []) {
  const row = db.prepare(sql).get(...params);
  if (!row) return null;
  const values = Object.values(row);
  return values.length > 0 ? values[0] : null;
}

const pad = (s, n) => String(s).padEnd(n);
const padNum = (s, n) => String(s).padStart(n);
const money = (n) => `$${Number(n ?? 0).toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

console.log(`\nBuilt ${path.relative(ROOT, DB_PATH)} — ${FIRM}`);
console.log(`Span ${SPAN_START} → ${SPAN_END}\n`);

console.log(`${pad("table", 16)}${padNum("rows", 9)}`);
console.log("-".repeat(25));
for (const t of TABLES) {
  console.log(`${pad(t, 16)}${padNum(scalar(`SELECT COUNT(*) c FROM ${t}`), 9)}`);
}

const monthCost = db
  .prepare(
    `SELECT substr(usage_date,1,7) m, COUNT(*) rows, SUM(cost_usd) cost
       FROM claude_usage GROUP BY m ORDER BY m`,
  )
  .all();
console.log(`\n${pad("month", 10)}${padNum("usage rows", 12)}${padNum("Claude cost", 16)}`);
console.log("-".repeat(38));
for (const r of monthCost) {
  console.log(`${pad(r.m, 10)}${padNum(r.rows, 12)}${padNum(money(r.cost), 16)}`);
}

const attribution = db
  .prepare(
    `SELECT attribution, COUNT(*) rows, SUM(cost_usd) cost FROM claude_usage
      GROUP BY attribution ORDER BY cost DESC`,
  )
  .all();
const totalUsageCost = scalar("SELECT SUM(cost_usd) FROM claude_usage") ?? 0;
console.log(
  `\n${pad("attribution", 14)}${padNum("rows", 8)}${padNum("cost", 16)}${padNum("share", 9)}`,
);
console.log("-".repeat(47));
for (const r of attribution) {
  const share = totalUsageCost > 0 ? (r.cost / totalUsageCost) * 100 : 0;
  console.log(
    `${pad(r.attribution, 14)}${padNum(r.rows, 8)}${padNum(money(r.cost), 16)}${padNum(
      `${share.toFixed(1)}%`,
      9,
    )}`,
  );
}

const pending = scalar(
  "SELECT COUNT(*) FROM time_entries WHERE status IN ('draft','submitted')",
);
const hours = scalar("SELECT SUM(hours) FROM time_entries") ?? 0;
const nonBillable = scalar("SELECT COUNT(*) FROM time_entries WHERE billable = 0") ?? 0;
const teCount = scalar("SELECT COUNT(*) FROM time_entries") ?? 1;
const invoiceTotal = scalar("SELECT SUM(total) FROM invoices") ?? 0;

const mismatched = db
  .prepare(
    `SELECT i.number, i.total, ROUND(COALESCE(l.s, 0), 2) lines
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) s FROM invoice_lines GROUP BY invoice_id) l
         ON l.invoice_id = i.id
      WHERE ABS(i.total - COALESCE(l.s, 0)) > 0.005`,
  )
  .all();

const unpricedZero = scalar(
  `SELECT COUNT(*) FROM claude_usage u
     WHERE (u.cost_usd IS NULL OR u.cost_usd <= 0)
       AND EXISTS (SELECT 1 FROM model_pricing p WHERE p.model = u.model)`,
);

console.log("\nsanity");
console.log("-".repeat(56));
console.log(`pending approvals (draft+submitted)   ${pending}`);
console.log(`logged hours                          ${hours.toFixed(1)}`);
console.log(
  `non-billable entries                  ${nonBillable} (${((nonBillable / teCount) * 100).toFixed(1)}%)`,
);
console.log(`total Claude cost                     ${money(totalUsageCost)}`);
console.log(`invoiced total (all periods)          ${money(invoiceTotal)}`);
console.log(`invoices whose lines ≠ total          ${mismatched.length}`);
console.log(`priced rows with null/zero cost       ${unpricedZero}`);

if (mismatched.length > 0) {
  for (const m of mismatched) {
    console.log(`  MISMATCH ${m.number}: total ${m.total} vs lines ${m.lines}`);
  }
  db.close();
  process.exitCode = 1;
} else {
  db.close();
}
