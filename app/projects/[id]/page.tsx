import Link from "next/link";
import { notFound } from "next/navigation";

import { PolicyBadge, RiskBadge, StatusBadge } from "@/components/Badge";
import { Meter } from "@/components/Meter";
import { PeriodPicker } from "@/components/PeriodPicker";
import { StatTile } from "@/components/StatTile";
import { BarChart } from "@/components/charts/BarChart";
import { StackedBarChart } from "@/components/charts/StackedBarChart";
import {
  computeProjectBillingWithAllocation,
  effectivePolicy,
  resolveBillRate,
  round2,
  sum,
} from "@/lib/billing";
import {
  count,
  date as fmtDate,
  dateRange,
  hours as fmtHours,
  monthLabel,
  pct,
  tokens,
  usd,
  usdCents,
} from "@/lib/format";
import {
  availableMonths,
  claudeCostByConsultantForProject,
  listAssignments,
  listConsultants,
  listMilestones,
  listRateCards,
  listTimeEntries,
  pricingBook,
  projectBillingInput,
  resolvePeriod,
  usageByModel,
} from "@/lib/queries";
import { GRADE_LABEL, type EngagementType, type Grade } from "@/lib/types";

const ENGAGEMENT_LABEL: Record<EngagementType, string> = {
  time_and_materials: "Time & materials",
  capped_tm: "Capped T&M",
  fixed_fee: "Fixed fee",
};

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;


export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { month, period } = resolvePeriod(first(sp.month));

  const input = projectBillingInput(id, period);
  if (!input) notFound();

  const { billing, allocation } = computeProjectBillingWithAllocation(input);
  const { project, client } = billing;
  const months = availableMonths();
  const book = pricingBook();

  const rateCards = listRateCards(project.id);
  const assignments = listAssignments(project.id);
  // A consultant's assignment percentages are per workstream and routinely sum
  // past 100 across an engagement, so the figure shown is the share of their
  // total assigned capacity that sits here — a number that can be read as a
  // percentage without qualification.
  const assignedCapacity = new Map<string, number>();
  for (const a of listAssignments()) {
    assignedCapacity.set(
      a.consultant_id,
      (assignedCapacity.get(a.consultant_id) ?? 0) + a.allocation_pct,
    );
  }
  const consultants = new Map(listConsultants().map((c) => [c.id, c]));
  const workstreamName = new Map(
    billing.workstreams.map((w) => [w.workstream.id, w.workstream.name]),
  );

  // ── Team roll-up: hours from time entries, Claude cost from the project's usage.
  const hoursByConsultant = new Map<string, number>();
  for (const t of listTimeEntries({ projectId: project.id, period })) {
    hoursByConsultant.set(
      t.consultant_id,
      (hoursByConsultant.get(t.consultant_id) ?? 0) + t.hours,
    );
  }
  // Tagged sessions plus only the share of each consultant's untagged pool this
  // engagement's hours claim — the same split the allocation card prints below.
  // Summing the raw usage rows instead would put the same untagged dollars on
  // every engagement the consultant worked in, and overshoot the Claude cost
  // tile by the pool's "elsewhere" slice.
  const costByConsultant = new Map(
    claudeCostByConsultantForProject(project.id, period).map((r) => [
      r.consultant_id,
      r.projectCost,
    ]),
  );

  interface TeamRow {
    consultantId: string;
    name: string;
    grade: Grade;
    practice: string;
    allocation: number;
    billRate: number;
    workstreams: string[];
    hours: number;
    aiCost: number;
  }
  const teamByConsultant = new Map<string, TeamRow>();
  for (const a of assignments) {
    const consultant = consultants.get(a.consultant_id);
    if (!consultant) continue;
    const rate = resolveBillRate(
      consultant,
      a.workstream_id,
      assignments,
      rateCards,
      period.end,
    );
    const existing = teamByConsultant.get(consultant.id);
    const wsLabel = workstreamName.get(a.workstream_id) ?? a.workstream_id;
    if (existing) {
      existing.allocation += a.allocation_pct;
      existing.workstreams.push(wsLabel);
      // The client sees one rate per person; the richest assignment wins.
      if (rate > existing.billRate) existing.billRate = rate;
    } else {
      teamByConsultant.set(consultant.id, {
        consultantId: consultant.id,
        name: consultant.name,
        grade: consultant.grade,
        practice: consultant.practice,
        allocation: a.allocation_pct,
        billRate: rate,
        workstreams: [wsLabel],
        hours: hoursByConsultant.get(consultant.id) ?? 0,
        aiCost: costByConsultant.get(consultant.id) ?? 0,
      });
    }
  }
  const team = [...teamByConsultant.values()]
    .map((t) => {
      const capacity = assignedCapacity.get(t.consultantId) ?? 0;
      return { ...t, allocation: capacity > 0 ? t.allocation / capacity : null };
    })
    .sort((a, b) => b.hours - a.hours);

  // ── Milestones
  const milestones = listMilestones(project.id);

  // ── Charts
  const burnCategories = billing.workstreams.map((w) => w.workstream.code);
  const laborCostSeries = billing.workstreams.map((w) => round2(w.laborCost));
  const aiCostSeries = billing.workstreams.map((w) => round2(w.ai.totalCost));
  const hasBurn = sum(laborCostSeries) + sum(aiCostSeries) > 0;

  const modelRows = usageByModel(period, project.id).map((m) => ({
    label: book.displayName(m.model),
    value: round2(m.cost),
    sub: `${tokens(
      m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens,
    )} tokens · ${count(m.requests)} requests`,
  }));

  // ── Untagged pool
  const allocatedTotal = round2(sum([...allocation.byWorkstream.values()]));
  const poolRows = billing.workstreams
    .map((w) => ({
      code: w.workstream.code,
      name: w.workstream.name,
      amount: allocation.byWorkstream.get(w.workstream.id) ?? 0,
      share: allocation.shareByWorkstream.get(w.workstream.id) ?? 0,
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const totals = {
    billableHours: sum(billing.workstreams.map((w) => w.billableHours)),
    laborBillable: round2(sum(billing.workstreams.map((w) => w.laborBillable))),
    aiCost: round2(sum(billing.workstreams.map((w) => w.ai.totalCost))),
    aiBillable: round2(sum(billing.workstreams.map((w) => w.aiBillable))),
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">{client.name}</div>
            <h1 className="page-title">{project.name}</h1>
            <p className="page-sub">
              <span className="mono">{project.code}</span> ·{" "}
              {ENGAGEMENT_LABEL[project.engagement_type]} · Partner{" "}
              {project.engagement_partner} · Delivery lead {project.delivery_lead} · PO{" "}
              <span className="mono">{project.po_number}</span> ·{" "}
              {usd(project.contract_value)} contract value ·{" "}
              {dateRange(project.start_date, project.end_date)}
            </p>
          </div>
          <div className="row">
            <PeriodPicker months={months} current={month} />
            <Link
              className="btn is-primary"
              href={`/projects/${project.id}/billing?month=${month}`}
            >
              Billing statement
            </Link>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="grid grid-4">
          <StatTile
            label={`Billable — ${monthLabel(month)}`}
            value={usd(billing.totalBillable)}
            foot={`${fmtHours(billing.billableHours)} billable of ${fmtHours(
              billing.hours,
            )} logged`}
          />
          <StatTile
            label="Gross margin"
            value={pct(billing.marginPct, 1)}
            foot={`${usd(billing.margin)} on ${usd(billing.totalCost)} cost to serve`}
          />
          <StatTile
            label="Claude cost"
            value={usdCents(billing.aiCost)}
            foot={`${pct(billing.aiCostShare, 1)} of cost to serve`}
          />
          <StatTile
            label="Effective rate"
            value={
              billing.effectiveRate == null ? "—" : `${usdCents(billing.effectiveRate)}/h`
            }
            foot="Total billable per billable hour"
          />
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Workstreams</div>
              <div className="card-sub">
                AI policy is inherited from the engagement default unless the workstream
                overrides it. The budget meter marks schedule elapsed.
              </div>
            </div>
          </div>
          <div className="card-body is-flush">
            {billing.workstreams.length === 0 ? (
              <div className="empty">This engagement has no workstreams.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Workstream</th>
                      <th>Status</th>
                      <th>AI policy</th>
                      <th className="num">Billable hrs</th>
                      <th className="num">Labor billable</th>
                      <th className="num">Claude cost</th>
                      <th className="num">AI billed</th>
                      <th className="num">Margin</th>
                      <th>Budget</th>
                      <th>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.workstreams.map((w) => {
                      const policy = effectivePolicy(w.workstream, project);
                      const lead = w.workstream.lead_consultant_id
                        ? consultants.get(w.workstream.lead_consultant_id)
                        : undefined;
                      return (
                        <tr key={w.workstream.id}>
                          <td>
                            <span className="cell-strong">
                              <span className="mono">{w.workstream.code}</span>{" "}
                              {w.workstream.name}
                            </span>
                            <span className="cell-sub">
                              {lead ? `Lead: ${lead.name}` : "No lead consultant assigned"}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={w.workstream.status} />
                          </td>
                          <td>
                            <PolicyBadge
                              policy={policy.policy}
                              markupPct={policy.markupPct}
                            />
                          </td>
                          <td className="num">{fmtHours(w.billableHours)}</td>
                          <td className="num">{usd(w.laborBillable)}</td>
                          <td className="num">{usdCents(w.ai.totalCost)}</td>
                          <td className="num">{usdCents(w.aiBillable)}</td>
                          <td
                            className={`num ${
                              w.marginPct != null && w.marginPct < 0.2 ? "bad" : ""
                            }`}
                          >
                            {pct(w.marginPct, 1)}
                          </td>
                          <td>
                            <Meter
                              pct={w.budget.amountPct}
                              markPct={w.budget.elapsedPct}
                              risk={w.budget.risk}
                            />
                          </td>
                          <td>
                            <RiskBadge
                              risk={w.budget.risk}
                              title={w.budget.riskReason}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>Total</td>
                      <td className="num">{fmtHours(totals.billableHours)}</td>
                      <td className="num">{usd(totals.laborBillable)}</td>
                      <td className="num">{usdCents(totals.aiCost)}</td>
                      <td className="num">{usdCents(totals.aiBillable)}</td>
                      <td className="num">{pct(billing.marginPct, 1)}</td>
                      <td />
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Budget burn by workstream</div>
                <div className="card-sub">
                  Labor cost and Claude cost, stacked so the composition of each
                  workstream is comparable.
                </div>
              </div>
            </div>
            <div className="card-body">
              {hasBurn ? (
                <StackedBarChart
                  categories={burnCategories}
                  series={[
                    { name: "Labor cost", slot: 1, values: laborCostSeries },
                    { name: "Claude cost", slot: 2, values: aiCostSeries },
                  ]}
                  horizontal
                  showTotals
                  ariaLabel={`Labor and Claude cost by workstream for ${project.name}, ${monthLabel(month)}`}
                />
              ) : (
                <div className="empty">No cost recorded against this engagement.</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Claude usage by model</div>
                <div className="card-sub">
                  Metered cost for sessions tagged to this engagement.
                </div>
              </div>
            </div>
            <div className="card-body">
              {modelRows.length === 0 ? (
                <div className="empty">No tagged Claude usage in this period.</div>
              ) : (
                <BarChart
                  rows={modelRows}
                  valueFormat="usdCents"
                  ariaLabel={`Claude cost by model for ${project.name}, ${monthLabel(month)}`}
                />
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Untagged usage</div>
              <div className="card-sub">
                How Claude sessions that carried no workstream tag reached this
                engagement.
              </div>
            </div>
          </div>
          <div className="card-body">
            {allocation.poolCost === 0 ? (
              <div className="empty">
                Every Claude session in this period was attributed to a workstream — no
                allocation was needed.
              </div>
            ) : (
              <>
                <div className="grid grid-4">
                  <div>
                    <div className="stat-label">Untagged pool</div>
                    <div className="hero-figure">{usdCents(allocation.poolCost)}</div>
                    <div className="stat-foot">
                      All untagged spend in the period for consultants who worked on this
                      engagement.
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Absorbed here</div>
                    <div className="hero-figure">{usdCents(allocatedTotal)}</div>
                    <div className="stat-foot">
                      Split across these workstreams pro-rata by the hours each consultant
                      logged to them.
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Other engagements</div>
                    <div className="hero-figure">
                      {usdCents(allocation.elsewhereCost)}
                    </div>
                    <div className="stat-foot">
                      The same consultants&rsquo; hours elsewhere claim this share, so no
                      client pays twice.
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Unallocable residual</div>
                    <div className="hero-figure">{usdCents(allocation.residualCost)}</div>
                    <div className="stat-foot">
                      Usage by consultants with no logged hours anywhere — reported, never
                      rebilled.
                    </div>
                  </div>
                </div>

                {poolRows.length === 0 ? (
                  <div className="empty">
                    None of the pool reached this engagement&rsquo;s workstreams.
                  </div>
                ) : (
                  <div>
                    <hr className="hairline" />
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Workstream</th>
                            <th className="num">Allocated</th>
                            <th className="num">Share of pool</th>
                          </tr>
                        </thead>
                        <tbody>
                          {poolRows.map((r) => (
                            <tr key={r.code}>
                              <td>
                                <span className="mono">{r.code}</span> {r.name}
                              </td>
                              <td className="num">{usdCents(r.amount)}</td>
                              <td className="num">{pct(r.share, 1)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td>Allocated to this engagement</td>
                            <td className="num">{usdCents(allocatedTotal)}</td>
                            <td className="num">
                              {pct(allocatedTotal / allocation.poolCost, 1)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Team</div>
              <div className="card-sub">
                Allocation is the share of each consultant&rsquo;s assigned capacity that
                sits on this engagement. Bill rates are resolved as at {fmtDate(period.end)}.
                Claude cost counts sessions tagged to this engagement plus the share of
                each consultant&rsquo;s untagged sessions their hours here claim, so the
                column foots to the Claude cost above.
              </div>
            </div>
          </div>
          <div className="card-body is-flush">
            {team.length === 0 ? (
              <div className="empty">No consultants are assigned to this engagement.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Consultant</th>
                      <th>Grade</th>
                      <th>Practice</th>
                      <th className="num">Allocation</th>
                      <th className="num">Bill rate</th>
                      <th className="num">Hours</th>
                      <th className="num">Claude cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((t) => (
                      <tr key={t.consultantId}>
                        <td>
                          <span className="cell-strong">{t.name}</span>
                          <span className="cell-sub">{t.workstreams.join(" · ")}</span>
                        </td>
                        <td className="nowrap">{GRADE_LABEL[t.grade]}</td>
                        <td>{t.practice}</td>
                        <td className="num">{pct(t.allocation, 0)}</td>
                        <td className="num">{usdCents(t.billRate)}/h</td>
                        <td className="num">{fmtHours(t.hours)}</td>
                        <td className="num">{usdCents(t.aiCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>
                        {team.length} {team.length === 1 ? "consultant" : "consultants"}
                      </td>
                      <td className="num">
                        {fmtHours(round2(sum(team.map((t) => t.hours))))}
                      </td>
                      <td className="num">
                        {usdCents(round2(sum(team.map((t) => t.aiCost))))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>

        {milestones.length > 0 ? (
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Milestones</div>
                <div className="card-sub">
                  Fixed-fee amounts bill in the period their milestone is delivered.
                </div>
              </div>
            </div>
            <div className="card-body is-flush">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Milestone</th>
                      <th>Workstream</th>
                      <th>Due</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {milestones.map((m) => (
                      <tr key={m.id}>
                        <td className="cell-strong">{m.name}</td>
                        <td>{workstreamName.get(m.workstream_id) ?? "—"}</td>
                        <td className="nowrap">{fmtDate(m.due_date)}</td>
                        <td className="num">{usd(m.amount)}</td>
                        <td>
                          <StatusBadge status={m.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>
                        {milestones.length}{" "}
                        {milestones.length === 1 ? "milestone" : "milestones"}
                      </td>
                      <td className="num">
                        {usd(round2(sum(milestones.map((m) => m.amount))))}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
