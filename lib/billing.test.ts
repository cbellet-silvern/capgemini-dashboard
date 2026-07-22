/**
 * Tests for the billing engine.
 *
 * Run with `npm test`. No test framework and no build step — Node strips the
 * types and a small resolver hook (scripts/ts-loader.mjs) handles the
 * extensionless imports, so these execute the real engine files unmodified.
 *
 * What is worth testing here is the arithmetic a client could dispute: rate
 * precedence, effective-dated pricing, the three rebilling policies, the
 * rounding invariant, and above all the untagged-usage allocation — the one
 * place where a naive implementation bills the same dollars to two clients.
 */

import assert from "node:assert/strict";

import {
  allocateUnattributed,
  buildStatement,
  computeBurn,
  computeProjectBilling,
  effectivePolicy,
  resolveBillRate,
  resolveCostRate,
  round2,
  sum,
  type BillingInput,
} from "./billing";
import { PricingBook } from "./pricing";
import type {
  AssignmentRow,
  ClaudeUsageRow,
  ClientRow,
  ConsultantRow,
  MilestoneRow,
  ModelPricingRow,
  Period,
  ProjectRow,
  RateCardRow,
  TimeEntryRow,
  WorkstreamRow,
} from "./types";

// ── Tiny runner ─────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.split("\n").join("\n    ")}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PERIOD: Period = { start: "2026-06-01", end: "2026-06-30" };

const CLIENT: ClientRow = {
  id: "cl_test",
  name: "Test Client",
  industry: "Testing",
  initials: "TC",
  currency: "USD",
  payment_terms_days: 30,
  billing_contact_name: "A Person",
  billing_contact_email: "ap@example.com",
  region: "North America",
};

function project(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "pr_test",
    client_id: CLIENT.id,
    code: "TC-2026-01",
    name: "Test Engagement",
    status: "active",
    engagement_type: "time_and_materials",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    contract_value: 1_000_000,
    currency: "USD",
    engagement_partner: "P Partner",
    delivery_lead: "D Lead",
    po_number: "PO-1",
    ai_policy_default: "markup",
    ai_markup_pct_default: 0.2,
    ...over,
  };
}

function workstream(over: Partial<WorkstreamRow> = {}): WorkstreamRow {
  return {
    id: "ws_1",
    project_id: "pr_test",
    code: "WS-01",
    name: "Test Workstream",
    lead_consultant_id: null,
    status: "active",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    budget_hours: 1000,
    budget_amount: 300_000,
    fixed_fee_amount: null,
    ai_policy: null,
    ai_markup_pct: null,
    description: "For tests",
    ...over,
  };
}

function consultant(over: Partial<ConsultantRow> = {}): ConsultantRow {
  return {
    id: "co_1",
    name: "Test Consultant",
    email: "tc@example.com",
    grade: "manager",
    practice: "Data & AI",
    location: "Chicago",
    initials: "TC",
    default_bill_rate: 300,
    default_cost_rate: 120,
    active: 1,
    ...over,
  };
}

function timeEntry(over: Partial<TimeEntryRow> = {}): TimeEntryRow {
  return {
    id: `te_${Math.abs(hashOf(JSON.stringify(over)))}`,
    consultant_id: "co_1",
    workstream_id: "ws_1",
    work_date: "2026-06-10",
    hours: 8,
    billable: 1,
    activity_code: "DELIV",
    narrative: "Work",
    status: "approved",
    approved_by: "P Partner",
    invoice_id: null,
    ...over,
  };
}

function usageRow(over: Partial<ClaudeUsageRow> = {}): ClaudeUsageRow {
  return {
    id: `cu_${Math.abs(hashOf(JSON.stringify(over)))}`,
    consultant_id: "co_1",
    workstream_id: "ws_1",
    usage_date: "2026-06-10",
    model: "claude-opus-4-8",
    surface: "claude_code",
    requests: 10,
    sessions: 2,
    input_tokens: 100_000,
    output_tokens: 20_000,
    cache_read_tokens: 800_000,
    cache_write_tokens: 50_000,
    cache_write_ttl: "5m",
    batch: 0,
    cost_usd: 1,
    attribution: "tagged",
    invoice_id: null,
    ...over,
  };
}

/** Deterministic id suffix, so fixture ids are stable across runs. */
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const PRICING_ROWS: ModelPricingRow[] = [
  {
    model: "claude-opus-4-8",
    display_name: "Claude Opus 4.8",
    tier: "opus",
    effective_from: "2026-01-01",
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_read_per_mtok: 0.5,
    cache_write_5m_per_mtok: 6.25,
    cache_write_1h_per_mtok: 10,
    note: "",
  },
  {
    model: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    tier: "sonnet",
    effective_from: "2026-01-01",
    input_per_mtok: 2,
    output_per_mtok: 10,
    cache_read_per_mtok: 0.2,
    cache_write_5m_per_mtok: 2.5,
    cache_write_1h_per_mtok: 4,
    note: "intro",
  },
  {
    model: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    tier: "sonnet",
    effective_from: "2026-09-01",
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_read_per_mtok: 0.3,
    cache_write_5m_per_mtok: 3.75,
    cache_write_1h_per_mtok: 6,
    note: "standard",
  },
];

const PRICING = new PricingBook(PRICING_ROWS);

function input(over: Partial<BillingInput> = {}): BillingInput {
  return {
    project: project(),
    client: CLIENT,
    workstreams: [workstream()],
    consultants: [consultant()],
    rateCards: [],
    assignments: [],
    timeEntries: [],
    usage: [],
    milestones: [],
    pricing: PRICING,
    period: PERIOD,
    ...over,
  };
}

// ── round2 ──────────────────────────────────────────────────────────────────

test("round2 rounds half away from zero, symmetrically", () => {
  assert.equal(round2(0), 0);
  assert.equal(round2(1234.5678), 1234.57);
  assert.equal(round2(-1234.5644), -1234.56);
  assert.equal(round2(2.5), 2.5);
});

test("round2 recovers a half that binary float stored slightly low", () => {
  // 1.005 is really 1.00499999999999989; 2.675 is 2.67499999999999982.
  // Both must still round up — losing a cent here is a real invoice defect.
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(-1.005), -1.01, "negatives must not round toward zero");
  assert.equal(round2(10_000.005), 10_000.01, "the nudge must scale with magnitude");
});

test("round2 does not promote a value that is genuinely below the half", () => {
  assert.equal(round2(1.00499), 1.0);
  assert.equal(round2(2.674), 2.67);
  assert.equal(round2(0.004), 0.0);
});

test("round2 does not return NaN for non-finite input", () => {
  assert.equal(round2(Number.NaN), 0);
  assert.equal(round2(Number.POSITIVE_INFINITY), 0);
});

test("sum of an empty list is 0, not NaN", () => {
  assert.equal(sum([]), 0);
});

// ── Pricing ─────────────────────────────────────────────────────────────────

test("rateOn picks the greatest effective_from at or before the date", () => {
  const before = PRICING.rateOn("claude-sonnet-5", "2026-08-31");
  const after = PRICING.rateOn("claude-sonnet-5", "2026-09-01");
  assert.equal(before?.input_per_mtok, 2, "August must still get introductory pricing");
  assert.equal(after?.input_per_mtok, 3, "September must get standard pricing");
});

test("a date before every rate row yields no rate, and cost 0 rather than a throw", () => {
  const tokens = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  assert.equal(PRICING.rateOn("claude-opus-4-8", "2025-12-31"), null);
  assert.equal(PRICING.cost("claude-opus-4-8", "2025-12-31", tokens), 0);
  assert.equal(
    PRICING.isUnpriced("claude-opus-4-8", "2025-12-31"),
    true,
    "a known model with no rate yet is still unpriced on that date",
  );
  assert.equal(PRICING.costOrNull("claude-opus-4-8", "2025-12-31", tokens), null);
});

test("an unknown model is reported unpriced and costs 0", () => {
  assert.equal(PRICING.isUnpriced("claude-nonexistent"), true);
  assert.equal(PRICING.isUnpriced("claude-nonexistent", "2026-06-10"), true);
  assert.equal(PRICING.isUnpriced("claude-opus-4-8"), false);
  assert.equal(PRICING.isUnpriced("claude-opus-4-8", "2026-06-10"), false);
  assert.equal(
    PRICING.cost("claude-nonexistent", "2026-06-10", {
      inputTokens: 5_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    0,
  );
});

test("a model priced only from a future date is unpriced for earlier usage", () => {
  // The silent-$0 case: the model is in the book, so "do we know this model" says
  // yes, while July usage prices at nothing and the revenue disappears with no
  // warning. Detection has to be per usage date, not per model.
  const tokens = {
    inputTokens: 100_000_000,
    outputTokens: 20_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 500_000,
  };
  assert.equal(PRICING.rateOn("claude-sonnet-5", "2026-06-10")?.input_per_mtok, 2);

  const future = new PricingBook([
    {
      model: "claude-opus-5",
      display_name: "Claude Opus 5",
      tier: "frontier",
      effective_from: "2026-08-01",
      input_per_mtok: 6,
      output_per_mtok: 30,
      cache_read_per_mtok: 0.6,
      cache_write_5m_per_mtok: 7.5,
      cache_write_1h_per_mtok: 12,
      note: "",
    },
  ]);

  assert.equal(future.rateOn("claude-opus-5", "2026-07-15"), null);
  assert.equal(
    future.isUnpriced("claude-opus-5", "2026-07-15"),
    true,
    "July usage has no applicable rate and must be reported as unpriced",
  );
  assert.equal(future.isUnpriced("claude-opus-5", "2026-08-15"), false);
  assert.equal(
    future.cost("claude-opus-5", "2026-07-15", tokens),
    0,
    "cost() must stay non-throwing — one bad row cannot take down a statement",
  );
  assert.equal(round2(future.cost("claude-opus-5", "2026-08-15", tokens)), 1203.75);
});

test("costOrNull tells a missing rate apart from a genuine zero", () => {
  const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const some = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(
    PRICING.costOrNull("claude-opus-4-8", "2026-06-10", none),
    0,
    "zero tokens at a known rate genuinely cost zero",
  );
  assert.equal(
    PRICING.costOrNull("claude-nonexistent", "2026-06-10", some),
    null,
    "no rate must not be reported as free",
  );
  assert.equal(PRICING.cost("claude-nonexistent", "2026-06-10", some), 0);
});

test("cost sums all four token buckets at their own rates", () => {
  // 1M input @5 + 1M output @25 + 1M cache-read @0.5 + 1M cache-write-5m @6.25
  const c = PRICING.cost("claude-opus-4-8", "2026-06-10", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });
  assert.equal(round2(c), 36.75);
});

test("the 1h cache-write rate is used when the ttl says so", () => {
  const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
  const w5 = PRICING.cost("claude-opus-4-8", "2026-06-10", base);
  const w1h = PRICING.cost("claude-opus-4-8", "2026-06-10", { ...base, cacheWriteTtl: "1h" });
  assert.equal(round2(w5), 6.25);
  assert.equal(round2(w1h), 10);
});

test("the batch flag halves the whole cost", () => {
  const t = { inputTokens: 2_000_000, outputTokens: 400_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const normal = PRICING.cost("claude-opus-4-8", "2026-06-10", t);
  const batched = PRICING.cost("claude-opus-4-8", "2026-06-10", { ...t, batch: true });
  assert.equal(round2(batched), round2(normal / 2));
});

// ── Rate resolution ─────────────────────────────────────────────────────────

test("bill rate falls back to the consultant default with no card and no override", () => {
  const c = consultant();
  assert.equal(resolveBillRate(c, "ws_1", [], [], "2026-06-10"), 300);
});

test("a project rate card beats the consultant default", () => {
  const c = consultant();
  const cards: RateCardRow[] = [
    {
      id: "rc_1",
      project_id: "pr_test",
      grade: "manager",
      bill_rate: 340,
      cost_rate: 130,
      currency: "USD",
      effective_from: "2026-01-01",
    },
  ];
  assert.equal(resolveBillRate(c, "ws_1", [], cards, "2026-06-10"), 340);
  assert.equal(resolveCostRate(c, cards, "2026-06-10"), 130);
});

test("rate cards are effective-dated and never applied before their date", () => {
  const c = consultant();
  const cards: RateCardRow[] = [
    { id: "a", project_id: "pr_test", grade: "manager", bill_rate: 320, cost_rate: 120, currency: "USD", effective_from: "2026-01-01" },
    { id: "b", project_id: "pr_test", grade: "manager", bill_rate: 360, cost_rate: 140, currency: "USD", effective_from: "2026-07-01" },
  ];
  assert.equal(resolveBillRate(c, "ws_1", [], cards, "2026-06-30"), 320);
  assert.equal(resolveBillRate(c, "ws_1", [], cards, "2026-07-01"), 360);
});

test("an assignment override beats the rate card", () => {
  const c = consultant();
  const cards: RateCardRow[] = [
    { id: "a", project_id: "pr_test", grade: "manager", bill_rate: 340, cost_rate: 130, currency: "USD", effective_from: "2026-01-01" },
  ];
  const assignments: AssignmentRow[] = [
    { id: "as_1", consultant_id: "co_1", workstream_id: "ws_1", allocation_pct: 100, bill_rate_override: 500, start_date: "2026-01-01", end_date: "2026-12-31" },
  ];
  assert.equal(resolveBillRate(c, "ws_1", assignments, cards, "2026-06-10"), 500);
  // The override is scoped to its workstream, not the consultant.
  assert.equal(resolveBillRate(c, "ws_other", assignments, cards, "2026-06-10"), 340);
});

test("a rate card for another grade is ignored", () => {
  const c = consultant({ grade: "analyst" });
  const cards: RateCardRow[] = [
    { id: "a", project_id: "pr_test", grade: "manager", bill_rate: 340, cost_rate: 130, currency: "USD", effective_from: "2026-01-01" },
  ];
  assert.equal(resolveBillRate(c, "ws_1", [], cards, "2026-06-10"), c.default_bill_rate);
});

// ── Policy inheritance ──────────────────────────────────────────────────────

test("a workstream with no policy inherits the project default", () => {
  const { policy, markupPct } = effectivePolicy(workstream(), project());
  assert.equal(policy, "markup");
  assert.equal(markupPct, 0.2);
});

test("a workstream policy overrides the project default", () => {
  const { policy, markupPct } = effectivePolicy(
    workstream({ ai_policy: "at_cost" }),
    project(),
  );
  assert.equal(policy, "at_cost");
  assert.equal(markupPct, 0, "at_cost must carry no markup even if one is configured");
});

test("absorbed carries no markup", () => {
  const { policy, markupPct } = effectivePolicy(
    workstream({ ai_policy: "absorbed", ai_markup_pct: 0.5 }),
    project(),
  );
  assert.equal(policy, "absorbed");
  assert.equal(markupPct, 0);
});

// ── Which hours reach a statement ───────────────────────────────────────────

test("only billable, approved-or-invoiced hours are billed; the rest still cost", () => {
  const b = computeProjectBilling(
    input({
      timeEntries: [
        timeEntry({ hours: 10, status: "approved", billable: 1 }),
        timeEntry({ hours: 10, status: "invoiced", billable: 1 }),
        timeEntry({ hours: 10, status: "submitted", billable: 1 }),
        timeEntry({ hours: 10, status: "draft", billable: 1 }),
        timeEntry({ hours: 10, status: "approved", billable: 0 }),
      ],
    }),
  );
  assert.equal(b.hours, 50, "all logged hours are counted as hours");
  assert.equal(b.billableHours, 20, "only approved+invoiced billable hours are billable");
  assert.equal(b.laborBillable, 20 * 300);
  assert.equal(b.laborCost, 50 * 120, "every logged hour carries cost, billable or not");
});

test("time entries outside the period are excluded", () => {
  const b = computeProjectBilling(
    input({
      timeEntries: [
        timeEntry({ hours: 8, work_date: "2026-05-31" }),
        timeEntry({ hours: 8, work_date: "2026-06-01" }),
        timeEntry({ hours: 8, work_date: "2026-06-30" }),
        timeEntry({ hours: 8, work_date: "2026-07-01" }),
      ],
    }),
  );
  assert.equal(b.billableHours, 16, "period bounds are inclusive on both ends");
});

test("non-billable hours do not dilute the reported grade bill rate", () => {
  const b = computeProjectBilling(
    input({
      timeEntries: [
        timeEntry({ hours: 10, billable: 1, status: "approved" }),
        timeEntry({ hours: 30, billable: 0, status: "approved" }),
      ],
    }),
  );
  const grade = b.workstreams[0]?.laborByGrade[0];
  assert.ok(grade, "expected one grade group");
  assert.equal(grade.billRate, 300, "rate must be weighted over billable hours only");
});

// ── AI policies ─────────────────────────────────────────────────────────────

function withUsageCost(cost: number, over: Partial<WorkstreamRow> = {}) {
  return input({
    workstreams: [workstream(over)],
    timeEntries: [timeEntry({ hours: 10 })],
    usage: [usageRow({ cost_usd: cost })],
  });
}

test("markup bills Claude cost plus the margin", () => {
  const ws = computeProjectBilling(withUsageCost(100)).workstreams[0];
  assert.ok(ws);
  assert.equal(ws.ai.totalCost, 100);
  assert.equal(ws.aiBillable, 120);
  assert.equal(ws.aiMargin, 20);
});

test("at_cost bills Claude cost exactly, for zero margin", () => {
  const ws = computeProjectBilling(withUsageCost(100, { ai_policy: "at_cost" })).workstreams[0];
  assert.ok(ws);
  assert.equal(ws.aiBillable, 100);
  assert.equal(ws.aiMargin, 0);
});

test("absorbed bills nothing and shows the cost as negative margin", () => {
  const ws = computeProjectBilling(withUsageCost(100, { ai_policy: "absorbed" })).workstreams[0];
  assert.ok(ws);
  assert.equal(ws.aiBillable, 0);
  assert.equal(ws.aiMargin, -100, "absorbing cost must show up as a margin hit, not vanish");
  assert.equal(ws.ai.totalCost, 100, "the cost is still incurred");
});

test("absorbed Claude cost is reported at project level", () => {
  const b = computeProjectBilling(withUsageCost(100, { ai_policy: "absorbed" }));
  assert.equal(b.aiAbsorbed, 100);
  assert.equal(b.aiBillable, 0);
  assert.equal(b.aiCost, 100);
});

test("margin and effective rate are computed, and are null rather than NaN when undefined", () => {
  const empty = computeProjectBilling(input());
  assert.equal(empty.totalBillable, 0);
  assert.equal(empty.marginPct, null, "no revenue must give null, never NaN");
  assert.equal(empty.effectiveRate, null);
  assert.equal(empty.aiCostShare, null);
});

// ── The allocation guard: the same dollars must not be billed twice ─────────

test("untagged usage is split by the consultant's GLOBAL hours, not per-project hours", () => {
  // One consultant, $100 untagged, 20h on client A and 30h on client B.
  const untagged = usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 100 });

  const aEntries = [timeEntry({ hours: 20, workstream_id: "ws_a" })];
  const bEntries = [timeEntry({ hours: 30, workstream_id: "ws_b" })];
  const global = { co_1: 50 };

  const a = allocateUnattributed([untagged], aEntries, PERIOD, new Set(["ws_a"]), global);
  const b = allocateUnattributed([untagged], bEntries, PERIOD, new Set(["ws_b"]), global);

  assert.equal(round2(a.byWorkstream.get("ws_a") ?? 0), 40);
  assert.equal(round2(b.byWorkstream.get("ws_b") ?? 0), 60);
  assert.equal(
    round2((a.byWorkstream.get("ws_a") ?? 0) + (b.byWorkstream.get("ws_b") ?? 0)),
    100,
    "the two projects together must absorb the pool exactly once",
  );
  assert.equal(round2(a.elsewhereCost), 60, "A must report B's share as belonging elsewhere");
  assert.equal(round2(b.elsewhereCost), 40);
});

test("without a global denominator each project would claim the whole pool — the bug this guards", () => {
  const untagged = usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 100 });
  const a = allocateUnattributed(
    [untagged],
    [timeEntry({ hours: 20, workstream_id: "ws_a" })],
    PERIOD,
    new Set(["ws_a"]),
  );
  assert.equal(
    round2(a.byWorkstream.get("ws_a") ?? 0),
    100,
    "documents why globalHoursByConsultant is required for single-project statements",
  );
});

test("untagged usage is split across a consultant's workstreams pro-rata by hours", () => {
  const untagged = usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 90 });
  const r = allocateUnattributed(
    [untagged],
    [
      timeEntry({ hours: 10, workstream_id: "ws_1" }),
      timeEntry({ hours: 20, workstream_id: "ws_2" }),
    ],
    PERIOD,
    new Set(["ws_1", "ws_2"]),
    { co_1: 30 },
  );
  assert.equal(round2(r.byWorkstream.get("ws_1") ?? 0), 30);
  assert.equal(round2(r.byWorkstream.get("ws_2") ?? 0), 60);
  assert.equal(round2(r.residualCost), 0);
});

test("usage with no logged hours anywhere becomes a reported residual, not someone's bill", () => {
  const untagged = usageRow({
    consultant_id: "co_ghost",
    workstream_id: null,
    attribution: "unattributed",
    cost_usd: 75,
  });
  const r = allocateUnattributed([untagged], [], PERIOD, new Set(["ws_1"]), {});
  assert.equal(round2(r.residualCost), 75);
  assert.equal(r.byWorkstream.size, 0, "nothing may be allocated without an hours basis");
  assert.equal(round2(r.poolCost), 75);
});

test("a consultant's untagged usage never reaches a workstream they logged no hours to", () => {
  const untagged = usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 50 });
  const r = allocateUnattributed(
    [untagged],
    [timeEntry({ hours: 8, workstream_id: "ws_1" })],
    PERIOD,
    new Set(["ws_1", "ws_untouched"]),
    { co_1: 8 },
  );
  assert.equal(r.byWorkstream.get("ws_untouched"), undefined);
  assert.equal(round2(r.byWorkstream.get("ws_1") ?? 0), 50);
});

test("tagged usage is not double-counted into the pool", () => {
  const r = allocateUnattributed(
    [usageRow({ cost_usd: 999, attribution: "tagged", workstream_id: "ws_1" })],
    [timeEntry({ hours: 8 })],
    PERIOD,
    new Set(["ws_1"]),
    { co_1: 8 },
  );
  assert.equal(r.poolCost, 0, "only workstream_id IS NULL rows form the pool");
});

test("usage outside the period is excluded from the pool", () => {
  const r = allocateUnattributed(
    [
      usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 10, usage_date: "2026-05-31" }),
      usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 20, usage_date: "2026-06-15" }),
    ],
    [timeEntry({ hours: 8 })],
    PERIOD,
    new Set(["ws_1"]),
    { co_1: 8 },
  );
  assert.equal(round2(r.poolCost), 20);
});

// ── Budget burn ─────────────────────────────────────────────────────────────

test("burn over budget is flagged over, regardless of schedule", () => {
  const ws = workstream({ budget_amount: 100_000, budget_hours: 400, start_date: "2026-01-01", end_date: "2026-12-31" });
  const burn = computeBurn(ws, { hours: 500, amount: 120_000 }, "2026-06-30");
  assert.equal(burn.risk, "over");
  assert.ok(burn.amountPct !== null && burn.amountPct > 1);
});

test("a run rate that projects an overrun is flagged watch before it happens", () => {
  const ws = workstream({ budget_amount: 100_000, start_date: "2026-01-01", end_date: "2026-12-31" });
  // Half the year gone, 70% of budget spent → projects ~140%.
  const burn = computeBurn(ws, { hours: 300, amount: 70_000 }, "2026-07-02");
  assert.equal(burn.risk, "watch");
  assert.ok(burn.projectedOverrun > 0);
});

test("on-pace burn is ok", () => {
  const ws = workstream({ budget_amount: 100_000, start_date: "2026-01-01", end_date: "2026-12-31" });
  const burn = computeBurn(ws, { hours: 200, amount: 48_000 }, "2026-07-02");
  assert.equal(burn.risk, "ok");
});

test("a completed workstream inside budget is ok even if it burned fast", () => {
  const ws = workstream({ status: "complete", budget_amount: 100_000, start_date: "2026-01-01", end_date: "2026-12-31" });
  const burn = computeBurn(ws, { hours: 300, amount: 90_000 }, "2026-03-01");
  assert.equal(burn.risk, "ok");
});

test("a zero-length workstream does not divide by zero", () => {
  const ws = workstream({ start_date: "2026-06-01", end_date: "2026-06-01", budget_amount: 1000 });
  const burn = computeBurn(ws, { hours: 1, amount: 100 }, "2026-06-01");
  assert.ok(Number.isFinite(burn.projectedAmount));
  assert.equal(burn.elapsedPct, 1);
});

test("a zero budget yields null percentages rather than Infinity", () => {
  const ws = workstream({ budget_amount: 0, budget_hours: 0 });
  const burn = computeBurn(ws, { hours: 5, amount: 500 }, "2026-06-30");
  assert.equal(burn.amountPct, null);
  assert.equal(burn.hoursPct, null);
  assert.equal(burn.risk, "ok", "no budget means nothing to be over");
});

// ── Statement construction ──────────────────────────────────────────────────

function statementFixture() {
  const consultants = [
    consultant({ id: "co_1", grade: "manager", default_bill_rate: 333.33, default_cost_rate: 141.11 }),
    consultant({ id: "co_2", grade: "analyst", default_bill_rate: 147.77, default_cost_rate: 61.13 }),
  ];
  const milestones: MilestoneRow[] = [
    { id: "ms_1", workstream_id: "ws_1", name: "Phase 1 sign-off", due_date: "2026-06-15", amount: 25_000, status: "delivered" },
    { id: "ms_2", workstream_id: "ws_1", name: "Phase 2 sign-off", due_date: "2026-08-15", amount: 25_000, status: "pending" },
  ];
  return input({
    consultants,
    milestones,
    timeEntries: [
      timeEntry({ consultant_id: "co_1", hours: 7.5 }),
      timeEntry({ consultant_id: "co_1", hours: 6.25, work_date: "2026-06-11" }),
      timeEntry({ consultant_id: "co_2", hours: 3.75 }),
    ],
    usage: [
      usageRow({ cost_usd: 12.3456, model: "claude-opus-4-8" }),
      usageRow({ cost_usd: 7.891, model: "claude-sonnet-5", usage_date: "2026-06-11" }),
      usageRow({ workstream_id: null, attribution: "unattributed", cost_usd: 4.4444 }),
    ],
    globalHoursByConsultant: { co_1: 13.75, co_2: 3.75 },
  });
}

test("statement subtotals equal the sum of the rendered, already-rounded lines", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-1" });
  const lineSum = round2(sum(s.groups.flatMap((g) => g.lines.map((l) => l.amount))));
  assert.equal(
    s.subtotal,
    lineSum,
    "a total that disagrees with its lines is the invoice bug this rounding order prevents",
  );
  const partSum = round2(
    s.subtotalLabor + s.subtotalAi + s.subtotalAiMarkup + s.subtotalFixedFee,
  );
  assert.equal(s.subtotal, partSum);
});

test("tax applies to the subtotal and the grand total is their sum", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-2", taxRate: 0.2 });
  assert.equal(s.taxAmount, round2(s.subtotal * 0.2));
  assert.equal(s.total, round2(s.subtotal + s.taxAmount));
});

test("group subtotals sum to the statement subtotal", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-3" });
  assert.equal(round2(sum(s.groups.map((g) => g.subtotal))), s.subtotal);
});

test("a delivered milestone in the period is billed; a pending future one is not", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-4" });
  const fees = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "fixed_fee");
  assert.equal(fees.length, 1);
  assert.equal(fees[0]?.amount, 25_000);
  assert.equal(s.subtotalFixedFee, 25_000);
});

test("the markup appears as its own line, not folded into the unit price", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-5" });
  const markup = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "ai_markup");
  assert.equal(markup.length, 1, "one explicit markup line per workstream with usage");
  const aiCost = s.groups[0]?.lines
    .filter((l) => l.kind === "ai_passthrough")
    .reduce((t, l) => t + (l.internal?.cost ?? 0), 0);
  assert.ok(aiCost && aiCost > 0);
  assert.equal(markup[0]?.amount, round2(aiCost * 0.2));
});

test("the allocated share of untagged usage is its own line, clearly labelled", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-6" });
  const allocated = s.groups
    .flatMap((g) => g.lines)
    .filter((l) => l.description.includes("untagged"));
  assert.equal(allocated.length, 1, "an estimate must never hide inside a metered line");
  assert.ok((allocated[0]?.amount ?? 0) > 0);
});

test("absorbed usage produces zero-amount lines that still carry their real cost", () => {
  const fixture = statementFixture();
  const s = buildStatement(
    { ...fixture, workstreams: [workstream({ ai_policy: "absorbed" })] },
    { invoiceNumber: "MA-TEST-7" },
  );
  const aiLines = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "ai_passthrough");
  assert.ok(aiLines.length > 0);
  for (const l of aiLines) {
    assert.equal(l.amount, 0, "the client is not charged");
    assert.ok((l.internal?.cost ?? 0) > 0, "but the firm's cost is still recorded");
  }
  assert.equal(s.subtotalAi, 0);
  assert.ok(s.absorbedAiCost > 0);
  assert.equal(
    s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "ai_markup").length,
    0,
    "absorbed usage cannot carry a markup line",
  );
});

test("the untagged pool balances, and says so on its own flag", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-8" });
  assert.equal(
    s.unattributedBalances,
    true,
    "every untagged dollar must be accounted for somewhere",
  );
});

test("the balance flag is exact, not a tolerance on rounded display figures", () => {
  // Three consultants whose shares each land on a half-cent, so the four
  // display fields round independently and their sum drifts off the pool. The
  // flag must still report balanced — this is exactly the false alarm that a
  // tolerance-based UI check produced on 11 of 32 real statements.
  const untagged = [0.005, 0.005, 0.005].map((c, i) =>
    usageRow({
      id: `cu_split_${i}`,
      consultant_id: `co_${i}`,
      workstream_id: null,
      attribution: "unattributed",
      cost_usd: c,
    }),
  );
  const entries = [0, 1, 2].map((i) =>
    timeEntry({ id: `te_split_${i}`, consultant_id: `co_${i}`, hours: 1 }),
  );
  const s = buildStatement(
    input({
      consultants: [0, 1, 2].map((i) => consultant({ id: `co_${i}` })),
      timeEntries: entries,
      usage: untagged,
      globalHoursByConsultant: { co_0: 1, co_1: 1, co_2: 1 },
    }),
    { invoiceNumber: "MA-TEST-8b" },
  );

  assert.equal(s.unattributedBalances, true, "the unrounded identity holds");
  // And demonstrate that the rounded fields alone would NOT have agreed, which
  // is why the flag exists rather than a comparison in the page.
  const roundedDrift = Math.abs(
    s.unattributedAllocatedCost +
      s.unattributedElsewhereCost +
      s.unattributedResidualCost -
      s.unattributedPoolCost,
  );
  assert.ok(
    roundedDrift < 0.02,
    `rounded drift should be sub-cent-ish, got ${roundedDrift}`,
  );
});

test("residual and elsewhere are distinguished, not merged", () => {
  // One consultant splits hours across two clients (→ elsewhere) while another
  // has usage and no hours at all (→ residual). Both must be reported, and
  // separately: they mean different things to whoever reads the panel.
  const s = buildStatement(
    input({
      consultants: [consultant({ id: "co_1" }), consultant({ id: "co_ghost" })],
      timeEntries: [timeEntry({ consultant_id: "co_1", hours: 10 })],
      usage: [
        usageRow({ id: "cu_x", consultant_id: "co_1", workstream_id: null, attribution: "unattributed", cost_usd: 100 }),
        usageRow({ id: "cu_y", consultant_id: "co_ghost", workstream_id: null, attribution: "unattributed", cost_usd: 40 }),
      ],
      globalHoursByConsultant: { co_1: 25 },
    }),
    { invoiceNumber: "MA-TEST-8c" },
  );
  assert.equal(s.unattributedPoolCost, 140);
  assert.equal(s.unattributedAllocatedCost, 40, "10 of the consultant's 25 hours are here");
  assert.equal(s.unattributedElsewhereCost, 60, "the other 15 hours are on other engagements");
  assert.equal(s.unattributedResidualCost, 40, "the consultant with no hours is unallocable");
  assert.equal(s.unattributedBalances, true);
});

test("every labour line multiplies out: qty x unitPrice equals amount", () => {
  // The client-facing check. A line that does not multiply out is the fastest way
  // to lose an argument about an invoice — and it happened: qty was total logged
  // hours while the rate and amount covered only billable, approved hours, so ten
  // of eleven lines on a real statement were wrong (one Partner line by $3,525).
  const s = buildStatement(
    input({
      consultants: [
        consultant({ id: "co_1", grade: "manager", default_bill_rate: 300 }),
        consultant({ id: "co_2", grade: "analyst", default_bill_rate: 150 }),
      ],
      timeEntries: [
        timeEntry({ id: "t1", consultant_id: "co_1", hours: 10, billable: 1, status: "approved" }),
        // These three carry cost but must not appear in the billed quantity.
        timeEntry({ id: "t2", consultant_id: "co_1", hours: 4, billable: 0, status: "approved" }),
        timeEntry({ id: "t3", consultant_id: "co_1", hours: 6, billable: 1, status: "submitted" }),
        timeEntry({ id: "t4", consultant_id: "co_2", hours: 8, billable: 1, status: "invoiced" }),
        timeEntry({ id: "t5", consultant_id: "co_2", hours: 3, billable: 0, status: "draft" }),
      ],
    }),
    { invoiceNumber: "MA-TEST-MULT" },
  );

  const labour = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "labor");
  assert.ok(labour.length >= 2, "expected a line per grade");
  for (const l of labour) {
    assert.equal(
      round2(l.qty * l.unitPrice),
      l.amount,
      `${l.description}: ${l.qty} x ${l.unitPrice} != ${l.amount}`,
    );
  }

  const manager = labour.find((l) => l.description.includes("Manager"));
  assert.ok(manager);
  assert.equal(manager.qty, 10, "only the billable approved hours are chargeable");
  assert.equal(manager.amount, 3000);
  assert.match(
    manager.internal?.note ?? "",
    /10 h logged but not charged/,
    "the 10 uncharged hours must still be visible internally",
  );
});

test("hours lines multiply out exactly; token lines within a cent", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-MULT2" });
  for (const l of s.groups.flatMap((g) => g.lines)) {
    if (l.amount === 0) continue; // absorbed lines are priced but not charged

    if (l.unit === "hrs") {
      // Both operands are clean 2dp values, so the product is exact — and this is
      // the line a client actually checks with a calculator.
      assert.equal(
        round2(l.qty * l.unitPrice),
        l.amount,
        `${l.description}: ${l.qty} x ${l.unitPrice} != ${l.amount}`,
      );
    } else if (l.unit === "M tokens") {
      // Cannot be exact, and pretending otherwise would be the wrong fix. The
      // amount is metered from raw token counts; the quantity is millions of
      // tokens rounded to 2dp and the unit price is a *derived* blend across four
      // token buckets (input, output, cache read, cache write) at 4dp. Rounding
      // two display values independently leaves the product up to a cent out.
      // The metered amount stays authoritative; the operands are shown so the
      // client can see the basis rather than a single opaque platform fee.
      const drift = round2(Math.abs(round2(l.qty * l.unitPrice) - l.amount));
      assert.ok(
        drift <= 0.01,
        `${l.description}: ${l.qty} ${l.unit} x ${l.unitPrice} is ${drift} off ${l.amount}`,
      );
    }
    // Fee and percentage-of-pool lines carry the amount in unitPrice with qty as a
    // share or a count, so there is no product to check.
  }
});

// ── The AI charge must be the sum of the AI lines ────────────────────────────

/**
 * Five models whose costs each carry a sub-cent tail. Rounding the aggregate
 * lands two cents away from the five rounded lines a statement prints.
 */
function multiModelInput(over: Partial<WorkstreamRow> = {}) {
  const costs = [128.135, 54.565, 4.655, 2.015, 21.585];
  return input({
    workstreams: [workstream(over)],
    timeEntries: [timeEntry({ hours: 8 })],
    usage: costs.map((c, i) =>
      usageRow({ id: `cu_model_${i}`, model: `model-${i}`, cost_usd: c }),
    ),
  });
}

function aiLinesOf(s: ReturnType<typeof buildStatement>): number {
  return round2(
    sum(
      s.groups
        .flatMap((g) => g.lines)
        .filter((l) => l.kind === "ai_passthrough" || l.kind === "ai_markup")
        .map((l) => l.amount),
    ),
  );
}

test("the AI charge is the sum of the rounded AI lines, not a rounded aggregate", () => {
  const inp = multiModelInput({ ai_policy: "at_cost" });
  const w = computeProjectBilling(inp).workstreams[0];
  assert.ok(w);
  // 128.14 + 54.57 + 4.66 + 2.02 + 21.59, each rounded on its own line.
  assert.equal(w.aiBillable, 210.98);
  assert.equal(
    round2(w.ai.totalCost),
    210.96,
    "rounding the 210.955 aggregate gives a figure the printed lines cannot produce",
  );
  assert.equal(aiLinesOf(buildStatement(inp, { invoiceNumber: "MA-AI-1" })), w.aiBillable);
});

test("the markup line is part of the AI total the workstream reports", () => {
  const inp = multiModelInput();
  const w = computeProjectBilling(inp).workstreams[0];
  assert.ok(w);
  // 210.98 of metered lines plus one rounded 20% fee on the unrounded cost.
  assert.equal(w.aiBillable, round2(210.98 + round2(w.ai.totalCost * 0.2)));
  assert.equal(w.aiBillable, 253.17);
  assert.equal(aiLinesOf(buildStatement(inp, { invoiceNumber: "MA-AI-2" })), w.aiBillable);
});

test("the allocated share is counted in the AI total exactly as its line rounds", () => {
  const inp = input({
    workstreams: [workstream({ ai_policy: "at_cost" })],
    timeEntries: [timeEntry({ hours: 8 })],
    usage: [
      usageRow({ id: "cu_tagged", cost_usd: 10.005 }),
      usageRow({
        id: "cu_pool",
        workstream_id: null,
        attribution: "unattributed",
        cost_usd: 4.445,
      }),
    ],
    globalHoursByConsultant: { co_1: 8 },
  });
  const w = computeProjectBilling(inp).workstreams[0];
  assert.ok(w);
  assert.equal(w.aiBillable, round2(10.01 + 4.45), "both lines round up, so the total does");
  assert.equal(aiLinesOf(buildStatement(inp, { invoiceNumber: "MA-AI-3" })), w.aiBillable);
});

test("absorbed usage still reports no AI charge under line-wise rounding", () => {
  const inp = multiModelInput({ ai_policy: "absorbed" });
  const w = computeProjectBilling(inp).workstreams[0];
  assert.ok(w);
  assert.equal(w.aiBillable, 0);
  assert.equal(w.aiMargin, round2(-w.ai.totalCost));
  assert.equal(aiLinesOf(buildStatement(inp, { invoiceNumber: "MA-AI-4" })), 0);
});

test("a group's subtotal equals the workstream total the dashboards print", () => {
  // The two paths that used to disagree: app/projects prints w.totalBillable,
  // the statement page foots the same workstream's lines to group.subtotal.
  for (const [name, inp] of [
    ["markup", multiModelInput()],
    ["at_cost", multiModelInput({ ai_policy: "at_cost" })],
    ["absorbed", multiModelInput({ ai_policy: "absorbed" })],
    ["fixture", statementFixture()],
  ] as const) {
    const billing = computeProjectBilling(inp);
    const s = buildStatement(inp, { invoiceNumber: `MA-AGREE-${name}` });
    for (const g of s.groups) {
      const w = billing.workstreams.find((x) => x.workstream.id === g.workstreamId);
      assert.ok(w, `${name}: no workstream for group ${g.workstreamId}`);
      assert.equal(
        g.subtotal,
        w.totalBillable,
        `${name}/${g.workstreamCode}: statement group ${g.subtotal} vs reported ${w.totalBillable}`,
      );
    }
    assert.equal(s.subtotal, billing.totalBillable, `${name}: project total vs statement`);
  }
});

// ── Fixed-fee lines exist because milestones exist ───────────────────────────

function milestoneInput(milestones: MilestoneRow[]) {
  return input({
    workstreams: [workstream({ ai_policy: "at_cost" })],
    milestones,
  });
}

function ms(over: Partial<MilestoneRow>): MilestoneRow {
  return {
    id: "ms_x",
    workstream_id: "ws_1",
    name: "Milestone",
    due_date: "2026-06-15",
    amount: 1000,
    status: "delivered",
    ...over,
  };
}

test("milestones whose fee rounds to zero still appear as lines", () => {
  const s = buildStatement(
    milestoneInput([
      ms({ id: "ms_a", name: "Kickoff", amount: 0.002 }),
      ms({ id: "ms_b", name: "Handover", amount: 0.002 }),
    ]),
    { invoiceNumber: "MA-MS-1" },
  );
  const fees = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "fixed_fee");
  assert.equal(fees.length, 2, "gating on rounded money silently dropped both lines");
  assert.equal(s.subtotalFixedFee, 0);
});

test("a credit note that cancels its milestone still prints both lines", () => {
  const s = buildStatement(
    milestoneInput([
      ms({ id: "ms_a", name: "Phase 1 delivery", amount: 40_000 }),
      ms({ id: "ms_b", name: "Phase 1 credit note", amount: -40_000 }),
    ]),
    { invoiceNumber: "MA-MS-2" },
  );
  const fees = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "fixed_fee");
  assert.equal(fees.length, 2, "$80,000 of movement must not vanish because it nets to zero");
  assert.deepEqual(
    fees.map((l) => l.amount),
    [40_000, -40_000],
  );
  assert.equal(s.subtotalFixedFee, 0);
});

test("a reported fixed fee is always itemised, and only qualifying milestones count", () => {
  const inp = milestoneInput([
    ms({ id: "ms_a", name: "In period, delivered", amount: 25_000 }),
    ms({ id: "ms_b", name: "In period, pending", amount: 9_000, status: "pending" }),
    ms({ id: "ms_c", name: "Out of period", amount: 7_000, due_date: "2026-07-15" }),
    ms({ id: "ms_d", name: "Another workstream", amount: 5_000, workstream_id: "ws_other" }),
  ]);
  const w = computeProjectBilling(inp).workstreams[0];
  const s = buildStatement(inp, { invoiceNumber: "MA-MS-3" });
  assert.ok(w);
  const fees = s.groups.flatMap((g) => g.lines).filter((l) => l.kind === "fixed_fee");
  assert.equal(fees.length, 1, "one qualifying milestone, one line");
  assert.equal(w.fixedFee, 25_000);
  assert.equal(
    round2(sum(fees.map((l) => l.amount))),
    w.fixedFee,
    "a fee the statement does not itemise is a fee nobody can check",
  );
});

// ── The printed quantity for hours ───────────────────────────────────────────

test("hours quantities are two decimals, and one decimal breaks the line", () => {
  // Quarter hours are what a part-approved day or a mid-period rate change leaves
  // behind. The engine's contract is a 2dp quantity; anything that prints it at
  // 1dp puts the product $15.50 away from the amount on this very line.
  const s = buildStatement(
    input({
      consultants: [consultant({ id: "co_1", grade: "manager", default_bill_rate: 310 })],
      timeEntries: [
        timeEntry({ id: "q1", hours: 7.25 }),
        timeEntry({ id: "q2", hours: 8, work_date: "2026-06-11" }),
        timeEntry({ id: "q3", hours: 8, work_date: "2026-06-12" }),
        timeEntry({ id: "q4", hours: 8, work_date: "2026-06-15" }),
      ],
    }),
    { invoiceNumber: "MA-QTY-1" },
  );
  const line = s.groups.flatMap((g) => g.lines).find((l) => l.unit === "hrs");
  assert.ok(line);
  assert.equal(line.qty, 31.25, "the quantity keeps the quarter hour");
  assert.equal(line.qty, round2(line.qty), "the contract is two decimals, no more");
  assert.equal(round2(line.qty * line.unitPrice), line.amount);
  assert.equal(line.amount, 9687.5);
  assert.equal(
    round2(Number(line.qty.toFixed(1)) * line.unitPrice),
    9703,
    "printing 31.3 hrs is the $15.50 regression a renderer must not reintroduce",
  );
});

test("no statement figure is ever NaN or Infinity", () => {
  const s = buildStatement(statementFixture(), { invoiceNumber: "MA-TEST-9", taxRate: 0.075 });
  const numbers: number[] = [
    s.subtotal, s.subtotalAi, s.subtotalAiMarkup, s.subtotalFixedFee, s.subtotalLabor,
    s.taxAmount, s.total, s.totalCost, s.margin, s.absorbedAiCost,
    s.unattributedPoolCost, s.unattributedAllocatedCost,
    ...s.groups.flatMap((g) => [g.subtotal, g.cost, g.margin]),
    ...s.groups.flatMap((g) => g.lines.flatMap((l) => [l.qty, l.unitPrice, l.amount])),
  ];
  for (const n of numbers) assert.ok(Number.isFinite(n), `non-finite value: ${n}`);
});

test("an empty statement is valid and totals zero", () => {
  const s = buildStatement(input(), { invoiceNumber: "MA-TEST-10" });
  assert.equal(s.total, 0);
  assert.equal(s.subtotal, 0);
  assert.equal(s.marginPct, null);
  assert.equal(s.groups.length, 1, "the workstream still appears, with no lines");
  assert.equal(s.groups[0]?.lines.length, 0);
});

// ── Report ──────────────────────────────────────────────────────────────────

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${total} billing-engine tests FAILED:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`\nbilling engine: ${passed}/${total} tests passed`);
