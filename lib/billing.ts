/**
 * The billing engine.
 *
 * Pure functions over rows. No database access, no I/O, no dates from the clock —
 * everything that varies is an argument, so the same inputs always produce the
 * same statement. That is what makes an invoice reproducible.
 *
 * Two decisions in here are worth knowing about:
 *
 * 1. Rounding. Money is rounded once, to cents, at the invoice line. Subtotals
 *    are the sum of already-rounded lines, so the total on the page always
 *    equals the lines on the page. Rounding a subtotal computed from unrounded
 *    parts is how invoices end up off by a cent and lose an argument.
 *
 * 2. Unattributed Claude usage. Usage that carried no workstream tag is
 *    allocated *per consultant*, across only the workstreams that consultant
 *    actually logged hours to in the period. Allocating it globally pro-rata
 *    would charge a client for a consultant who never touched their engagement.
 *    Anything still unallocable (a consultant with usage but no logged hours)
 *    is reported as a residual, never quietly absorbed into someone's bill.
 */

import type { PricingBook } from "./pricing";
import type {
  AiAllocation,
  AiByModel,
  BudgetBurn,
  ClaudeUsageRow,
  ClientRow,
  ConsultantRow,
  AssignmentRow,
  Grade,
  LaborByGrade,
  MilestoneRow,
  Period,
  ProjectBilling,
  ProjectRow,
  RateCardRow,
  RiskLevel,
  Statement,
  StatementGroup,
  StatementLine,
  TimeEntryRow,
  WorkstreamBilling,
  WorkstreamRow,
  AiPolicy,
} from "./types";
import { AI_POLICY_LABEL, GRADE_LABEL } from "./types";

// ── Small numeric helpers ────────────────────────────────────────────────────

/**
 * Round to cents, half away from zero — so -0.005 → -0.01, not -0.00.
 *
 * The nudge is not superstition. A decimal like 1.005 has no exact binary
 * representation: it is stored as 1.00499999999999989, so `Math.round(100.4999…)`
 * gives 100 and the cent is silently lost. `toFixed(2)` has the same flaw. The
 * correction has to be *relative* to the magnitude — a fixed `Number.EPSILON`
 * (2.2e-16) is orders of magnitude too small to bridge the gap at 100.5, let
 * alone at 100,000.5.
 *
 * Scaling epsilon by the value keeps the nudge proportional: big enough to
 * recover a true half, far too small to promote a value that is genuinely below
 * it (1.00499 still rounds to 1.00).
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const scaled = Math.abs(n) * 100;
  const nudge = Math.max(scaled * Number.EPSILON, Number.EPSILON) * 4;
  return (sign * Math.round(scaled + nudge)) / 100;
}

/**
 * Round to 4 decimals, for a *rate* rather than an amount.
 *
 * A blended Claude rate is a few dollars per million tokens, and a line can carry
 * hundreds of millions of tokens — so two decimals on the rate is not a display
 * nicety, it is an error multiplier. Rounding $1.2124/MTok to $1.21 and showing it
 * beside 198.03 M tokens puts the printed product $0.48 away from the printed
 * amount, and on the worst real line $1.69 away. Four decimals holds it to a cent.
 */
export function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const scaled = Math.abs(n) * 10_000;
  const nudge = Math.max(scaled * Number.EPSILON, Number.EPSILON) * 4;
  return (sign * Math.round(scaled + nudge)) / 10_000;
}

export function sum(ns: readonly number[]): number {
  let t = 0;
  for (const n of ns) t += n;
  return t;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Whole days from `a` to `b`, inclusive of neither end. Both ISO 'YYYY-MM-DD'. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return ms / 86_400_000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function inPeriod(date: string, period: Period): boolean {
  return date >= period.start && date <= period.end;
}

// ── Rate resolution ─────────────────────────────────────────────────────────

/**
 * Bill rate precedence, highest first:
 *   1. an explicit override on the consultant's assignment to this workstream
 *   2. the project's rate card for the consultant's grade, effective-dated
 *   3. the consultant's default rate
 */
export function resolveBillRate(
  consultant: ConsultantRow,
  workstreamId: string,
  assignments: readonly AssignmentRow[],
  rateCards: readonly RateCardRow[],
  date: string,
): number {
  const assignment = assignments.find(
    (a) => a.consultant_id === consultant.id && a.workstream_id === workstreamId,
  );
  if (assignment?.bill_rate_override != null) return assignment.bill_rate_override;

  const card = latestCard(rateCards, consultant.grade, date);
  if (card) return card.bill_rate;

  return consultant.default_bill_rate;
}

/** Cost rate has no per-assignment override — rate card, then the consultant default. */
export function resolveCostRate(
  consultant: ConsultantRow,
  rateCards: readonly RateCardRow[],
  date: string,
): number {
  const card = latestCard(rateCards, consultant.grade, date);
  return card ? card.cost_rate : consultant.default_cost_rate;
}

function latestCard(
  rateCards: readonly RateCardRow[],
  grade: Grade,
  date: string,
): RateCardRow | undefined {
  let best: RateCardRow | undefined;
  for (const c of rateCards) {
    if (c.grade !== grade) continue;
    if (c.effective_from > date) continue;
    if (!best || c.effective_from > best.effective_from) best = c;
  }
  return best;
}

// ── Engine input ────────────────────────────────────────────────────────────

/** Life-to-date totals per workstream, used for budget burn (which is not period-scoped). */
export interface LtdTotals {
  hours: number;
  amount: number;
}

export interface BillingInput {
  project: ProjectRow;
  client: ClientRow;
  workstreams: readonly WorkstreamRow[];
  consultants: readonly ConsultantRow[];
  rateCards: readonly RateCardRow[];
  assignments: readonly AssignmentRow[];
  /** Time entries for this project's workstreams. Filtered to `period` by the engine. */
  timeEntries: readonly TimeEntryRow[];
  /**
   * Claude usage relevant to this project: rows attributed to its workstreams,
   * plus unattributed rows for consultants who worked on it. Filtered to
   * `period` by the engine.
   */
  usage: readonly ClaudeUsageRow[];
  milestones: readonly MilestoneRow[];
  pricing: PricingBook;
  period: Period;
  /**
   * Each consultant's total logged hours in the period across *all* projects.
   * The denominator for allocating untagged Claude usage — see
   * `allocateUnattributed`. Required for correct single-project statements.
   */
  globalHoursByConsultant?: Readonly<Record<string, number>>;
  /** Life-to-date burn per workstream id. Falls back to period totals when absent. */
  ltd?: Readonly<Record<string, LtdTotals>>;
  /** Date the projection is made from. Defaults to `period.end`. */
  asOf?: string;
  /** Only count entries in these statuses as billable. Default: approved + invoiced. */
  billableStatuses?: readonly TimeEntryRow["status"][];
}

// ── Charges that appear both as a workstream figure and as a statement line ──
//
// Each of these is the single place its cents are decided. A workstream's total
// and the lines a statement prints have to be the same money; computing them
// twice from the same inputs is how they drift a cent apart.

/**
 * The milestones a period bills: this workstream's, delivered or invoiced, and
 * due inside the period. One list, used both to total the fixed fee and to emit
 * the lines — so a workstream can never report a fee the statement does not
 * itemise, nor drop an itemised milestone because the fee rounded to zero.
 */
function billableMilestones(
  milestones: readonly MilestoneRow[],
  workstreamId: string,
  period: Period,
): MilestoneRow[] {
  return milestones.filter(
    (m) =>
      m.workstream_id === workstreamId &&
      m.status !== "pending" &&
      inPeriod(m.due_date, period),
  );
}

/**
 * The metered Claude charge: one already-rounded line per model plus the rounded
 * allocated share, then summed. Deliberately not `round2(totalCost)` — the
 * statement prints those lines separately, and a total that is not the sum of
 * its own printed lines is the failure the rounding rule exists to prevent.
 */
function aiPassthroughCharge(
  policy: AiPolicy,
  aiByModel: readonly AiByModel[],
  allocatedCost: number,
): number {
  if (policy === "absorbed") return 0;
  return round2(sum(aiByModel.map((m) => round2(m.cost))) + round2(allocatedCost));
}

/** Whether this workstream carries an explicit AI markup line at all. */
function chargesAiMarkup(policy: AiPolicy, markupPct: number, aiTotalCost: number): boolean {
  return policy === "markup" && markupPct > 0 && aiTotalCost > 0;
}

/** The markup line's amount, rounded once here so both callers see the same cents. */
function aiMarkupCharge(policy: AiPolicy, markupPct: number, aiTotalCost: number): number {
  return chargesAiMarkup(policy, markupPct, aiTotalCost) ? round2(aiTotalCost * markupPct) : 0;
}

/** A workstream's effective AI policy, after inheriting from the project. */
export function effectivePolicy(
  ws: WorkstreamRow,
  project: ProjectRow,
): { policy: AiPolicy; markupPct: number } {
  const policy = ws.ai_policy ?? project.ai_policy_default;
  const markupPct = ws.ai_markup_pct ?? project.ai_markup_pct_default;
  return { policy, markupPct: policy === "markup" ? markupPct : 0 };
}

// ── Unattributed allocation ─────────────────────────────────────────────────

export interface AllocationResult {
  /** Allocated cost by workstream id (only workstreams in `workstreamIds`). */
  byWorkstream: Map<string, number>;
  /** Share of the pool by workstream id, 0..1. */
  shareByWorkstream: Map<string, number>;
  /** Total unattributed cost in the period for the consultants considered. */
  poolCost: number;
  /** Pool cost with no hours anywhere to hang it on — genuinely unallocable. */
  residualCost: number;
  /**
   * Pool cost that belongs to workstreams outside `workstreamIds` — i.e. the
   * consultant's other engagements. Not this project's to bill, but shown so
   * the pool visibly adds up.
   */
  elsewhereCost: number;
}

/**
 * Spreads unattributed usage across workstreams, one consultant at a time.
 * A consultant's untagged Claude cost is divided by the hours that same
 * consultant logged in the period — so it only ever reaches engagements they
 * actually worked on.
 *
 * `globalHoursByConsultant` is the denominator: the consultant's total logged
 * hours in the period across *every* project, not just this one. Without it, a
 * consultant who splits their week across two clients would have their whole
 * untagged spend billed to each client in turn — the same dollars charged
 * twice. Callers computing a single project must pass it.
 */
export function allocateUnattributed(
  usage: readonly ClaudeUsageRow[],
  timeEntries: readonly TimeEntryRow[],
  period: Period,
  workstreamIds: ReadonlySet<string>,
  globalHoursByConsultant?: Readonly<Record<string, number>>,
): AllocationResult {
  const poolByConsultant = new Map<string, number>();
  let poolCost = 0;

  for (const u of usage) {
    if (u.workstream_id !== null) continue;
    if (!inPeriod(u.usage_date, period)) continue;
    poolByConsultant.set(
      u.consultant_id,
      (poolByConsultant.get(u.consultant_id) ?? 0) + u.cost_usd,
    );
    poolCost += u.cost_usd;
  }

  // hours[consultantId][workstreamId]
  const hours = new Map<string, Map<string, number>>();
  for (const t of timeEntries) {
    if (!inPeriod(t.work_date, period)) continue;
    if (!workstreamIds.has(t.workstream_id)) continue;
    let perWs = hours.get(t.consultant_id);
    if (!perWs) {
      perWs = new Map();
      hours.set(t.consultant_id, perWs);
    }
    perWs.set(t.workstream_id, (perWs.get(t.workstream_id) ?? 0) + t.hours);
  }

  const byWorkstream = new Map<string, number>();
  let residualCost = 0;
  let elsewhereCost = 0;

  for (const [consultantId, cost] of poolByConsultant) {
    const perWs = hours.get(consultantId);
    const inScopeHours = perWs ? sum([...perWs.values()]) : 0;
    // Denominator: the consultant's hours everywhere, so the same untagged
    // dollars are never billed to two clients.
    const denominator = globalHoursByConsultant?.[consultantId] ?? inScopeHours;

    if (denominator <= 0) {
      residualCost += cost;
      continue;
    }

    if (perWs) {
      for (const [wsId, h] of perWs) {
        byWorkstream.set(wsId, (byWorkstream.get(wsId) ?? 0) + cost * (h / denominator));
      }
    }
    // Whatever the in-scope workstreams did not claim belongs to this
    // consultant's other engagements.
    const claimed = cost * (inScopeHours / denominator);
    elsewhereCost += cost - claimed;
  }

  const shareByWorkstream = new Map<string, number>();
  if (poolCost > 0) {
    for (const [wsId, cost] of byWorkstream) {
      shareByWorkstream.set(wsId, cost / poolCost);
    }
  }

  return { byWorkstream, shareByWorkstream, poolCost, residualCost, elsewhereCost };
}

// ── Budget burn ─────────────────────────────────────────────────────────────

export function computeBurn(
  ws: WorkstreamRow,
  used: LtdTotals,
  asOf: string,
): BudgetBurn {
  const span = daysBetween(ws.start_date, ws.end_date);
  const elapsed = span <= 0 ? 1 : clamp(daysBetween(ws.start_date, asOf) / span, 0, 1);

  const hoursPct = ratio(used.hours, ws.budget_hours);
  const amountPct = ratio(used.amount, ws.budget_amount);

  // Run-rate projection. The floor on elapsed stops week-one noise from
  // projecting a 20x overrun.
  const projectedAmount = used.amount / Math.max(elapsed, 0.1);
  const projectedOverrun = projectedAmount - ws.budget_amount;

  let risk: RiskLevel = "ok";
  let riskReason = "Tracking within budget.";

  if (ws.budget_amount > 0 && used.amount > ws.budget_amount) {
    risk = "over";
    riskReason = `Budget exceeded — ${fmtPctLocal(amountPct)} of budget consumed.`;
  } else if (ws.status === "complete") {
    risk = "ok";
    riskReason = "Complete, within budget.";
  } else if (ws.budget_amount > 0 && projectedOverrun > ws.budget_amount * 0.05) {
    risk = "watch";
    riskReason = `Run rate projects ${fmtPctLocal(
      projectedOverrun / ws.budget_amount,
    )} over budget by ${ws.end_date}.`;
  } else if (amountPct != null && amountPct - elapsed > 0.15) {
    risk = "watch";
    riskReason = `Burning ahead of schedule — ${fmtPctLocal(
      amountPct,
    )} of budget at ${fmtPctLocal(elapsed)} elapsed.`;
  }

  return {
    budgetHours: ws.budget_hours,
    budgetAmount: ws.budget_amount,
    hoursUsed: used.hours,
    amountUsed: used.amount,
    hoursPct,
    amountPct,
    elapsedPct: elapsed,
    projectedAmount,
    projectedOverrun,
    risk,
    riskReason,
  };
}

/** Local, dependency-free percent formatter for the risk sentences above. */
function fmtPctLocal(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

// ── Per-workstream computation ──────────────────────────────────────────────

/**
 * The statuses a client can be charged for. Exported so a screen quoting a
 * "billable hours" figure uses the engine's own set rather than a second copy
 * that can drift away from what the invoice actually bills.
 */
export const DEFAULT_BILLABLE_STATUSES: readonly TimeEntryRow["status"][] = [
  "approved",
  "invoiced",
];

export function computeWorkstreamBilling(
  ws: WorkstreamRow,
  input: BillingInput,
  allocation: AllocationResult,
): WorkstreamBilling {
  const { project, consultants, assignments, rateCards, pricing, period } = input;
  const billableStatuses = input.billableStatuses ?? DEFAULT_BILLABLE_STATUSES;
  const asOf = input.asOf ?? period.end;
  const { policy, markupPct } = effectivePolicy(ws, project);

  const byId = new Map(consultants.map((c) => [c.id, c]));

  // ── Labor, grouped by grade AND rate ──
  //
  // Grouping by grade alone is not enough. Two consultants at the same grade can
  // bill at different rates — an assignment override, or a rate card that changed
  // mid-period — and a single line showing their blended average does not
  // reproduce its own amount (15 h at a 303.33 average of 300 and 310 comes to
  // 4,549.95, not 4,550). An invoice line represents one rate; where a grade has
  // two rates in the period, that is genuinely two lines.
  interface GradeAcc {
    grade: Grade;
    rate: number;
    hours: number;
    billable: number;
    cost: number;
    rateWeighted: number;
    costWeighted: number;
    consultantIds: Set<string>;
  }
  const grades = new Map<string, GradeAcc>();

  let hours = 0;
  let billableHours = 0;
  let nonBillableHours = 0;

  for (const t of input.timeEntries) {
    if (t.workstream_id !== ws.id) continue;
    if (!inPeriod(t.work_date, period)) continue;
    const consultant = byId.get(t.consultant_id);
    if (!consultant) continue;

    hours += t.hours;

    const counts = t.billable === 1 && billableStatuses.includes(t.status);
    if (counts) billableHours += t.hours;
    else nonBillableHours += t.hours;

    const billRate = counts
      ? resolveBillRate(consultant, ws.id, assignments, rateCards, t.work_date)
      : 0;
    const costRate = resolveCostRate(consultant, rateCards, t.work_date);

    // Non-billable hours have no rate of their own; they ride with the grade's
    // billed rate so their cost lands on the same line rather than inventing a
    // zero-rate one.
    const groupRate = counts
      ? billRate
      : resolveBillRate(consultant, ws.id, assignments, rateCards, t.work_date);
    const key = `${consultant.grade}|${round2(groupRate)}`;

    let acc = grades.get(key);
    if (!acc) {
      acc = {
        grade: consultant.grade,
        rate: round2(groupRate),
        hours: 0,
        billable: 0,
        cost: 0,
        rateWeighted: 0,
        costWeighted: 0,
        consultantIds: new Set(),
      };
      grades.set(key, acc);
    }
    // Non-billable hours still carry cost, but must not dilute the bill rate,
    // so they are excluded from the rate-weighting numerator and denominator.
    acc.hours += t.hours;
    acc.billable += t.hours * billRate;
    acc.cost += t.hours * costRate;
    if (counts) acc.rateWeighted += t.hours;
    acc.costWeighted += t.hours;
    acc.consultantIds.add(consultant.id);
  }

  const laborByGrade: LaborByGrade[] = [...grades.values()]
    .map((acc) => ({
      grade: acc.grade,
      hours: acc.hours,
      // acc.rateWeighted accumulates only the hours that counted as billable, so
      // it is both the rate denominator and the invoiceable quantity.
      billableHours: acc.rateWeighted,
      // Every entry in this group resolved to the same rate, so the amount is
      // exactly billableHours x rate — which is what makes the line multiply out.
      billRate: acc.rate,
      costRate: acc.costWeighted > 0 ? acc.cost / acc.costWeighted : 0,
      billable: round2(acc.billable),
      cost: round2(acc.cost),
      consultantIds: [...acc.consultantIds],
    }))
    .sort((a, b) => b.billable - a.billable);

  const laborBillable = round2(sum(laborByGrade.map((g) => g.billable)));
  const laborCost = round2(sum(laborByGrade.map((g) => g.cost)));

  // ── Claude usage, grouped by model ──
  interface ModelAcc extends Omit<AiByModel, "model" | "displayName"> {}
  const models = new Map<string, ModelAcc>();
  let attributedCost = 0;

  for (const u of input.usage) {
    if (u.workstream_id !== ws.id) continue;
    if (!inPeriod(u.usage_date, period)) continue;
    attributedCost += u.cost_usd;
    let acc = models.get(u.model);
    if (!acc) {
      acc = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
        cost: 0,
      };
      models.set(u.model, acc);
    }
    acc.inputTokens += u.input_tokens;
    acc.outputTokens += u.output_tokens;
    acc.cacheReadTokens += u.cache_read_tokens;
    acc.cacheWriteTokens += u.cache_write_tokens;
    acc.requests += u.requests;
    acc.cost += u.cost_usd;
  }

  const aiByModel: AiByModel[] = [...models.entries()]
    .map(([model, acc]) => ({
      model,
      displayName: pricing.displayName(model),
      ...acc,
    }))
    .sort((a, b) => b.cost - a.cost);

  const allocatedCost = allocation.byWorkstream.get(ws.id) ?? 0;
  const ai: AiAllocation = {
    attributedCost,
    allocatedCost,
    totalCost: attributedCost + allocatedCost,
    allocationShare: allocation.shareByWorkstream.get(ws.id) ?? 0,
  };

  // The AI charge is assembled exactly as a statement prints it: a rounded line
  // per model, a rounded allocated-share line, a rounded markup line. Rounding
  // the aggregate instead — round2(totalCost * (1 + markup)) — put this figure up
  // to four cents away from the lines that are supposed to total to it.
  const aiBillable = round2(
    aiPassthroughCharge(policy, aiByModel, ai.allocatedCost) +
      aiMarkupCharge(policy, markupPct, ai.totalCost),
  );
  const aiMargin = round2(aiBillable - ai.totalCost);

  // ── Fixed fee: milestones delivered or invoiced within the period ──
  // One line each, so the fee is the sum of already-rounded amounts.
  const fixedFee = round2(
    sum(billableMilestones(input.milestones, ws.id, period).map((m) => round2(m.amount))),
  );

  const totalBillable = round2(laborBillable + aiBillable + fixedFee);
  const totalCost = round2(laborCost + ai.totalCost);
  const margin = round2(totalBillable - totalCost);

  const ltd = input.ltd?.[ws.id] ?? { hours, amount: totalBillable };

  return {
    workstream: ws,
    policy,
    markupPct,
    hours,
    billableHours,
    nonBillableHours,
    laborByGrade,
    laborBillable,
    laborCost,
    ai,
    aiByModel,
    aiBillable,
    aiMargin,
    fixedFee,
    totalBillable,
    totalCost,
    margin,
    marginPct: ratio(margin, totalBillable),
    effectiveRate: ratio(totalBillable, billableHours),
    aiCostPerBillableHour: ratio(ai.totalCost, billableHours),
    budget: computeBurn(ws, ltd, asOf),
  };
}

// ── Project roll-up ─────────────────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = { ok: 0, watch: 1, over: 2 };

/**
 * Computes the project and returns the allocation alongside it, so a statement
 * built from the same input cannot disagree with the dashboard about how the
 * untagged pool was split.
 */
export function computeProjectBillingWithAllocation(input: BillingInput): {
  billing: ProjectBilling;
  allocation: AllocationResult;
} {
  const workstreamIds = new Set(input.workstreams.map((w) => w.id));
  const allocation = allocateUnattributed(
    input.usage,
    input.timeEntries,
    input.period,
    workstreamIds,
    input.globalHoursByConsultant,
  );

  const workstreams = input.workstreams
    .map((ws) => computeWorkstreamBilling(ws, input, allocation))
    .sort((a, b) => a.workstream.code.localeCompare(b.workstream.code));

  const hours = sum(workstreams.map((w) => w.hours));
  const billableHours = sum(workstreams.map((w) => w.billableHours));
  const laborBillable = round2(sum(workstreams.map((w) => w.laborBillable)));
  const laborCost = round2(sum(workstreams.map((w) => w.laborCost)));
  const aiCost = round2(sum(workstreams.map((w) => w.ai.totalCost)));
  const aiBillable = round2(sum(workstreams.map((w) => w.aiBillable)));
  const aiAbsorbed = round2(
    sum(workstreams.filter((w) => w.policy === "absorbed").map((w) => w.ai.totalCost)),
  );
  const fixedFee = round2(sum(workstreams.map((w) => w.fixedFee)));
  const totalBillable = round2(sum(workstreams.map((w) => w.totalBillable)));
  const totalCost = round2(sum(workstreams.map((w) => w.totalCost)));
  const margin = round2(totalBillable - totalCost);

  const risk = workstreams.reduce<RiskLevel>(
    (worst, w) => (RISK_ORDER[w.budget.risk] > RISK_ORDER[worst] ? w.budget.risk : worst),
    "ok",
  );

  const billing: ProjectBilling = {
    project: input.project,
    client: input.client,
    period: input.period,
    workstreams,
    hours,
    billableHours,
    laborBillable,
    laborCost,
    aiCost,
    aiBillable,
    aiAbsorbed,
    fixedFee,
    totalBillable,
    totalCost,
    margin,
    marginPct: ratio(margin, totalBillable),
    effectiveRate: ratio(totalBillable, billableHours),
    aiCostShare: ratio(aiCost, totalCost),
    risk,
  };

  return { billing, allocation };
}

export function computeProjectBilling(input: BillingInput): ProjectBilling {
  return computeProjectBillingWithAllocation(input).billing;
}

// ── Statement construction ──────────────────────────────────────────────────

export interface StatementOptions {
  invoiceNumber: string;
  issuedDate?: string | null;
  dueDate?: string | null;
  status?: Statement["status"];
  taxRate?: number;
}

/**
 * Turns a computed project into invoice-ready lines. Every line's `amount` is
 * already rounded; every subtotal is the sum of those rounded amounts.
 */
export function buildStatement(
  input: BillingInput,
  opts: StatementOptions,
): Statement {
  const { billing, allocation } = computeProjectBillingWithAllocation(input);

  const groups: StatementGroup[] = billing.workstreams.map((w) => {
    const lines: StatementLine[] = [];
    const wsName = w.workstream.name;

    // Labor, one line per grade. The quantity is the BILLABLE hours, so the line
    // multiplies out: a client who checks qty x rate against the amount must get
    // the amount. Non-billable and unapproved hours carry cost but are not a
    // chargeable quantity, so they belong in the internal note, not the qty.
    //
    // The quantity is two decimals and has to be *printed* at two decimals. Half
    // hours are what today's data holds, but a part-approved day or a rate change
    // mid-period leaves quarters, and 31.25 h shown as 31.3 h at $310 prints a
    // product $15.50 away from its own amount. Anything rendering these lines —
    // page, print sheet, CSV — matches this precision or breaks the invariant.
    for (const g of w.laborByGrade) {
      if (g.hours === 0) continue;
      const unbilled = round2(g.hours - g.billableHours);
      lines.push({
        workstreamId: w.workstream.id,
        workstreamName: wsName,
        kind: "labor",
        description: `Professional services — ${GRADE_LABEL[g.grade]}`,
        qty: round2(g.billableHours),
        unit: "hrs",
        unitPrice: round2(g.billRate),
        amount: g.billable,
        internal: {
          cost: g.cost,
          margin: round2(g.billable - g.cost),
          marginPct: ratio(g.billable - g.cost, g.billable),
          note:
            unbilled > 0
              ? `${unbilled} h logged but not charged (non-billable or unapproved)`
              : undefined,
        },
      });
    }

    // Fixed-fee milestones. Gated on the milestones existing, never on the money:
    // a set of milestones that sums under half a cent, or that cancels out, is
    // still work the client agreed to and must appear as lines.
    for (const m of billableMilestones(input.milestones, w.workstream.id, input.period)) {
      lines.push({
        workstreamId: w.workstream.id,
        workstreamName: wsName,
        kind: "fixed_fee",
        description: `Milestone — ${m.name}`,
        qty: 1,
        unit: "milestone",
        unitPrice: round2(m.amount),
        amount: round2(m.amount),
      });
    }

    // Claude usage, one line per model. Priced per million tokens so the client
    // can see the arithmetic rather than a single opaque "platform fee".
    const absorbed = w.policy === "absorbed";
    for (const m of w.aiByModel) {
      const mtok =
        (m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens) /
        1_000_000;
      const billed = absorbed ? 0 : round2(m.cost * (1 + w.markupPct));
      lines.push({
        workstreamId: w.workstream.id,
        workstreamName: wsName,
        kind: "ai_passthrough",
        description: `Claude platform usage — ${m.displayName}`,
        // Three decimals on the quantity and four on the rate. Both are display
        // precisions, and both are error multipliers on a line that can carry
        // hundreds of millions of tokens: at 2dp/2dp the printed product sat
        // $1.69 from the printed amount on the worst real line. The residual is
        // bounded by (qty_error x rate) + (qty x rate_error), which these
        // precisions hold to about a cent — the amount stays authoritative, and
        // whatever the page prints must be what it multiplies.
        qty: Math.round(mtok * 1000) / 1000,
        unit: "M tokens",
        unitPrice: mtok > 0 ? round4(m.cost / mtok) : 0,
        amount: absorbed ? 0 : round2(m.cost),
        internal: {
          cost: round2(m.cost),
          note: absorbed
            ? `Absorbed under ${AI_POLICY_LABEL[w.policy].toLowerCase()} — not rebilled`
            : `${m.requests.toLocaleString("en-US")} requests`,
          margin: absorbed ? round2(-m.cost) : round2(billed - m.cost),
        },
      });
    }

    // Allocated share of untagged usage — always its own line, never folded into
    // a model line, so the client can see exactly what was estimated.
    if (w.ai.allocatedCost > 0) {
      lines.push({
        workstreamId: w.workstream.id,
        workstreamName: wsName,
        kind: "ai_passthrough",
        description: "Claude platform usage — allocated share of untagged sessions",
        qty: Math.round(w.ai.allocationShare * 1000) / 10,
        unit: "% of pool",
        unitPrice: round2(w.ai.allocatedCost),
        amount: absorbed ? 0 : round2(w.ai.allocatedCost),
        internal: {
          cost: round2(w.ai.allocatedCost),
          note: "Allocated pro-rata by hours logged by the same consultants",
        },
      });
    }

    // Markup, as one explicit line rather than hidden in the unit price.
    if (chargesAiMarkup(w.policy, w.markupPct, w.ai.totalCost)) {
      const markupAmount = aiMarkupCharge(w.policy, w.markupPct, w.ai.totalCost);
      lines.push({
        workstreamId: w.workstream.id,
        workstreamName: wsName,
        kind: "ai_markup",
        description: `AI platform management fee (${Math.round(w.markupPct * 100)}%)`,
        qty: 1,
        unit: "fee",
        unitPrice: markupAmount,
        amount: markupAmount,
        internal: { cost: 0, margin: markupAmount, marginPct: 1 },
      });
    }

    const subtotal = round2(sum(lines.map((l) => l.amount)));
    const cost = w.totalCost;
    return {
      workstreamId: w.workstream.id,
      workstreamCode: w.workstream.code,
      workstreamName: wsName,
      policy: w.policy,
      markupPct: w.markupPct,
      lines,
      subtotal,
      cost,
      margin: round2(subtotal - cost),
      marginPct: ratio(subtotal - cost, subtotal),
    };
  });

  const allLines = groups.flatMap((g) => g.lines);
  const byKind = (kind: StatementLine["kind"]) =>
    round2(sum(allLines.filter((l) => l.kind === kind).map((l) => l.amount)));

  const subtotalLabor = byKind("labor");
  const subtotalAi = byKind("ai_passthrough");
  const subtotalAiMarkup = byKind("ai_markup");
  const subtotalFixedFee = byKind("fixed_fee");
  const subtotal = round2(
    subtotalLabor + subtotalAi + subtotalAiMarkup + subtotalFixedFee,
  );

  const taxRate = opts.taxRate ?? 0;
  const taxAmount = round2(subtotal * taxRate);
  const total = round2(subtotal + taxAmount);

  return {
    project: input.project,
    client: input.client,
    period: input.period,
    invoiceNumber: opts.invoiceNumber,
    issuedDate: opts.issuedDate ?? null,
    dueDate: opts.dueDate ?? null,
    status: opts.status ?? "draft",
    groups,
    subtotalLabor,
    subtotalAi,
    subtotalAiMarkup,
    subtotalFixedFee,
    subtotal,
    taxRate,
    taxAmount,
    total,
    totalCost: billing.totalCost,
    margin: round2(total - billing.totalCost),
    marginPct: ratio(total - billing.totalCost, total),
    absorbedAiCost: billing.aiAbsorbed,
    unattributedPoolCost: round2(allocation.poolCost),
    unattributedAllocatedCost: round2(sum([...allocation.byWorkstream.values()])),
    unattributedElsewhereCost: round2(allocation.elsewhereCost),
    unattributedResidualCost: round2(allocation.residualCost),
    unattributedBalances: poolBalances(allocation),
  };
}

/**
 * Does the allocation account for every untagged dollar?
 *
 * Checked before rounding. The tolerance is a floating-point one — the pool is
 * summed in a different order than its parts, so the two can differ in the last
 * bit or two — not an accounting one. A real leak would be cents or dollars, not
 * 1e-9, so this stays tight enough to catch one.
 */
function poolBalances(allocation: AllocationResult): boolean {
  const parts =
    sum([...allocation.byWorkstream.values()]) +
    allocation.elsewhereCost +
    allocation.residualCost;
  const scale = Math.max(1, Math.abs(allocation.poolCost));
  return Math.abs(parts - allocation.poolCost) <= scale * 1e-9;
}

// ── Portfolio roll-up ───────────────────────────────────────────────────────

export interface PortfolioTotals {
  projects: number;
  clients: number;
  billableHours: number;
  totalBillable: number;
  totalCost: number;
  laborCost: number;
  aiCost: number;
  aiBillable: number;
  aiAbsorbed: number;
  margin: number;
  marginPct: number | null;
  effectiveRate: number | null;
  aiCostShare: number | null;
  atRisk: number;
}

export function computePortfolio(
  billings: readonly ProjectBilling[],
): PortfolioTotals {
  const totalBillable = round2(sum(billings.map((b) => b.totalBillable)));
  const totalCost = round2(sum(billings.map((b) => b.totalCost)));
  const aiCost = round2(sum(billings.map((b) => b.aiCost)));
  const billableHours = sum(billings.map((b) => b.billableHours));
  const margin = round2(totalBillable - totalCost);

  return {
    projects: billings.length,
    clients: new Set(billings.map((b) => b.client.id)).size,
    billableHours,
    totalBillable,
    totalCost,
    laborCost: round2(sum(billings.map((b) => b.laborCost))),
    aiCost,
    aiBillable: round2(sum(billings.map((b) => b.aiBillable))),
    aiAbsorbed: round2(sum(billings.map((b) => b.aiAbsorbed))),
    margin,
    marginPct: ratio(margin, totalBillable),
    effectiveRate: ratio(totalBillable, billableHours),
    aiCostShare: ratio(aiCost, totalCost),
    atRisk: billings.filter((b) => b.risk !== "ok").length,
  };
}
