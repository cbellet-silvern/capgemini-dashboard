/**
 * Row and domain types for the AI Engagement Ledger.
 *
 * Row types mirror `scripts/schema.sql` one-for-one — SQLite gives us `unknown`,
 * so these are the single place where shape is asserted. Domain types are what
 * the billing engine produces and the UI consumes.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const GRADES = [
  "partner",
  "principal",
  "manager",
  "senior_consultant",
  "consultant",
  "analyst",
] as const;
export type Grade = (typeof GRADES)[number];

export const GRADE_LABEL: Record<Grade, string> = {
  partner: "Partner",
  principal: "Principal",
  manager: "Manager",
  senior_consultant: "Senior Consultant",
  consultant: "Consultant",
  analyst: "Analyst",
};

export type ProjectStatus = "active" | "closing" | "closed";
export type EngagementType = "time_and_materials" | "capped_tm" | "fixed_fee";
export type WorkstreamStatus = "active" | "complete" | "on_hold";

/**
 * How Claude cost on a workstream reaches the client.
 *   markup   — rebilled at cost plus a margin
 *   at_cost  — rebilled exactly at cost, no margin
 *   absorbed — not rebilled; the firm eats it (better client optics, worse margin)
 */
export type AiPolicy = "markup" | "at_cost" | "absorbed";

export const AI_POLICY_LABEL: Record<AiPolicy, string> = {
  markup: "Rebilled with markup",
  at_cost: "Rebilled at cost",
  absorbed: "Absorbed by firm",
};

export type TimeEntryStatus = "draft" | "submitted" | "approved" | "invoiced";

export type Surface = "claude_code" | "api" | "agent_sdk" | "claude_ai_seat";

export const SURFACE_LABEL: Record<Surface, string> = {
  claude_code: "Claude Code",
  api: "Claude API",
  agent_sdk: "Agent SDK",
  claude_ai_seat: "Claude seat",
};

/**
 * How confidently a usage row was tied to a workstream.
 *   tagged       — the session carried an explicit workstream tag
 *   inferred     — matched by repo/project heuristics
 *   unattributed — no signal; goes into the allocation pool
 */
export type Attribution = "tagged" | "inferred" | "unattributed";

export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  tagged: "Tagged",
  inferred: "Inferred",
  unattributed: "Unattributed",
};

export type InvoiceStatus = "draft" | "issued" | "paid";
export type InvoiceLineKind =
  | "labor"
  | "ai_passthrough"
  | "ai_markup"
  | "fixed_fee"
  | "discount";
export type MilestoneStatus = "pending" | "delivered" | "invoiced";
export type CacheTtl = "5m" | "1h";
export type SeatPlan = "team" | "enterprise";

// ── Row types (mirror scripts/schema.sql) ────────────────────────────────────

export interface ClientRow {
  id: string;
  name: string;
  industry: string;
  initials: string;
  currency: string;
  payment_terms_days: number;
  billing_contact_name: string;
  billing_contact_email: string;
  region: string;
}

export interface ProjectRow {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  engagement_type: EngagementType;
  start_date: string;
  end_date: string;
  contract_value: number;
  currency: string;
  engagement_partner: string;
  delivery_lead: string;
  po_number: string;
  ai_policy_default: AiPolicy;
  ai_markup_pct_default: number;
}

export interface WorkstreamRow {
  id: string;
  project_id: string;
  code: string;
  name: string;
  lead_consultant_id: string | null;
  status: WorkstreamStatus;
  start_date: string;
  end_date: string;
  budget_hours: number;
  budget_amount: number;
  fixed_fee_amount: number | null;
  /** NULL means inherit `projects.ai_policy_default`. */
  ai_policy: AiPolicy | null;
  /** NULL means inherit `projects.ai_markup_pct_default`. */
  ai_markup_pct: number | null;
  description: string;
}

export interface ConsultantRow {
  id: string;
  name: string;
  email: string;
  grade: Grade;
  practice: string;
  location: string;
  initials: string;
  default_bill_rate: number;
  default_cost_rate: number;
  active: number;
}

export interface RateCardRow {
  id: string;
  project_id: string;
  grade: Grade;
  bill_rate: number;
  cost_rate: number;
  currency: string;
  effective_from: string;
}

export interface AssignmentRow {
  id: string;
  consultant_id: string;
  workstream_id: string;
  allocation_pct: number;
  bill_rate_override: number | null;
  start_date: string;
  end_date: string;
}

export interface TimeEntryRow {
  id: string;
  consultant_id: string;
  workstream_id: string;
  work_date: string;
  hours: number;
  billable: number;
  activity_code: string;
  narrative: string;
  status: TimeEntryStatus;
  approved_by: string | null;
  invoice_id: string | null;
}

export interface ClaudeUsageRow {
  id: string;
  consultant_id: string;
  workstream_id: string | null;
  usage_date: string;
  model: string;
  surface: Surface;
  requests: number;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_ttl: CacheTtl;
  batch: number;
  cost_usd: number;
  attribution: Attribution;
  invoice_id: string | null;
}

export interface ClaudeSeatRow {
  id: string;
  consultant_id: string;
  plan: SeatPlan;
  month: string;
  monthly_cost: number;
}

export interface ModelPricingRow {
  model: string;
  display_name: string;
  tier: string;
  effective_from: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_5m_per_mtok: number;
  cache_write_1h_per_mtok: number;
  note: string;
}

export interface MilestoneRow {
  id: string;
  workstream_id: string;
  name: string;
  due_date: string;
  amount: number;
  status: MilestoneStatus;
}

export interface InvoiceRow {
  id: string;
  project_id: string;
  number: string;
  period_start: string;
  period_end: string;
  status: InvoiceStatus;
  issued_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal_labor: number;
  subtotal_ai_cost: number;
  ai_markup_amount: number;
  subtotal_fixed_fee: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  notes: string;
}

export interface InvoiceLineRow {
  id: string;
  invoice_id: string;
  workstream_id: string | null;
  kind: InvoiceLineKind;
  sort: number;
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  amount: number;
  meta_json: string;
}

// ── Domain types (billing engine output) ─────────────────────────────────────

/** An inclusive date range, ISO 'YYYY-MM-DD'. */
export interface Period {
  start: string;
  end: string;
}

/** Labor rolled up by grade — one billable line on the statement. */
export interface LaborByGrade {
  grade: Grade;
  /** Every hour logged at this grade, billable or not. Drives cost. */
  hours: number;
  /**
   * The hours actually charged: billable, and approved or invoiced.
   *
   * This — not `hours` — is the quantity that belongs on an invoice line, because
   * it is the only quantity for which `billableHours x billRate == billable`
   * holds. Putting total hours next to the rate makes the line fail to multiply
   * out, which is the fastest way to lose an argument with a client.
   */
  billableHours: number;
  /** Weighted average rate over `billableHours`. */
  billRate: number;
  /** Weighted average cost rate over `hours`. */
  costRate: number;
  /** billableHours x billRate, rounded to cents. */
  billable: number;
  /** hours x costRate, rounded to cents. */
  cost: number;
  consultantIds: string[];
}

/** Claude cost rolled up by model, for one workstream and period. */
export interface AiByModel {
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  /** Raw metered cost, before any markup or allocation. */
  cost: number;
}

export interface AiAllocation {
  /** Cost from rows tagged or inferred to this workstream. */
  attributedCost: number;
  /** Share of the unattributed pool assigned by pro-rata hours. */
  allocatedCost: number;
  /** attributedCost + allocatedCost. */
  totalCost: number;
  /** Fraction of the period's unattributed pool this workstream absorbed. */
  allocationShare: number;
}

/** Everything the engine knows about one workstream over one period. */
export interface WorkstreamBilling {
  workstream: WorkstreamRow;
  policy: AiPolicy;
  markupPct: number;

  hours: number;
  billableHours: number;
  nonBillableHours: number;
  laborByGrade: LaborByGrade[];
  laborBillable: number;
  laborCost: number;

  ai: AiAllocation;
  aiByModel: AiByModel[];
  /** What the client is charged for Claude: cost x (1 + markup), or 0 if absorbed. */
  aiBillable: number;
  /** aiBillable - ai.totalCost. Negative when absorbed. */
  aiMargin: number;

  fixedFee: number;

  /** laborBillable + aiBillable + fixedFee. */
  totalBillable: number;
  /** laborCost + ai.totalCost. */
  totalCost: number;
  /** totalBillable - totalCost. */
  margin: number;
  /** margin / totalBillable, or null when nothing is billable. */
  marginPct: number | null;
  /** totalBillable / billableHours, or null when no billable hours. */
  effectiveRate: number | null;
  /** ai.totalCost / billableHours, or null when no billable hours. */
  aiCostPerBillableHour: number | null;

  budget: BudgetBurn;
}

export interface BudgetBurn {
  budgetHours: number;
  budgetAmount: number;
  hoursUsed: number;
  amountUsed: number;
  hoursPct: number | null;
  amountPct: number | null;
  /** Fraction of the workstream's calendar elapsed at the period end, 0..1. */
  elapsedPct: number;
  /** amountUsed extrapolated at the current run rate to the workstream end date. */
  projectedAmount: number;
  /** projectedAmount - budgetAmount; positive means a forecast overrun. */
  projectedOverrun: number;
  /** ok | watch | over — drives the status color. */
  risk: RiskLevel;
  riskReason: string;
}

export type RiskLevel = "ok" | "watch" | "over";

/** A project rolled up from its workstreams. */
export interface ProjectBilling {
  project: ProjectRow;
  client: ClientRow;
  period: Period;
  workstreams: WorkstreamBilling[];

  hours: number;
  billableHours: number;
  laborBillable: number;
  laborCost: number;
  aiCost: number;
  aiBillable: number;
  aiAbsorbed: number;
  fixedFee: number;
  totalBillable: number;
  totalCost: number;
  margin: number;
  marginPct: number | null;
  effectiveRate: number | null;
  /** aiCost / totalCost — how much of cost-to-serve is Claude. */
  aiCostShare: number | null;
  risk: RiskLevel;
}

/** A statement line, ready to render or export. */
export interface StatementLine {
  workstreamId: string | null;
  workstreamName: string;
  kind: InvoiceLineKind;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  amount: number;
  /** Internal-only columns, hidden in client view. */
  internal?: {
    cost?: number;
    margin?: number;
    marginPct?: number | null;
    note?: string;
  };
}

export interface Statement {
  project: ProjectRow;
  client: ClientRow;
  period: Period;
  invoiceNumber: string;
  issuedDate: string | null;
  dueDate: string | null;
  status: InvoiceStatus;
  groups: StatementGroup[];
  subtotalLabor: number;
  subtotalAi: number;
  subtotalAiMarkup: number;
  subtotalFixedFee: number;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  /** Internal-view totals. */
  totalCost: number;
  margin: number;
  marginPct: number | null;
  /** Claude cost the firm chose not to rebill. */
  absorbedAiCost: number;
  /** Total untagged Claude cost in the period for consultants on this project. */
  unattributedPoolCost: number;
  /** The slice of that pool this project's workstreams absorbed. */
  unattributedAllocatedCost: number;
  /** Slice that belongs to the same consultants' other engagements. */
  unattributedElsewhereCost: number;
  /** Slice with no logged hours anywhere — unallocable, and shown as such. */
  unattributedResidualCost: number;
  /**
   * Whether allocated + elsewhere + residual accounts for the whole pool.
   *
   * Computed on the UNROUNDED figures, because the four fields above are each
   * rounded to cents independently for display — so their displayed sum can
   * legitimately sit a cent off the displayed pool. A UI that compares the
   * rounded values needs an arbitrary tolerance and will cry wolf; this flag is
   * the real answer, and `false` means the allocation genuinely lost money.
   */
  unattributedBalances: boolean;
}

export interface StatementGroup {
  workstreamId: string;
  workstreamCode: string;
  workstreamName: string;
  policy: AiPolicy;
  markupPct: number;
  lines: StatementLine[];
  subtotal: number;
  cost: number;
  margin: number;
  marginPct: number | null;
}
