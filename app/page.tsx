import Link from "next/link";

import { BarChart, type BarChartRow } from "@/components/charts/BarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { LineChart, type LineSeries } from "@/components/charts/LineChart";
import {
  StackedBarChart,
  type StackedBarSeries,
} from "@/components/charts/StackedBarChart";
import { RiskBadge } from "@/components/Badge";
import { Meter } from "@/components/Meter";
import { PeriodPicker } from "@/components/PeriodPicker";
import { StatTile } from "@/components/StatTile";
import {
  allProjectBillingInputs,
  availableMonths,
  dataSpan,
  monthPeriod,
  resolvePeriod,
  usageCostByDay,
  usageCostByDayAndTier,
  usageCostByMonth,
} from "@/lib/queries";
import { computePortfolio, computeProjectBilling } from "@/lib/billing";
import {
  count,
  date,
  dateRange,
  hours,
  monthLabel,
  pct,
  usd,
  usdCompact,
} from "@/lib/format";
import type {
  EngagementType,
  Period,
  ProjectBilling,
  WorkstreamBilling,
} from "@/lib/types";

const ENGAGEMENT_LABEL: Record<EngagementType, string> = {
  time_and_materials: "T&M",
  capped_tm: "Capped T&M",
  fixed_fee: "Fixed fee",
};

/** Tier → series slot. Fixed, so a tier keeps its colour when the mix changes. */
const TIER_SLOTS: Array<{ tier: string; name: string; slot: number }> = [
  { tier: "frontier", name: "Frontier", slot: 5 },
  { tier: "opus", name: "Opus", slot: 1 },
  { tier: "sonnet", name: "Sonnet", slot: 2 },
  { tier: "haiku", name: "Haiku", slot: 3 },
];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function deltaPct(current: number, prior: number | null): number | null {
  if (prior == null || prior === 0) return null;
  return (current - prior) / prior;
}

/** ISO date arithmetic in UTC, so a date never shifts a day across timezones. */
function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + days * 86_400_000);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** Inclusive day count: 2026-07-01 → 2026-07-21 is 21 days. */
function dayCount(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The workstream furthest through its hours budget — the one worth surfacing. */
function worstBurn(b: ProjectBilling): WorkstreamBilling | null {
  let worst: WorkstreamBilling | null = null;
  for (const w of b.workstreams) {
    if (worst == null || (w.budget.hoursPct ?? -1) > (worst.budget.hoursPct ?? -1)) {
      worst = w;
    }
  }
  return worst;
}

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const months = availableMonths();
  const { month, period } = resolvePeriod(first(sp.month));

  const billings = allProjectBillingInputs(period).map(computeProjectBilling);
  const portfolio = computePortfolio(billings);

  // The newest month is still running: the picker's period covers the whole
  // calendar month, but the data stops part-way through it. Measuring a partial
  // month against a whole one reads as revenue collapsing, so the comparison is
  // trimmed to the same number of days — month-to-date against month-to-date.
  const span = dataSpan();
  const isPartial = period.end > span.end;
  const effective: Period = isPartial ? { start: period.start, end: span.end } : period;

  // Prior month is the previous month *present in the data*, not the calendar
  // one — a gap would otherwise read as a total collapse in billing.
  const priorMonth = months[months.indexOf(month) + 1];
  let priorPeriod: Period | null = null;
  let priorLabel = "";
  if (priorMonth) {
    const priorWhole = monthPeriod(priorMonth);
    if (isPartial) {
      const elapsed = addDays(
        priorWhole.start,
        dayCount(effective.start, effective.end) - 1,
      );
      // A shorter prior month must not overflow into the one after it: 31 days of
      // March map onto 1–28 Feb, not 1–3 Mar.
      const end = elapsed > priorWhole.end ? priorWhole.end : elapsed;
      priorPeriod = { start: priorWhole.start, end };
      priorLabel = `vs ${dateRange(priorPeriod.start, priorPeriod.end)}`;
    } else {
      priorPeriod = priorWhole;
      priorLabel = `vs ${monthLabel(priorMonth)}`;
    }
  }
  const prior = priorPeriod
    ? computePortfolio(allProjectBillingInputs(priorPeriod).map(computeProjectBilling))
    : null;

  const spark = usageCostByDay(period).map((d) => d.cost);

  const tierRows = usageCostByDayAndTier(period);
  const days: string[] = [];
  for (const r of tierRows) if (!days.includes(r.date)) days.push(r.date);
  days.sort();
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const knownTiers = new Set(TIER_SLOTS.map((t) => t.tier));
  const tierValues = new Map<string, number[]>(
    TIER_SLOTS.map((t) => [t.tier, days.map(() => 0)]),
  );
  const otherValues = days.map(() => 0);
  for (const r of tierRows) {
    const i = dayIndex.get(r.date);
    if (i === undefined) continue;
    // An unpriced model joins to a null tier. Dropping it would make the bars
    // total less than the Claude cost tile above, so it lands in "Other".
    const values =
      r.tier !== null && knownTiers.has(r.tier) ? tierValues.get(r.tier) : otherValues;
    if (!values) continue;
    values[i] = (values[i] ?? 0) + r.cost;
  }
  const tierSeries: StackedBarSeries[] = TIER_SLOTS.flatMap((t) => {
    const values = tierValues.get(t.tier);
    if (!values || values.every((v) => v === 0)) return [];
    return [{ name: t.name, slot: t.slot, values }];
  });
  // Slot 8 is reserved for the residual so the four known tiers keep their hues.
  if (otherValues.some((v) => v !== 0)) {
    tierSeries.push({ name: "Other", slot: 8, values: otherValues });
  }

  // The trend deliberately ignores the period picker: the question is whether
  // spend is growing, which only the full history can answer.
  const monthlyCost = usageCostByMonth();
  const trendSeries: LineSeries[] = [
    {
      name: "Claude cost",
      slot: 2,
      points: monthlyCost.map((m) => ({ x: monthLabel(m.month), y: m.cost })),
    },
  ];

  const ranked = [...billings].sort((a, b) => b.totalBillable - a.totalBillable);

  const atRisk: Array<{ project: ProjectBilling; ws: WorkstreamBilling }> = [];
  for (const b of billings) {
    for (const w of b.workstreams) {
      if (w.budget.risk !== "ok") atRisk.push({ project: b, ws: w });
    }
  }
  atRisk.sort((a, b) => b.ws.budget.projectedOverrun - a.ws.budget.projectedOverrun);
  const atRiskProjects = new Set(atRisk.map((r) => r.project.project.id)).size;

  const aiRows: BarChartRow[] = billings
    .flatMap((b) =>
      b.workstreams.map((w) => ({
        label: w.workstream.name,
        value: w.ai.totalCost,
        sub: b.project.code,
        href: `/projects/${b.project.id}`,
        slot: 2,
      })),
    )
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const costSlices = [
    { name: "Consultant labour", value: portfolio.laborCost, slot: 1 },
    { name: "Claude", value: portfolio.aiCost, slot: 2 },
  ].filter((s) => s.value > 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Portfolio</div>
            <h1 className="page-title">Engagement ledger</h1>
            <p className="page-sub">
              {count(portfolio.projects)} engagements across {count(portfolio.clients)}{" "}
              clients, {dateRange(period.start, period.end)}. Billable value, cost to
              serve, and where Claude spend is landing.
              {isPartial ? (
                <>
                  {" "}
                  {monthLabel(month)} is a partial month — data runs through{" "}
                  {date(span.end)}, so the comparisons below are month-to-date.
                </>
              ) : null}
            </p>
          </div>
          <PeriodPicker months={months} current={month} />
        </div>
      </div>

      <div className="stack">
        <div className="grid grid-5">
          <StatTile
            label="Billable this period"
            value={usdCompact(portfolio.totalBillable)}
            delta={
              prior
                ? {
                    pct: deltaPct(portfolio.totalBillable, prior.totalBillable),
                    label: priorLabel,
                    goodWhenUp: true,
                  }
                : null
            }
            foot={`${hours(portfolio.billableHours)} billable · spark: daily Claude cost`}
            spark={spark}
            sparkSlot={2}
          />
          <StatTile
            label="Gross margin"
            value={pct(portfolio.marginPct, 1)}
            delta={
              prior
                ? {
                    pct: deltaPct(portfolio.marginPct ?? 0, prior.marginPct),
                    label: priorLabel,
                    goodWhenUp: true,
                  }
                : null
            }
            foot={`${usd(portfolio.margin)} margin on ${usd(portfolio.totalCost)} cost`}
          />
          <StatTile
            label="Claude cost"
            value={usdCompact(portfolio.aiCost)}
            delta={
              prior
                ? {
                    pct: deltaPct(portfolio.aiCost, prior.aiCost),
                    label: priorLabel,
                    goodWhenUp: false,
                  }
                : null
            }
            foot={`${pct(portfolio.aiCostShare, 1)} of cost to serve`}
          />
          <StatTile
            label="Effective rate"
            value={
              portfolio.effectiveRate == null ? "—" : `${usd(portfolio.effectiveRate)}/h`
            }
            foot={`${hours(portfolio.billableHours)} billable hours`}
          />
          <StatTile
            label="Workstreams at risk"
            value={count(atRisk.length)}
            delta={{
              pct: null,
              label: atRisk.length > 0 ? "needs review" : "all tracking",
              goodWhenUp: false,
            }}
            foot={`across ${count(atRiskProjects)} of ${count(
              portfolio.projects,
            )} engagements`}
          />
        </div>

        <div className="grid grid-sidebar">
          <section className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Claude cost by day and model tier</div>
                <div className="card-sub">
                  Metered Claude cost by model tier,{" "}
                  {dateRange(period.start, period.end)}
                </div>
              </div>
            </div>
            <div className="card-body">
              {tierSeries.length === 0 ? (
                <p className="empty">No Claude usage recorded in this period.</p>
              ) : (
                <StackedBarChart
                  categories={days}
                  series={tierSeries}
                  xIsDate
                  yFormat="usd"
                  ariaLabel={`Daily Claude cost by model tier, ${monthLabel(month)}`}
                />
              )}
            </div>
            <div className="card-foot">
              <span className="small dim">
                Billable value sits two orders of magnitude above Claude cost; it is
                reported per engagement below rather than on this axis.
              </span>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Cost to serve</div>
                <div className="card-sub">Consultant labour versus Claude</div>
              </div>
            </div>
            <div className="card-body">
              {costSlices.length === 0 ? (
                <p className="empty">No cost recorded in this period.</p>
              ) : (
                <DonutChart
                  slices={costSlices}
                  centerLabel="Cost to serve"
                  centerValue={usdCompact(portfolio.totalCost)}
                  ariaLabel={`Cost to serve composition, ${monthLabel(month)}`}
                />
              )}
            </div>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Claude cost trend by month</div>
              <div className="card-sub">
                Metered Claude cost for the whole portfolio, every month on record.
                This is what Claude cost us to run — not what was rebilled to
                clients.
              </div>
            </div>
          </div>
          <div className="card-body">
            {monthlyCost.length === 0 ? (
              <p className="empty">No Claude usage recorded in any month.</p>
            ) : (
              <LineChart
                series={trendSeries}
                area
                yFormat="usd"
                xIsDate={false}
                ariaLabel="Total metered Claude cost per month across the portfolio"
              />
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Engagement margin</div>
              <div className="card-sub">
                Every engagement for {monthLabel(month)}, highest billable first
              </div>
            </div>
          </div>
          {ranked.length === 0 ? (
            <div className="card-body">
              <p className="empty">No engagements have activity in this period.</p>
            </div>
          ) : (
            <div className="card-body is-flush">
              <div className="table-wrap">
                <table className="data">
                  <caption>
                    Billable, cost and margin by engagement,{" "}
                    {dateRange(period.start, period.end)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Engagement</th>
                      <th scope="col">Client</th>
                      <th scope="col">Type</th>
                      <th scope="col" className="num">
                        Billable
                      </th>
                      <th scope="col" className="num">
                        Cost
                      </th>
                      <th scope="col" className="num">
                        Claude cost
                      </th>
                      <th scope="col" className="num">
                        Margin
                      </th>
                      <th scope="col">Worst workstream burn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((b) => {
                      const worst = worstBurn(b);
                      return (
                        <tr key={b.project.id}>
                          <td>
                            <Link
                              href={`/projects/${b.project.id}`}
                              className="cell-strong"
                            >
                              {b.project.code}
                            </Link>
                            <span className="cell-sub">{b.project.name}</span>
                          </td>
                          <td>{b.client.name}</td>
                          <td className="small dim nowrap">
                            {ENGAGEMENT_LABEL[b.project.engagement_type]}
                          </td>
                          <td className="num">{usd(b.totalBillable)}</td>
                          <td className="num">{usd(b.totalCost)}</td>
                          <td className="num">{usd(b.aiCost)}</td>
                          <td className="num">{pct(b.marginPct, 1)}</td>
                          <td>
                            {worst == null ? (
                              <span className="muted small">No workstreams</span>
                            ) : (
                              <>
                                <div className="meter-row">
                                  <Meter
                                    pct={worst.budget.hoursPct}
                                    markPct={worst.budget.elapsedPct}
                                    risk={worst.budget.risk}
                                  />
                                  <RiskBadge
                                    risk={worst.budget.risk}
                                    title={worst.budget.riskReason}
                                  />
                                </div>
                                <span className="cell-sub">{worst.workstream.name}</span>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Portfolio</td>
                      <td>{count(portfolio.clients)} clients</td>
                      <td />
                      <td className="num">{usd(portfolio.totalBillable)}</td>
                      <td className="num">{usd(portfolio.totalCost)}</td>
                      <td className="num">{usd(portfolio.aiCost)}</td>
                      <td className="num">{pct(portfolio.marginPct, 1)}</td>
                      <td className="small dim">
                        {count(atRisk.length)} workstreams at risk
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">At-risk workstreams</div>
              <div className="card-sub">
                Budget exceeded, or run rate projecting an overrun
              </div>
            </div>
          </div>
          {atRisk.length === 0 ? (
            <div className="card-body">
              <p className="empty">
                Every workstream is tracking within budget this period.
              </p>
            </div>
          ) : (
            <div className="card-body is-flush">
              <div className="table-wrap">
                <table className="data">
                  <caption>
                    Workstreams flagged watch or over, {monthLabel(month)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Workstream</th>
                      <th scope="col">Status</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Hours vs budget</th>
                      <th scope="col" className="num">
                        Projected overrun
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {atRisk.map(({ project, ws }) => (
                      <tr key={ws.workstream.id}>
                        <td>
                          <span className="cell-strong">{ws.workstream.name}</span>
                          <span className="cell-sub">
                            <Link href={`/projects/${project.project.id}`}>
                              {project.project.code}
                            </Link>{" "}
                            · {project.client.name}
                          </span>
                        </td>
                        <td>
                          <RiskBadge risk={ws.budget.risk} />
                        </td>
                        <td className="small dim">{ws.budget.riskReason}</td>
                        <td>
                          <Meter
                            pct={ws.budget.hoursPct}
                            markPct={ws.budget.elapsedPct}
                            risk={ws.budget.risk}
                          />
                          <span className="cell-sub">
                            {hours(ws.budget.hoursUsed)} of{" "}
                            {hours(ws.budget.budgetHours)} budgeted
                          </span>
                        </td>
                        <td className="num">
                          {ws.budget.projectedOverrun > 0
                            ? usd(ws.budget.projectedOverrun)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Where Claude cost lands</div>
              <div className="card-sub">
                Top workstreams by metered Claude cost, {monthLabel(month)}
              </div>
            </div>
          </div>
          <div className="card-body">
            {aiRows.length === 0 ? (
              <p className="empty">No Claude cost attributed to a workstream.</p>
            ) : (
              <BarChart
                rows={aiRows}
                valueFormat="usd"
                ariaLabel={`Top workstreams by Claude cost, ${monthLabel(month)}`}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
