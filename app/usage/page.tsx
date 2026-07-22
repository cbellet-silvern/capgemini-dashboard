import { DonutChart, type DonutSlice } from "@/components/charts/DonutChart";
import { Heatmap } from "@/components/charts/Heatmap";
import {
  StackedBarChart,
  type StackedBarSeries,
} from "@/components/charts/StackedBarChart";
import { PeriodPicker } from "@/components/PeriodPicker";
import { StatTile } from "@/components/StatTile";
import { DEFAULT_BILLABLE_STATUSES } from "@/lib/billing";
import {
  availableMonths,
  listSeats,
  listTimeEntries,
  listUsage,
  pricingBook,
  resolvePeriod,
  unpricedModels,
  usageByConsultant,
} from "@/lib/queries";
import {
  count,
  hours as fmtHours,
  monthLabel,
  pct,
  shortDate,
  tokens as fmtTokens,
  usd,
  usdCompact,
  usdRate,
} from "@/lib/format";
import {
  ATTRIBUTION_LABEL,
  GRADE_LABEL,
  SURFACE_LABEL,
  type Attribution,
  type Surface,
} from "@/lib/types";

/** Slot assignment is fixed by tier, never by rank — a tier keeps its hue across months. */
const TIER_SLOTS: ReadonlyArray<{ tier: string; label: string; slot: number }> = [
  { tier: "frontier", label: "Frontier", slot: 5 },
  { tier: "opus", label: "Opus", slot: 1 },
  { tier: "sonnet", label: "Sonnet", slot: 2 },
  { tier: "haiku", label: "Haiku", slot: 3 },
];

const SURFACE_SLOTS: ReadonlyArray<{ surface: Surface; slot: number }> = [
  { surface: "claude_code", slot: 1 },
  { surface: "api", slot: 2 },
  { surface: "agent_sdk", slot: 3 },
  { surface: "claude_ai_seat", slot: 4 },
];

const ATTRIBUTION_SLOTS: ReadonlyArray<{ attribution: Attribution; slot: number }> = [
  { attribution: "tagged", slot: 1 },
  { attribution: "inferred", slot: 2 },
  { attribution: "unattributed", slot: 3 },
];

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** A DB string is not a union member until proven, so label maps are read defensively. */
function label<K extends string>(map: Readonly<Record<K, string>>, key: string): string {
  return (map as Record<string, string>)[key] ?? key;
}

/** Monday of the week containing `iso`, so heatmap columns are stable ISO weeks. */
function weekStart(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

interface Filters {
  month: string;
  surface?: string;
  model?: string;
  practice?: string;
}

/** Every chip link carries the other filters forward — a chip narrows, it never resets. */
function usageHref(f: Filters, patch: Partial<Filters>): string {
  const merged: Filters = { ...f, ...patch };
  const qs = new URLSearchParams();
  qs.set("month", merged.month);
  if (merged.surface) qs.set("surface", merged.surface);
  if (merged.model) qs.set("model", merged.model);
  if (merged.practice) qs.set("practice", merged.practice);
  return `/usage?${qs.toString()}`;
}

function ChipRow({
  title,
  filters,
  field,
  options,
}: {
  title: string;
  filters: Filters;
  field: "surface" | "model" | "practice";
  options: Array<{ value: string; label: string }>;
}) {
  if (options.length < 2) return null;
  const active = filters[field];
  const patch = (value: string | undefined): Partial<Filters> => {
    if (field === "surface") return { surface: value };
    if (field === "model") return { model: value };
    return { practice: value };
  };
  return (
    <div className="row-tight">
      <span className="micro muted nowrap">{title}</span>
      <a
        className={active ? "chip" : "chip is-active"}
        href={usageHref(filters, patch(undefined))}
      >
        All
      </a>
      {options.map((o) => (
        <a
          key={o.value}
          className={active === o.value ? "chip is-active" : "chip"}
          href={usageHref(filters, patch(o.value))}
        >
          {o.label}
        </a>
      ))}
    </div>
  );
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { month, period } = resolvePeriod(first(sp.month));
  const months = availableMonths();
  const pricing = pricingBook();

  const allRows = listUsage(period);
  const roster = usageByConsultant(period);
  const practiceOf = new Map(roster.map((r) => [r.consultant_id, r.practice]));

  const filters: Filters = {
    month,
    surface: first(sp.surface),
    model: first(sp.model),
    practice: first(sp.practice),
  };

  // Filter options come from the unfiltered month so the chip rows never shrink
  // out from under the reader as they narrow.
  const surfaceOptions = SURFACE_SLOTS.filter((s) =>
    allRows.some((r) => r.surface === s.surface),
  ).map((s) => ({ value: s.surface, label: SURFACE_LABEL[s.surface] }));

  const modelCost = new Map<string, number>();
  for (const r of allRows) modelCost.set(r.model, (modelCost.get(r.model) ?? 0) + r.cost_usd);
  const modelOptions = [...modelCost.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => ({ value: m, label: pricing.displayName(m) }));

  const practiceOptions = [...new Set(roster.map((r) => r.practice))]
    .filter((p) => p !== "")
    .sort()
    .map((p) => ({ value: p, label: p }));

  const rows = allRows.filter((r) => {
    if (filters.surface && r.surface !== filters.surface) return false;
    if (filters.model && r.model !== filters.model) return false;
    if (filters.practice && practiceOf.get(r.consultant_id) !== filters.practice) return false;
    return true;
  });

  const rosterInScope = filters.practice
    ? roster.filter((r) => r.practice === filters.practice)
    : roster;

  let totalCost = 0;
  let totalTokens = 0;
  let totalSessions = 0;
  let totalRequests = 0;
  for (const r of rows) {
    totalCost += r.cost_usd;
    totalTokens +=
      r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
    totalSessions += r.sessions;
    totalRequests += r.requests;
  }

  const dailyCost = new Map<string, number>();
  const tierByDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    dailyCost.set(r.usage_date, (dailyCost.get(r.usage_date) ?? 0) + r.cost_usd);
    let byTier = tierByDay.get(r.usage_date);
    if (!byTier) {
      byTier = new Map<string, number>();
      tierByDay.set(r.usage_date, byTier);
    }
    const tier = pricing.tier(r.model);
    byTier.set(tier, (byTier.get(tier) ?? 0) + r.cost_usd);
  }
  const days = [...dailyCost.keys()].sort();
  const dailyValues = days.map((d) => dailyCost.get(d) ?? 0);

  const tierSeries: StackedBarSeries[] = [];
  for (const t of TIER_SLOTS) {
    const values = days.map((d) => tierByDay.get(d)?.get(t.tier) ?? 0);
    // A tier with no spend this month gets no series — an empty stack segment
    // still burns a legend row and a hue.
    if (values.some((v) => v > 0)) {
      tierSeries.push({ name: t.label, slot: t.slot, values });
    }
  }
  const knownTiers = new Set(TIER_SLOTS.map((t) => t.tier));
  const otherValues = days.map((d) => {
    let other = 0;
    const byTier = tierByDay.get(d);
    if (byTier) {
      for (const [tier, cost] of byTier) if (!knownTiers.has(tier)) other += cost;
    }
    return other;
  });
  if (otherValues.some((v) => v > 0)) {
    tierSeries.push({ name: "Other", slot: 8, values: otherValues });
  }

  interface ModelAgg {
    model: string;
    cost: number;
    requests: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }
  const modelAgg = new Map<string, ModelAgg>();
  for (const r of rows) {
    let m = modelAgg.get(r.model);
    if (!m) {
      m = {
        model: r.model,
        cost: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      modelAgg.set(r.model, m);
    }
    m.cost += r.cost_usd;
    m.requests += r.requests;
    m.input += r.input_tokens;
    m.output += r.output_tokens;
    m.cacheRead += r.cache_read_tokens;
    m.cacheWrite += r.cache_write_tokens;
  }
  const models = [...modelAgg.values()].sort((a, b) => b.cost - a.cost);
  const modelTotals = models.reduce(
    (acc, m) => ({
      cost: acc.cost + m.cost,
      requests: acc.requests + m.requests,
      input: acc.input + m.input,
      output: acc.output + m.output,
      cacheRead: acc.cacheRead + m.cacheRead,
      cacheWrite: acc.cacheWrite + m.cacheWrite,
    }),
    { cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const blended = (cost: number, tokenTotal: number): string =>
    tokenTotal > 0 ? usdRate(cost / (tokenTotal / 1_000_000)) : "—";

  const surfaceCost = new Map<string, number>();
  for (const r of rows) surfaceCost.set(r.surface, (surfaceCost.get(r.surface) ?? 0) + r.cost_usd);
  const slices: DonutSlice[] = SURFACE_SLOTS.filter(
    (s) => (surfaceCost.get(s.surface) ?? 0) > 0,
  ).map((s) => ({
    name: SURFACE_LABEL[s.surface],
    value: surfaceCost.get(s.surface) ?? 0,
    slot: s.slot,
  }));

  const attributionCost = new Map<string, number>();
  for (const r of rows) {
    attributionCost.set(r.attribution, (attributionCost.get(r.attribution) ?? 0) + r.cost_usd);
  }
  const untaggedCost = attributionCost.get("unattributed") ?? 0;
  const taggedCost = attributionCost.get("tagged") ?? 0;
  const coverage = totalCost > 0 ? (totalCost - untaggedCost) / totalCost : null;
  const taggedShare = totalCost > 0 ? taggedCost / totalCost : null;
  const attributionSeries: StackedBarSeries[] = ATTRIBUTION_SLOTS.map((a) => ({
    name: ATTRIBUTION_LABEL[a.attribution],
    slot: a.slot,
    values: [attributionCost.get(a.attribution) ?? 0],
  })).filter((s) => (s.values[0] ?? 0) > 0);

  // `usageByConsultant` sums every logged hour — non-billable and unapproved
  // included — so it cannot be the denominator of a per-billable-hour rate. The
  // billable set is the engine's own: billable = 1 and a status a client can be
  // charged for, so this tile and the project pages count the same hours.
  const billableHoursByConsultant = new Map<string, number>();
  for (const t of listTimeEntries({ period, statuses: DEFAULT_BILLABLE_STATUSES })) {
    if (t.billable !== 1) continue;
    const prior = billableHoursByConsultant.get(t.consultant_id) ?? 0;
    billableHoursByConsultant.set(t.consultant_id, prior + t.hours);
  }

  const hoursInScope = rosterInScope.reduce((t, r) => t + r.hours, 0);
  const billableHoursInScope = rosterInScope.reduce(
    (t, r) => t + (billableHoursByConsultant.get(r.consultant_id) ?? 0),
    0,
  );
  const costPerHour =
    billableHoursInScope > 0 ? totalCost / billableHoursInScope : null;

  interface PersonAgg {
    id: string;
    name: string;
    grade: string;
    practice: string;
    hours: number;
    cost: number;
    sessions: number;
    tokens: number;
  }
  const people = new Map<string, PersonAgg>();
  for (const r of rosterInScope) {
    people.set(r.consultant_id, {
      id: r.consultant_id,
      name: r.consultant_name,
      grade: r.grade,
      practice: r.practice,
      hours: r.hours,
      cost: 0,
      sessions: 0,
      tokens: 0,
    });
  }
  const weekly = new Map<string, Map<string, number>>();
  const weeks = new Set<string>();
  for (const r of rows) {
    const p = people.get(r.consultant_id);
    if (!p) continue;
    p.cost += r.cost_usd;
    p.sessions += r.sessions;
    p.tokens +=
      r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;

    const w = weekStart(r.usage_date);
    weeks.add(w);
    let byWeek = weekly.get(r.consultant_id);
    if (!byWeek) {
      byWeek = new Map<string, number>();
      weekly.set(r.consultant_id, byWeek);
    }
    byWeek.set(w, (byWeek.get(w) ?? 0) + r.cost_usd);
  }
  const ranked = [...people.values()].filter((p) => p.cost > 0 || p.hours > 0);
  ranked.sort((a, b) => b.cost - a.cost || b.hours - a.hours);

  const heatPeople = ranked.filter((p) => p.cost > 0).slice(0, 20);
  const weekColumns = [...weeks].sort().map((w) => ({ key: w, label: shortDate(w) }));
  const heatValues: Array<{ row: string; col: string; value: number }> = [];
  for (const p of heatPeople) {
    const byWeek = weekly.get(p.id);
    if (!byWeek) continue;
    for (const c of weekColumns) {
      const v = byWeek.get(c.key);
      if (v !== undefined && v > 0) heatValues.push({ row: p.id, col: c.key, value: v });
    }
  }

  const adoption = ranked.slice(0, 25);
  const adoptionTotals = adoption.reduce(
    (acc, p) => ({
      hours: acc.hours + p.hours,
      cost: acc.cost + p.cost,
      sessions: acc.sessions + p.sessions,
      tokens: acc.tokens + p.tokens,
    }),
    { hours: 0, cost: 0, sessions: 0, tokens: 0 },
  );

  const seats = listSeats(month);
  const seatByPlan = new Map<string, { plan: string; seats: number; cost: number }>();
  for (const s of seats) {
    let bucket = seatByPlan.get(s.plan);
    if (!bucket) {
      bucket = { plan: s.plan, seats: 0, cost: 0 };
      seatByPlan.set(s.plan, bucket);
    }
    bucket.seats += 1;
    bucket.cost += s.monthly_cost;
  }
  const seatPlans = [...seatByPlan.values()].sort((a, b) => b.cost - a.cost);
  const seatTotal = seatPlans.reduce((t, p) => t + p.cost, 0);
  const seatCount = seatPlans.reduce((t, p) => t + p.seats, 0);

  const unpriced = unpricedModels();

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Analysis</div>
            <h1 className="page-title">Claude usage</h1>
            <p className="page-sub">
              Cost is metered from token counts, priced at the rate in effect on the
              usage date — not at today&rsquo;s rate. Repricing a model is therefore
              never retroactive to an issued invoice.
            </p>
          </div>
          <PeriodPicker months={months} current={month} />
        </div>
        <div className="toolbar">
          <div className="stack">
            <ChipRow
              title="Surface"
              filters={filters}
              field="surface"
              options={surfaceOptions}
            />
            <ChipRow title="Model" filters={filters} field="model" options={modelOptions} />
            <ChipRow
              title="Practice"
              filters={filters}
              field="practice"
              options={practiceOptions}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-5">
        <StatTile
          label="Claude cost"
          value={usdCompact(totalCost)}
          foot={`${monthLabel(month)} · metered from tokens`}
          spark={dailyValues}
          sparkSlot={1}
        />
        <StatTile
          label="Tokens processed"
          value={fmtTokens(totalTokens)}
          foot={`${count(totalRequests)} requests`}
        />
        <StatTile
          label="Sessions"
          value={count(totalSessions)}
          foot={`${count(ranked.filter((p) => p.cost > 0).length)} consultants active`}
        />
        <StatTile
          label="Cost per billable hour"
          value={costPerHour === null ? "—" : usdRate(costPerHour)}
          foot={`${fmtHours(billableHoursInScope)} billable of ${fmtHours(
            hoursInScope,
          )} logged`}
        />
        <StatTile
          label="Attribution coverage"
          value={pct(coverage)}
          delta={{ pct: taggedShare, label: "tagged outright", goodWhenUp: true }}
          foot={`${usd(untaggedCost)} untagged`}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Daily cost by model tier</h2>
            <p className="card-sub">
              Metered cost per day, split by the tier of the model that served the
              request.
            </p>
          </div>
        </div>
        <div className="card-body">
          {days.length === 0 || tierSeries.length === 0 ? (
            <p className="empty">No Claude usage recorded for this selection.</p>
          ) : (
            <StackedBarChart
              categories={days}
              series={tierSeries}
              xIsDate
              yFormat="usd"
              ariaLabel="Daily Claude cost by model tier"
            />
          )}
        </div>
      </div>

      <div className="grid grid-2">
        {/* Nine numeric columns do not fit half a 1440px page: the dense table
            takes the full row and the two composition cards share the next. */}
        <div className="card span-full">
          <div className="card-head">
            <div>
              <h2 className="card-title">Cost by model</h2>
              <p className="card-sub">
                Cache reads are the largest token bucket and the cheapest per million —
                the blended rate is what the mix actually costs.
              </p>
            </div>
          </div>
          <div className="card-body is-flush">
            {models.length === 0 ? (
              <p className="empty">No model usage for this selection.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Tier</th>
                      <th className="num">Requests</th>
                      <th className="num">Input</th>
                      <th className="num">Output</th>
                      <th className="num">Cache read</th>
                      <th className="num">Cache write</th>
                      <th className="num">Blended $/MTok</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => {
                      const tokenTotal = m.input + m.output + m.cacheRead + m.cacheWrite;
                      return (
                        <tr key={m.model}>
                          <td>
                            <span className="cell-strong">{pricing.displayName(m.model)}</span>
                            {/* A model id is one token — breaking it mid-slug
                                makes it unreadable and unsearchable. */}
                            <span className="cell-sub mono nowrap">{m.model}</span>
                          </td>
                          <td className="nowrap">{pricing.tier(m.model)}</td>
                          <td className="num tnum">{count(m.requests)}</td>
                          <td className="num tnum">{fmtTokens(m.input)}</td>
                          <td className="num tnum">{fmtTokens(m.output)}</td>
                          <td className="num tnum">{fmtTokens(m.cacheRead)}</td>
                          <td className="num tnum">{fmtTokens(m.cacheWrite)}</td>
                          <td className="num tnum">{blended(m.cost, tokenTotal)}</td>
                          <td className="num tnum">{usd(m.cost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td />
                      <td className="num tnum">{count(modelTotals.requests)}</td>
                      <td className="num tnum">{fmtTokens(modelTotals.input)}</td>
                      <td className="num tnum">{fmtTokens(modelTotals.output)}</td>
                      <td className="num tnum">{fmtTokens(modelTotals.cacheRead)}</td>
                      <td className="num tnum">{fmtTokens(modelTotals.cacheWrite)}</td>
                      <td className="num tnum">
                        {blended(
                          modelTotals.cost,
                          modelTotals.input +
                            modelTotals.output +
                            modelTotals.cacheRead +
                            modelTotals.cacheWrite,
                        )}
                      </td>
                      <td className="num tnum">{usd(modelTotals.cost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Cost by surface</h2>
              <p className="card-sub">Where the spend originates.</p>
            </div>
          </div>
          <div className="card-body">
            {slices.length === 0 ? (
              <p className="empty">No usage to split by surface.</p>
            ) : (
              <DonutChart
                slices={slices}
                centerLabel="Total"
                centerValue={usdCompact(totalCost)}
                valueFormat="usd"
                ariaLabel="Claude cost by surface"
              />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Attribution quality</h2>
              <p className="card-sub">
                How confidently the period&rsquo;s Claude cost ties to a workstream.
              </p>
            </div>
          </div>
          <div className="card-body">
            {attributionSeries.length === 0 ? (
              <p className="empty">No usage to attribute in this period.</p>
            ) : (
              <StackedBarChart
                categories={["Claude cost"]}
                series={attributionSeries}
                horizontal
                height={140}
                yFormat="usd"
                ariaLabel="Claude cost by attribution confidence"
              />
            )}
            <p className="small muted">
              {usd(untaggedCost)} of cost carried no workstream tag ({pct(
                totalCost > 0 ? untaggedCost / totalCost : null,
              )}{" "}
              of the period). It is allocated to workstreams pro-rata by the same
              consultant&rsquo;s logged hours, so a client is never charged for a
              consultant who did not work on their engagement.
            </p>
            {unpriced.length > 0 ? (
              <div className="callout is-warn">
                No rate in effect for {unpriced.join(", ")} when{" "}
                {unpriced.length === 1 ? "its" : "their"} usage was metered. That usage
                is counted at zero cost until a rate covering the date is added on
                Settings — the tokens are real, the money is missing.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Usage by consultant and week</h2>
            <p className="card-sub">
              Top 20 consultants by Claude cost in the period; everyone else is
              excluded from the grid, not from the totals above.
            </p>
          </div>
        </div>
        <div className="card-body">
          {heatPeople.length === 0 || weekColumns.length === 0 ? (
            <p className="empty">No consultant usage for this selection.</p>
          ) : (
            <Heatmap
              rows={heatPeople.map((p) => ({
                key: p.id,
                label: p.name,
                sub: `${label(GRADE_LABEL, p.grade)} · ${p.practice}`,
              }))}
              columns={weekColumns}
              values={heatValues}
              valueFormat="usd"
              scaleLabel="Claude cost per consultant-week"
              ariaLabel="Claude cost per consultant per week"
            />
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Adoption and leverage</h2>
            <p className="card-sub">
              A high cost per hour worked is not a verdict — it is the signal to look
              at. Read it next to what the hour delivered before drawing a conclusion.
            </p>
          </div>
        </div>
        <div className="card-body is-flush">
          {adoption.length === 0 ? (
            <p className="empty">No consultants with usage or hours in this period.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption className="micro muted">
                  Top {adoption.length} of {count(ranked.length)} consultants, by Claude
                  cost.
                </caption>
                <thead>
                  <tr>
                    <th>Consultant</th>
                    <th>Grade</th>
                    <th>Practice</th>
                    <th className="num">Hours</th>
                    <th className="num">Claude cost</th>
                    <th className="num">Per hour</th>
                    <th className="num">Sessions</th>
                    <th className="num">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {adoption.map((p) => (
                    <tr key={p.id}>
                      <td className="cell-strong">{p.name}</td>
                      <td className="nowrap">{label(GRADE_LABEL, p.grade)}</td>
                      <td className="nowrap">{p.practice}</td>
                      <td className="num tnum">{fmtHours(p.hours)}</td>
                      <td className="num tnum">{usd(p.cost)}</td>
                      <td className="num tnum">
                        {p.hours > 0 ? usdRate(p.cost / p.hours) : "—"}
                      </td>
                      <td className="num tnum">{count(p.sessions)}</td>
                      <td className="num tnum">{fmtTokens(p.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Shown total</td>
                    <td />
                    <td />
                    <td className="num tnum">{fmtHours(adoptionTotals.hours)}</td>
                    <td className="num tnum">{usd(adoptionTotals.cost)}</td>
                    <td className="num tnum">
                      {adoptionTotals.hours > 0
                        ? usdRate(adoptionTotals.cost / adoptionTotals.hours)
                        : "—"}
                    </td>
                    <td className="num tnum">{count(adoptionTotals.sessions)}</td>
                    <td className="num tnum">{fmtTokens(adoptionTotals.tokens)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Seat cost</h2>
            <p className="card-sub">{monthLabel(month)} Claude subscriptions.</p>
          </div>
        </div>
        <div className="card-body is-flush">
          {seatPlans.length === 0 ? (
            <p className="empty">No seats recorded for {monthLabel(month)}.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th className="num">Seats</th>
                    <th className="num">Monthly each</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {seatPlans.map((p) => (
                    <tr key={p.plan}>
                      <td className="cell-strong">
                        {p.plan === "enterprise" ? "Enterprise" : "Team"}
                      </td>
                      <td className="num tnum">{count(p.seats)}</td>
                      <td className="num tnum">
                        {p.seats > 0 ? usd(p.cost / p.seats) : "—"}
                      </td>
                      <td className="num tnum">{usd(p.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="num tnum">{count(seatCount)}</td>
                    <td />
                    <td className="num tnum">{usd(seatTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        <div className="card-foot">
          <span className="small muted">
            Seat cost is allocated, not metered: it is a flat monthly subscription per
            person, so it never appears in any token-based line above.
          </span>
        </div>
      </div>
    </div>
  );
}
