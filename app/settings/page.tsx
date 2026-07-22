import { Fragment } from "react";

import { setPolicyAction, setSettingAction } from "@/app/actions";
import { Badge, PolicyBadge } from "@/components/Badge";
import { date, pct, usd, usdRate } from "@/lib/format";
import { effectivePolicy } from "@/lib/billing";
import {
  dataSpan,
  listModelPricing,
  listProjects,
  listRateCards,
  listWorkstreams,
  settings as allSettings,
} from "@/lib/queries";
import { AI_POLICY_LABEL, GRADE_LABEL, type Grade, type ModelPricingRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The row in force for a model is the newest one whose effective_from is not in
 * the future relative to the data we hold — comparing against "today" would mark
 * nothing in effect once the demo dataset ages.
 */
function inForceIds(rows: readonly ModelPricingRow[], asOf: string): Set<string> {
  const best = new Map<string, ModelPricingRow>();
  for (const r of rows) {
    if (r.effective_from > asOf) continue;
    const current = best.get(r.model);
    if (!current || r.effective_from > current.effective_from) best.set(r.model, r);
  }
  return new Set([...best.values()].map((r) => `${r.model}@${r.effective_from}`));
}

function gradeLabel(grade: string): string {
  return GRADE_LABEL[grade as Grade] ?? grade;
}

/** A stored setting read as a ratio; anything outside 0..1 is not one. */
function ratioSetting(value: string | undefined): number {
  const n = Number(value ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/**
 * The markup the override box offers. A stored zero is what choosing at cost or
 * absorbed leaves behind rather than a deliberate 0% markup, so the most specific
 * markup that actually exists wins: the workstream's own, else its project's, else
 * the firm default. A project that sets its own markup is never overridden.
 */
function markupSeed(
  wsMarkup: number | null,
  projectMarkup: number,
  firmDefault: number,
): number {
  for (const candidate of [wsMarkup, projectMarkup, firmDefault]) {
    if (candidate !== null && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return 0;
}

export default async function SettingsPage() {
  const s = allSettings();
  const span = dataSpan();
  const firmDefaultMarkup = ratioSetting(s.default_ai_markup_pct);

  const pricing = listModelPricing();
  const inForce = inForceIds(pricing, span.end);

  const tiers: string[] = [];
  const pricingByTier = new Map<string, ModelPricingRow[]>();
  for (const row of pricing) {
    const bucket = pricingByTier.get(row.tier);
    if (bucket) {
      bucket.push(row);
    } else {
      tiers.push(row.tier);
      pricingByTier.set(row.tier, [row]);
    }
  }

  const projects = listProjects();
  const workstreamsByProject = new Map(
    projects.map((p) => [p.id, listWorkstreams(p.id)] as const),
  );
  const rateCardsByProject = new Map(
    projects.map((p) => [p.id, listRateCards(p.id)] as const),
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-eyebrow">Configuration</div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">
          Firm defaults, the effective-dated Claude rate card, and the per-workstream
          decision about whether Claude cost is rebilled, passed through at cost, or
          absorbed by the firm.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Firm</div>
            <div className="card-sub">
              These values appear on statements and stamp approvals. Rates here are stored
              and edited as ratios — 0.2 is a 20% markup — while the policy table further
              down is entered in percent.
            </div>
          </div>
        </div>
        <form action={setSettingAction}>
          <div className="card-body">
            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">Firm name</span>
                <input
                  className="input"
                  type="text"
                  name="firm_name"
                  defaultValue={s.firm_name ?? "Meridian Advisory LLP"}
                />
              </label>
              <label className="field">
                <span className="field-label">Approver name</span>
                <input
                  className="input"
                  type="text"
                  name="approver_name"
                  defaultValue={s.approver_name ?? ""}
                />
              </label>
              <label className="field span-2">
                <span className="field-label">Firm address</span>
                <input
                  className="input"
                  type="text"
                  name="firm_address"
                  defaultValue={s.firm_address ?? ""}
                />
              </label>
              <label className="field">
                <span className="field-label">Tax rate (ratio, 0–1)</span>
                <input
                  className="input"
                  type="number"
                  step="0.001"
                  min="0"
                  max="1"
                  name="tax_rate"
                  defaultValue={s.tax_rate ?? "0"}
                />
                <span className="small dim">
                  0.2 charges 20% tax on the statement subtotal. A value outside 0–1 is
                  refused, not rounded into range.
                </span>
              </label>
              <label className="field">
                <span className="field-label">Default AI markup (ratio, 0–1)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  name="default_ai_markup_pct"
                  defaultValue={s.default_ai_markup_pct ?? "0"}
                />
                <span className="small dim">
                  Seeds the markup box below when neither the workstream nor its project
                  has a markup of its own. It never overrides a project default and never
                  changes an invoice on its own.
                </span>
              </label>
              <div className="field span-2">
                <span className="field-label">Unattributed Claude usage</span>
                <span className="small dim">
                  Not configurable, stated here so the rule is visible: untagged sessions
                  are allocated pro rata by the same consultant&rsquo;s logged hours across
                  every engagement they worked in the period, so no client pays twice.
                  Usage with no hours anywhere to hang it on stays with the firm.
                </span>
              </div>
            </div>
          </div>
          <div className="card-foot">
            <button type="submit" className="btn is-primary">
              Save firm settings
            </button>
            <span className="micro">
              {/* The stored tax rate is echoed raw: a legacy out-of-range value is what
                  the statement will actually charge, so hiding it would be worse. */}
              Tax {pct(Number(s.tax_rate ?? "0"), 1)} · new markup overrides start at{" "}
              {pct(firmDefaultMarkup, 0)}
            </span>
          </div>
        </form>
      </div>

      <div className="spacer" />

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Model pricing</div>
            <div className="card-sub">
              Rates are effective-dated: a repricing adds a row rather than editing one,
              so an issued invoice keeps the rates it was costed with. The row marked{" "}
              <em>In effect</em> is the newest one on or before {date(span.end)}, the last
              day of data held.
            </div>
          </div>
        </div>
        <div className="card-body is-flush">
          {pricing.length === 0 ? (
            <p className="empty">No model rates loaded.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption>All rates are US dollars per million tokens.</caption>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Display name</th>
                    <th>Tier</th>
                    <th>Effective from</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th className="num">Cache read</th>
                    <th className="num">Cache write 5m</th>
                    <th className="num">Cache write 1h</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier) => {
                    const rows = pricingByTier.get(tier) ?? [];
                    return (
                      <Fragment key={tier}>
                        <tr className="is-group">
                          <td colSpan={10}>
                            {tier} · {rows.length} rate {rows.length === 1 ? "row" : "rows"}
                          </td>
                        </tr>
                        {rows.map((r) => {
                          const current = inForce.has(`${r.model}@${r.effective_from}`);
                          return (
                            <tr key={`${r.model}-${r.effective_from}`}>
                              <td className="mono nowrap">{r.model}</td>
                              <td>
                                <span className="cell-strong">{r.display_name}</span>
                              </td>
                              <td>{r.tier}</td>
                              <td className="nowrap">
                                {date(r.effective_from)}
                                {current ? (
                                  <span className="cell-sub">
                                    <Badge tone="ok">In effect</Badge>
                                  </span>
                                ) : null}
                              </td>
                              <td className="num">{usdRate(r.input_per_mtok)}</td>
                              <td className="num">{usdRate(r.output_per_mtok)}</td>
                              <td className="num">{usdRate(r.cache_read_per_mtok)}</td>
                              <td className="num">{usdRate(r.cache_write_5m_per_mtok)}</td>
                              <td className="num">{usdRate(r.cache_write_1h_per_mtok)}</td>
                              <td className="small dim">{r.note || "—"}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="spacer" />

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">AI rebilling policy by workstream</div>
            <div className="card-sub">
              A blank override means the workstream inherits its project default. Choose
              Inherit to clear an override; markup applies only to the markup policy.
            </div>
          </div>
        </div>
        <div className="card-body is-flush">
          {projects.length === 0 ? (
            <p className="empty">No projects to configure.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption>
                  Markup is entered as a percentage: 20 means 20%, 1 means 1%. Anything
                  outside 0–100 is refused, so the save leaves the workstream untouched.
                  A workstream with no markup of its own starts from the firm default
                  above.
                </caption>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Workstream</th>
                    <th>In effect</th>
                    <th>Override</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => {
                    const rows = workstreamsByProject.get(project.id) ?? [];
                    return (
                      <Fragment key={project.id}>
                        <tr className="is-group">
                          <td colSpan={4}>
                            {project.code} · {project.name} · project default{" "}
                            {AI_POLICY_LABEL[project.ai_policy_default]}
                            {project.ai_policy_default === "markup"
                              ? ` at ${pct(project.ai_markup_pct_default, 0)}`
                              : ""}
                          </td>
                        </tr>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="dim">
                              No workstreams on this project.
                            </td>
                          </tr>
                        ) : (
                          rows.map((ws) => {
                            const eff = effectivePolicy(ws, project);
                            return (
                              <tr key={ws.id}>
                                <td className="mono nowrap">{project.code}</td>
                                <td>
                                  <span className="cell-strong">{ws.name}</span>
                                  <span className="cell-sub">{ws.code}</span>
                                </td>
                                <td>
                                  <PolicyBadge
                                    policy={eff.policy}
                                    markupPct={eff.markupPct}
                                  />
                                  <span className="cell-sub">
                                    {ws.ai_policy === null
                                      ? "Inherited from project"
                                      : "Overridden on workstream"}
                                  </span>
                                </td>
                                <td>
                                  <form action={setPolicyAction} className="row-tight">
                                    <input
                                      type="hidden"
                                      name="workstreamId"
                                      value={ws.id}
                                    />
                                    <select
                                      className="input"
                                      name="policy"
                                      defaultValue={ws.ai_policy ?? "inherit"}
                                      aria-label={`AI policy for ${ws.code}`}
                                    >
                                      <option value="inherit">Inherit</option>
                                      <option value="markup">
                                        Rebilled with markup
                                      </option>
                                      <option value="at_cost">Rebilled at cost</option>
                                      <option value="absorbed">Absorbed</option>
                                    </select>
                                    <input
                                      className="input"
                                      type="number"
                                      name="markupPct"
                                      step="1"
                                      min="0"
                                      max="100"
                                      defaultValue={Math.round(
                                        markupSeed(
                                          ws.ai_markup_pct,
                                          project.ai_markup_pct_default,
                                          firmDefaultMarkup,
                                        ) * 100,
                                      )}
                                      aria-label={`Markup percent for ${ws.code}`}
                                    />
                                    <button type="submit" className="btn">
                                      Save
                                    </button>
                                  </form>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="spacer" />

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Rate cards</div>
            <div className="card-sub">
              Read-only. Bill and cost rates are effective-dated per project and grade;
              the engine resolves the row in force on each time entry&rsquo;s work date.
            </div>
          </div>
        </div>
        <div className="card-body is-flush">
          {projects.length === 0 ? (
            <p className="empty">No projects to show rates for.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Grade</th>
                    <th className="num">Bill rate</th>
                    <th className="num">Cost rate</th>
                    <th>Effective from</th>
                    <th className="num">Margin per hour</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => {
                    const cards = rateCardsByProject.get(project.id) ?? [];
                    return (
                      <Fragment key={project.id}>
                        <tr className="is-group">
                          <td colSpan={5}>
                            {project.code} · {project.name}
                          </td>
                        </tr>
                        {cards.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="dim">
                              No rate card — the engine falls back to each
                              consultant&rsquo;s default rates.
                            </td>
                          </tr>
                        ) : (
                          cards.map((c) => (
                            <tr key={c.id}>
                              <td>{gradeLabel(c.grade)}</td>
                              <td className="num">{usd(c.bill_rate)}</td>
                              <td className="num">{usd(c.cost_rate)}</td>
                              <td className="nowrap">{date(c.effective_from)}</td>
                              <td className="num">{usd(c.bill_rate - c.cost_rate)}</td>
                            </tr>
                          ))
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
