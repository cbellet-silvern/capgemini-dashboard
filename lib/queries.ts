/**
 * Data access. Server-only — every function here touches SQLite.
 *
 * Rule, without exception: values are bound with `?`. The only string built into
 * SQL is a placeholder list, and the only dynamic identifier is resolved through
 * an allow-list (`sortClause` in db.ts). If you find yourself writing a template
 * literal with a value in it, stop.
 */

import { all, get, inClause, run, scalar } from "./db";
import { PricingBook } from "./pricing";
import {
  resolveBillRate,
  type BillingInput,
  type LtdTotals,
} from "./billing";
import type {
  AssignmentRow,
  Attribution,
  ClaudeSeatRow,
  ClaudeUsageRow,
  ClientRow,
  ConsultantRow,
  InvoiceLineRow,
  InvoiceRow,
  MilestoneRow,
  ModelPricingRow,
  Period,
  ProjectRow,
  RateCardRow,
  Surface,
  TimeEntryRow,
  WorkstreamRow,
} from "./types";

// ── Reference data ──────────────────────────────────────────────────────────

export function listClients(): ClientRow[] {
  return all<ClientRow>("SELECT * FROM clients ORDER BY name");
}

export function getClient(id: string): ClientRow | undefined {
  return get<ClientRow>("SELECT * FROM clients WHERE id = ?", [id]);
}

export function listConsultants(): ConsultantRow[] {
  return all<ConsultantRow>("SELECT * FROM consultants ORDER BY name");
}

export function getConsultant(id: string): ConsultantRow | undefined {
  return get<ConsultantRow>("SELECT * FROM consultants WHERE id = ?", [id]);
}

export function listProjects(): ProjectRow[] {
  return all<ProjectRow>("SELECT * FROM projects ORDER BY code");
}

export function getProject(id: string): ProjectRow | undefined {
  return get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
}

export function listWorkstreams(projectId?: string): WorkstreamRow[] {
  return projectId
    ? all<WorkstreamRow>(
        "SELECT * FROM workstreams WHERE project_id = ? ORDER BY code",
        [projectId],
      )
    : all<WorkstreamRow>("SELECT * FROM workstreams ORDER BY project_id, code");
}

export function getWorkstream(id: string): WorkstreamRow | undefined {
  return get<WorkstreamRow>("SELECT * FROM workstreams WHERE id = ?", [id]);
}

export function listRateCards(projectId: string): RateCardRow[] {
  return all<RateCardRow>(
    "SELECT * FROM rate_cards WHERE project_id = ? ORDER BY grade, effective_from",
    [projectId],
  );
}

export function listAssignments(projectId?: string): AssignmentRow[] {
  if (!projectId) return all<AssignmentRow>("SELECT * FROM assignments");
  return all<AssignmentRow>(
    `SELECT a.* FROM assignments a
       JOIN workstreams w ON w.id = a.workstream_id
      WHERE w.project_id = ?`,
    [projectId],
  );
}

export function listMilestones(projectId?: string): MilestoneRow[] {
  if (!projectId) return all<MilestoneRow>("SELECT * FROM milestones ORDER BY due_date");
  return all<MilestoneRow>(
    `SELECT m.* FROM milestones m
       JOIN workstreams w ON w.id = m.workstream_id
      WHERE w.project_id = ?
      ORDER BY m.due_date`,
    [projectId],
  );
}

export function listModelPricing(): ModelPricingRow[] {
  return all<ModelPricingRow>(
    "SELECT * FROM model_pricing ORDER BY tier, model, effective_from DESC",
  );
}

export function pricingBook(): PricingBook {
  return new PricingBook(listModelPricing());
}

export function settings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getSetting(key: string, fallback = ""): string {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// ── Periods ─────────────────────────────────────────────────────────────────

/** Every month that has either time or usage in it, newest first. */
export function availableMonths(): string[] {
  return all<{ m: string }>(
    `SELECT DISTINCT m FROM (
       SELECT substr(work_date, 1, 7) AS m FROM time_entries
       UNION
       SELECT substr(usage_date, 1, 7) AS m FROM claude_usage
     ) ORDER BY m DESC`,
  ).map((r) => r.m);
}

/** Inclusive first/last day of a 'YYYY-MM' month. */
export function monthPeriod(ym: string): Period {
  const [y, m] = ym.split("-").map(Number);
  const year = y ?? 2026;
  const month = m ?? 1;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * Resolves a `?month=YYYY-MM` search param to a period, falling back to the
 * most recent month present in the data. Anything not in `availableMonths()` is
 * rejected rather than trusted — it reaches SQL as a bound value either way,
 * but an unknown month would silently render an empty page.
 */
export function resolvePeriod(month?: string): { month: string; period: Period } {
  const months = availableMonths();
  const chosen = month && months.includes(month) ? month : (months[0] ?? "2026-07");
  return { month: chosen, period: monthPeriod(chosen) };
}

/** The full span of data in the database. */
export function dataSpan(): Period {
  const row = get<{ lo: string | null; hi: string | null }>(
    `SELECT MIN(d) lo, MAX(d) hi FROM (
       SELECT work_date d FROM time_entries UNION SELECT usage_date d FROM claude_usage
     )`,
  );
  return { start: row?.lo ?? "2026-01-01", end: row?.hi ?? "2026-12-31" };
}

// ── Time entries ────────────────────────────────────────────────────────────

export function listTimeEntries(opts: {
  period?: Period;
  projectId?: string;
  workstreamId?: string;
  consultantId?: string;
  statuses?: readonly TimeEntryRow["status"][];
  limit?: number;
}): TimeEntryRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (opts.period) {
    where.push("t.work_date BETWEEN ? AND ?");
    params.push(opts.period.start, opts.period.end);
  }
  if (opts.projectId) {
    where.push("w.project_id = ?");
    params.push(opts.projectId);
  }
  if (opts.workstreamId) {
    where.push("t.workstream_id = ?");
    params.push(opts.workstreamId);
  }
  if (opts.consultantId) {
    where.push("t.consultant_id = ?");
    params.push(opts.consultantId);
  }
  if (opts.statuses?.length) {
    const inc = inClause(opts.statuses as readonly string[]);
    if (inc) {
      where.push(`t.status IN ${inc.sql}`);
      params.push(...(inc.params as string[]));
    }
  }

  // SQLite accepts a bound LIMIT, so it goes through `?` like every other value.
  // Interpolating it — even behind an isInteger guard — would put a value in the
  // SQL string and make the rule above "almost always", which is not a rule.
  let limitClause = "";
  if (opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0) {
    limitClause = " LIMIT ?";
    params.push(opts.limit);
  }

  return all<TimeEntryRow>(
    `SELECT t.* FROM time_entries t
       JOIN workstreams w ON w.id = t.workstream_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY t.work_date DESC, t.id${limitClause}`,
    params,
  );
}

/** Each consultant's total logged hours in the period, across every project. */
export function globalHoursByConsultant(period: Period): Record<string, number> {
  const rows = all<{ consultant_id: string; h: number }>(
    `SELECT consultant_id, SUM(hours) h FROM time_entries
      WHERE work_date BETWEEN ? AND ?
      GROUP BY consultant_id`,
    [period.start, period.end],
  );
  return Object.fromEntries(rows.map((r) => [r.consultant_id, r.h]));
}

export function approvalQueue(limit = 250): Array<
  TimeEntryRow & {
    consultant_name: string;
    grade: string;
    workstream_name: string;
    workstream_code: string;
    project_code: string;
    project_name: string;
    client_name: string;
  }
> {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 250;
  return all(
    `SELECT t.*, c.name consultant_name, c.grade grade,
            w.name workstream_name, w.code workstream_code,
            p.code project_code, p.name project_name, cl.name client_name
       FROM time_entries t
       JOIN consultants c ON c.id = t.consultant_id
       JOIN workstreams w ON w.id = t.workstream_id
       JOIN projects p    ON p.id = w.project_id
       JOIN clients cl    ON cl.id = p.client_id
      WHERE t.status IN ('draft','submitted')
      ORDER BY t.status DESC, t.work_date DESC
      LIMIT ?`,
    [safeLimit],
  );
}

export function approveTimeEntries(ids: readonly string[], approver: string): number {
  const inc = inClause(ids);
  if (!inc) return 0;
  run(
    `UPDATE time_entries SET status = 'approved', approved_by = ?
      WHERE id IN ${inc.sql} AND status IN ('draft','submitted')`,
    [approver, ...inc.params],
  );
  return ids.length;
}

// ── Claude usage ────────────────────────────────────────────────────────────

/**
 * Usage relevant to a project: rows attributed to its workstreams, plus
 * untagged rows belonging to consultants assigned to it. The untagged rows are
 * needed so the allocation has a pool to work from — see `allocateUnattributed`.
 *
 * These rows are engine input, not a project total. The untagged rows are each
 * consultant's *whole* pool, including the part their other clients pay for, so
 * summing `cost_usd` — overall or per consultant — overstates what this project
 * may claim. For a figure to print, use `claudeCostByConsultantForProject`.
 */
export function listUsageForProject(projectId: string, period: Period): ClaudeUsageRow[] {
  return all<ClaudeUsageRow>(
    `SELECT u.* FROM claude_usage u
      WHERE u.usage_date BETWEEN ? AND ?
        AND (
          u.workstream_id IN (SELECT id FROM workstreams WHERE project_id = ?)
          OR (
            u.workstream_id IS NULL
            AND u.consultant_id IN (
              SELECT DISTINCT a.consultant_id FROM assignments a
                JOIN workstreams w ON w.id = a.workstream_id
               WHERE w.project_id = ?
            )
          )
        )`,
    [period.start, period.end, projectId, projectId],
  );
}

/** One consultant's Claude cost on one project, split so no client pays twice. */
export interface ConsultantClaudeCost {
  consultant_id: string;
  /** Cost of sessions tagged to this project's workstreams. Entirely this project's. */
  attributedCost: number;
  /** The consultant's whole untagged pool in the period, every engagement included. */
  poolCost: number;
  /** The slice of that pool this project's hours claim, by the engine's rule. */
  allocatedCost: number;
  /** `attributedCost + allocatedCost` — the only one of these safe to print as a total. */
  projectCost: number;
}

/**
 * Per-consultant Claude cost for one project, as the billing engine sees it.
 *
 * The untagged pool cannot simply be added to the tagged rows: a consultant who
 * splits their week across two clients would have the same dollars appear on
 * both projects' team tables. So the pool is divided the way
 * `allocateUnattributed` divides it — by this project's share of the
 * consultant's hours everywhere in the period — and only that share lands in
 * `projectCost`. The unclaimed remainder belongs to their other engagements.
 *
 * Sorted by `projectCost`, largest first. Consultants with no usage are absent.
 */
export function claudeCostByConsultantForProject(
  projectId: string,
  period: Period,
): ConsultantClaudeCost[] {
  const workstreamIds = new Set(listWorkstreams(projectId).map((w) => w.id));
  const globalHours = globalHoursByConsultant(period);

  const inScopeHours = new Map<string, number>();
  for (const t of listTimeEntries({ projectId, period })) {
    inScopeHours.set(t.consultant_id, (inScopeHours.get(t.consultant_id) ?? 0) + t.hours);
  }

  const rows = new Map<string, ConsultantClaudeCost>();
  for (const u of listUsageForProject(projectId, period)) {
    let row = rows.get(u.consultant_id);
    if (!row) {
      row = {
        consultant_id: u.consultant_id,
        attributedCost: 0,
        poolCost: 0,
        allocatedCost: 0,
        projectCost: 0,
      };
      rows.set(u.consultant_id, row);
    }
    if (u.workstream_id === null) row.poolCost += u.cost_usd;
    else if (workstreamIds.has(u.workstream_id)) row.attributedCost += u.cost_usd;
  }

  for (const row of rows.values()) {
    const hours = inScopeHours.get(row.consultant_id) ?? 0;
    // Same denominator as the engine: hours everywhere, not hours here. With no
    // hours anywhere the pool is residual — unallocable, so nobody claims it.
    const denominator = globalHours[row.consultant_id] ?? hours;
    row.allocatedCost = denominator > 0 ? (row.poolCost * hours) / denominator : 0;
    row.projectCost = row.attributedCost + row.allocatedCost;
  }

  return [...rows.values()].sort((a, b) => b.projectCost - a.projectCost);
}

export function listUsage(period: Period): ClaudeUsageRow[] {
  return all<ClaudeUsageRow>(
    "SELECT * FROM claude_usage WHERE usage_date BETWEEN ? AND ?",
    [period.start, period.end],
  );
}

/**
 * Usage in a period narrowed to a single model, for the "filter by model"
 * control on the usage export. The model name comes straight from the query
 * string, so it is passed as a bound parameter — never concatenated into the
 * SQL text — to keep attacker input from altering the query structure.
 */
export function listUsageByModel(period: Period, model: string): ClaudeUsageRow[] {
  return all<ClaudeUsageRow>(
    `SELECT * FROM claude_usage
      WHERE usage_date BETWEEN ? AND ?
        AND model = ?`,
    [period.start, period.end, model],
  );
}

export function usageCostByDay(
  period: Period,
  projectId?: string,
): Array<{ date: string; cost: number; tokens: number }> {
  if (projectId) {
    return all(
      `SELECT u.usage_date date, SUM(u.cost_usd) cost,
              SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) tokens
         FROM claude_usage u
         JOIN workstreams w ON w.id = u.workstream_id
        WHERE u.usage_date BETWEEN ? AND ? AND w.project_id = ?
        GROUP BY u.usage_date ORDER BY u.usage_date`,
      [period.start, period.end, projectId],
    );
  }
  return all(
    `SELECT usage_date date, SUM(cost_usd) cost,
            SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens
       FROM claude_usage
      WHERE usage_date BETWEEN ? AND ?
      GROUP BY usage_date ORDER BY usage_date`,
    [period.start, period.end],
  );
}

/** Whole-history monthly totals, oldest first — the portfolio trend line. */
export function usageCostByMonth(): Array<{
  month: string;
  cost: number;
  tokens: number;
}> {
  return all(
    `SELECT substr(usage_date, 1, 7) month, SUM(cost_usd) cost,
            SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens
       FROM claude_usage
      GROUP BY substr(usage_date, 1, 7)
      ORDER BY month`,
  );
}

/** `tier` is null for a model with no rate row — the LEFT JOIN finds nothing. */
export function usageCostByDayAndTier(
  period: Period,
): Array<{ date: string; tier: string | null; cost: number }> {
  return all(
    `SELECT u.usage_date date, p.tier tier, SUM(u.cost_usd) cost
       FROM claude_usage u
       LEFT JOIN (SELECT model, MIN(tier) tier FROM model_pricing GROUP BY model) p
         ON p.model = u.model
      WHERE u.usage_date BETWEEN ? AND ?
      GROUP BY u.usage_date, p.tier
      ORDER BY u.usage_date`,
    [period.start, period.end],
  );
}

export function usageByModel(
  period: Period,
  projectId?: string,
): Array<{
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  sessions: number;
}> {
  const params: string[] = [period.start, period.end];
  let join = "";
  let extra = "";
  if (projectId) {
    join = "JOIN workstreams w ON w.id = u.workstream_id";
    extra = "AND w.project_id = ?";
    params.push(projectId);
  }
  return all(
    `SELECT u.model model, SUM(u.cost_usd) cost,
            SUM(u.input_tokens) input_tokens, SUM(u.output_tokens) output_tokens,
            SUM(u.cache_read_tokens) cache_read_tokens,
            SUM(u.cache_write_tokens) cache_write_tokens,
            SUM(u.requests) requests, SUM(u.sessions) sessions
       FROM claude_usage u ${join}
      WHERE u.usage_date BETWEEN ? AND ? ${extra}
      GROUP BY u.model ORDER BY cost DESC`,
    params,
  );
}

export function usageBySurface(
  period: Period,
): Array<{ surface: Surface; cost: number; sessions: number }> {
  return all(
    `SELECT surface, SUM(cost_usd) cost, SUM(sessions) sessions
       FROM claude_usage WHERE usage_date BETWEEN ? AND ?
      GROUP BY surface ORDER BY cost DESC`,
    [period.start, period.end],
  );
}

export function usageByAttribution(
  period: Period,
): Array<{ attribution: Attribution; cost: number; rows: number }> {
  return all(
    `SELECT attribution, SUM(cost_usd) cost, COUNT(*) rows
       FROM claude_usage WHERE usage_date BETWEEN ? AND ?
      GROUP BY attribution`,
    [period.start, period.end],
  );
}

/**
 * Heatmap source: cost per consultant per ISO week within the period. `week` is
 * the Monday of the week each row belongs to, which for a period that does not
 * start on a Monday is a date before `period.start`.
 */
export function usageByConsultantWeek(period: Period): Array<{
  consultant_id: string;
  consultant_name: string;
  initials: string;
  grade: string;
  practice: string;
  week: string;
  cost: number;
}> {
  return all(
    `SELECT u.consultant_id, c.name consultant_name, c.initials, c.grade, c.practice,
            -- 'weekday 1' walks forward to the next Monday but stands still on a
            -- Monday, so subtracting a week from it files Mondays into the week
            -- before. Stepping back six days first lands every date on its own.
            date(u.usage_date, '-6 days', 'weekday 1') week,
            SUM(u.cost_usd) cost
       FROM claude_usage u
       JOIN consultants c ON c.id = u.consultant_id
      WHERE u.usage_date BETWEEN ? AND ?
      GROUP BY u.consultant_id, week
      ORDER BY c.name, week`,
    [period.start, period.end],
  );
}

export function usageByConsultant(period: Period): Array<{
  consultant_id: string;
  consultant_name: string;
  grade: string;
  practice: string;
  cost: number;
  sessions: number;
  tokens: number;
  hours: number;
}> {
  return all(
    `SELECT c.id consultant_id, c.name consultant_name, c.grade, c.practice,
            COALESCE(u.cost, 0) cost, COALESCE(u.sessions, 0) sessions,
            COALESCE(u.tokens, 0) tokens, COALESCE(t.hours, 0) hours
       FROM consultants c
       LEFT JOIN (
         SELECT consultant_id, SUM(cost_usd) cost, SUM(sessions) sessions,
                SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens
           FROM claude_usage WHERE usage_date BETWEEN ? AND ? GROUP BY consultant_id
       ) u ON u.consultant_id = c.id
       LEFT JOIN (
         SELECT consultant_id, SUM(hours) hours
           FROM time_entries WHERE work_date BETWEEN ? AND ? GROUP BY consultant_id
       ) t ON t.consultant_id = c.id
      ORDER BY cost DESC`,
    [period.start, period.end, period.start, period.end],
  );
}

export function listSeats(month: string): ClaudeSeatRow[] {
  return all<ClaudeSeatRow>("SELECT * FROM claude_seats WHERE month = ?", [month]);
}

/**
 * Models with usage no rate covers — a data-quality warning.
 *
 * Date-aware on purpose, matching `PricingBook.isUnpriced(model, date)`: a model
 * whose only rate row starts after the usage was metered costs the same $0 as a
 * model with no row at all, so asking "is this model known?" would let that
 * usage through silently.
 */
export function unpricedModels(): string[] {
  return all<{ model: string }>(
    `SELECT DISTINCT u.model model FROM claude_usage u
      WHERE NOT EXISTS (
        SELECT 1 FROM model_pricing p
         WHERE p.model = u.model AND p.effective_from <= u.usage_date
      )`,
  ).map((r) => r.model);
}

// ── Invoices ────────────────────────────────────────────────────────────────

export function listInvoices(projectId?: string): Array<
  InvoiceRow & { project_code: string; project_name: string; client_name: string }
> {
  const where = projectId ? "WHERE i.project_id = ?" : "";
  const params = projectId ? [projectId] : [];
  return all(
    `SELECT i.*, p.code project_code, p.name project_name, c.name client_name
       FROM invoices i
       JOIN projects p ON p.id = i.project_id
       JOIN clients c  ON c.id = p.client_id
     ${where}
      ORDER BY i.period_start DESC, i.number DESC`,
    params,
  );
}

export function getInvoice(id: string): InvoiceRow | undefined {
  return get<InvoiceRow>("SELECT * FROM invoices WHERE id = ?", [id]);
}

export function getInvoiceForPeriod(
  projectId: string,
  period: Period,
): InvoiceRow | undefined {
  return get<InvoiceRow>(
    "SELECT * FROM invoices WHERE project_id = ? AND period_start = ? AND period_end = ?",
    [projectId, period.start, period.end],
  );
}

export function listInvoiceLines(invoiceId: string): InvoiceLineRow[] {
  return all<InvoiceLineRow>(
    "SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort, id",
    [invoiceId],
  );
}

export function setInvoiceStatus(
  id: string,
  status: InvoiceRow["status"],
  issuedDate: string | null,
  dueDate: string | null,
): void {
  run("UPDATE invoices SET status = ?, issued_date = ?, due_date = ? WHERE id = ?", [
    status,
    issuedDate,
    dueDate,
    id,
  ]);
}

export function setWorkstreamAiPolicy(
  workstreamId: string,
  policy: WorkstreamRow["ai_policy"],
  markupPct: number | null,
): void {
  run("UPDATE workstreams SET ai_policy = ?, ai_markup_pct = ? WHERE id = ?", [
    policy,
    markupPct,
    workstreamId,
  ]);
}

// ── Life-to-date burn ───────────────────────────────────────────────────────

/**
 * Burn is measured against the whole workstream, not the reporting period, so
 * this walks every entry for the project — not just the ones on the statement.
 * The dataset is small enough that doing it in JS beats reproducing
 * effective-dated rate resolution in SQL.
 *
 * Cumulative up to `asOf` and no further. `computeBurn` divides these totals by
 * the fraction of the workstream's span elapsed at `asOf`, so spend recorded
 * after that date must not be in them: including it would attribute months of
 * later work to an earlier schedule position and project a run rate that never
 * happened. Pass the end of the period being reported.
 */
export function ltdByWorkstream(
  projectId: string,
  asOf: string,
): Record<string, LtdTotals> {
  const workstreams = listWorkstreams(projectId);
  const consultants = new Map(listConsultants().map((c) => [c.id, c]));
  const assignments = listAssignments(projectId);
  const rateCards = listRateCards(projectId);

  const entries = all<TimeEntryRow>(
    `SELECT t.* FROM time_entries t
       JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.project_id = ? AND t.work_date <= ?`,
    [projectId, asOf],
  );

  const usage = all<{ workstream_id: string; cost: number }>(
    `SELECT u.workstream_id, SUM(u.cost_usd) cost
       FROM claude_usage u
       JOIN workstreams w ON w.id = u.workstream_id
      WHERE w.project_id = ? AND u.usage_date <= ?
      GROUP BY u.workstream_id`,
    [projectId, asOf],
  );

  const out: Record<string, LtdTotals> = {};
  for (const w of workstreams) out[w.id] = { hours: 0, amount: 0 };

  for (const t of entries) {
    const bucket = out[t.workstream_id];
    const consultant = consultants.get(t.consultant_id);
    if (!bucket || !consultant) continue;
    bucket.hours += t.hours;
    if (t.billable === 1 && (t.status === "approved" || t.status === "invoiced")) {
      bucket.amount +=
        t.hours *
        resolveBillRate(consultant, t.workstream_id, assignments, rateCards, t.work_date);
    }
  }
  for (const u of usage) {
    const bucket = out[u.workstream_id];
    if (bucket) bucket.amount += u.cost;
  }
  return out;
}

// ── Assembling engine input ─────────────────────────────────────────────────

/** Everything the billing engine needs for one project over one period. */
export function projectBillingInput(
  projectId: string,
  period: Period,
  pricing?: PricingBook,
): BillingInput | null {
  const project = getProject(projectId);
  if (!project) return null;
  const client = getClient(project.client_id);
  if (!client) return null;

  return {
    project,
    client,
    workstreams: listWorkstreams(projectId),
    consultants: listConsultants(),
    rateCards: listRateCards(projectId),
    assignments: listAssignments(projectId),
    timeEntries: listTimeEntries({ projectId, period }),
    usage: listUsageForProject(projectId, period),
    milestones: listMilestones(projectId),
    pricing: pricing ?? pricingBook(),
    period,
    globalHoursByConsultant: globalHoursByConsultant(period),
    ltd: ltdByWorkstream(projectId, period.end),
    asOf: period.end,
  };
}

/** Engine input for every project, sharing one pricing book and one hours map. */
export function allProjectBillingInputs(period: Period): BillingInput[] {
  const pricing = pricingBook();
  const consultants = listConsultants();
  const globalHours = globalHoursByConsultant(period);
  const clients = new Map(listClients().map((c) => [c.id, c]));

  return listProjects().flatMap((project) => {
    const client = clients.get(project.client_id);
    if (!client) return [];
    return [
      {
        project,
        client,
        workstreams: listWorkstreams(project.id),
        consultants,
        rateCards: listRateCards(project.id),
        assignments: listAssignments(project.id),
        timeEntries: listTimeEntries({ projectId: project.id, period }),
        usage: listUsageForProject(project.id, period),
        milestones: listMilestones(project.id),
        pricing,
        period,
        globalHoursByConsultant: globalHours,
        ltd: ltdByWorkstream(project.id, period.end),
        asOf: period.end,
      } satisfies BillingInput,
    ];
  });
}

// ── Counts, for nav badges and empty-state guards ───────────────────────────

export function counts(): {
  projects: number;
  clients: number;
  consultants: number;
  pendingApprovals: number;
  usageRows: number;
} {
  return {
    projects: scalar<number>("SELECT COUNT(*) FROM projects") ?? 0,
    clients: scalar<number>("SELECT COUNT(*) FROM clients") ?? 0,
    consultants: scalar<number>("SELECT COUNT(*) FROM consultants") ?? 0,
    pendingApprovals:
      scalar<number>(
        "SELECT COUNT(*) FROM time_entries WHERE status IN ('draft','submitted')",
      ) ?? 0,
    usageRows: scalar<number>("SELECT COUNT(*) FROM claude_usage") ?? 0,
  };
}
