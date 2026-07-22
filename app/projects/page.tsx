import Link from "next/link";

import { PolicyBadge, RiskBadge, StatusBadge } from "@/components/Badge";
import { PeriodPicker } from "@/components/PeriodPicker";
import { computeProjectBilling, round2, sum } from "@/lib/billing";
import { pct, usd } from "@/lib/format";
import {
  allProjectBillingInputs,
  availableMonths,
  listClients,
  resolvePeriod,
} from "@/lib/queries";
import type { EngagementType } from "@/lib/types";

export const metadata = { title: "Projects — Meridian Advisory" };

const ENGAGEMENT_LABEL: Record<EngagementType, string> = {
  time_and_materials: "Time & materials",
  capped_tm: "Capped T&M",
  fixed_fee: "Fixed fee",
};

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { month, period } = resolvePeriod(first(sp.month));
  const months = availableMonths();

  const clients = listClients();
  const requestedClient = first(sp.client);
  // An unknown client id would silently render an empty table, so it is dropped.
  const clientId = clients.some((c) => c.id === requestedClient)
    ? requestedClient
    : undefined;

  const all = allProjectBillingInputs(period).map(computeProjectBilling);
  const rows = all
    .filter((b) => (clientId ? b.client.id === clientId : true))
    .sort((a, b) => b.totalBillable - a.totalBillable);

  const totalContract = round2(sum(rows.map((r) => r.project.contract_value)));
  const totalBillable = round2(sum(rows.map((r) => r.totalBillable)));
  const totalCost = round2(sum(rows.map((r) => r.totalCost)));
  const totalMarginPct = totalBillable === 0 ? null : (totalBillable - totalCost) / totalBillable;

  const chipHref = (id?: string) =>
    id ? `/projects?month=${month}&client=${id}` : `/projects?month=${month}`;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Engagements</div>
            <h1 className="page-title">Projects</h1>
            <p className="page-sub">
              Billable value, Claude cost and budget risk for every engagement in the
              selected month. Margin is billable less cost to serve, including Claude
              spend the firm absorbs.
            </p>
          </div>
          <PeriodPicker months={months} current={month} />
        </div>
      </div>

      <div className="toolbar">
        <Link className={`chip${clientId ? "" : " is-active"}`} href={chipHref()}>
          All clients
        </Link>
        {clients.map((c) => (
          <Link
            key={c.id}
            className={`chip${clientId === c.id ? " is-active" : ""}`}
            href={chipHref(c.id)}
          >
            {c.name}
          </Link>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">
              {rows.length} {rows.length === 1 ? "engagement" : "engagements"}
            </div>
            <div className="card-sub">Ranked by billable value in the period.</div>
          </div>
        </div>
        <div className="card-body is-flush">
          {rows.length === 0 ? (
            <div className="empty">No engagements match this filter.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Project</th>
                    <th>Client</th>
                    <th>Status</th>
                    <th>Engagement</th>
                    <th>AI policy</th>
                    <th className="num">Contract value</th>
                    <th className="num">Period billable</th>
                    <th className="num">Margin</th>
                    <th>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.project.id}>
                      <td className="mono nowrap">{b.project.code}</td>
                      <td>
                        <Link
                          className="cell-strong"
                          href={`/projects/${b.project.id}?month=${month}`}
                        >
                          {b.project.name}
                        </Link>
                        <span className="cell-sub">
                          {b.project.engagement_partner} · {b.project.delivery_lead}
                        </span>
                      </td>
                      <td>{b.client.name}</td>
                      <td>
                        <StatusBadge status={b.project.status} />
                      </td>
                      <td className="nowrap">
                        {ENGAGEMENT_LABEL[b.project.engagement_type]}
                      </td>
                      <td>
                        <PolicyBadge
                          policy={b.project.ai_policy_default}
                          markupPct={b.project.ai_markup_pct_default}
                        />
                      </td>
                      <td className="num">{usd(b.project.contract_value)}</td>
                      <td className="num">{usd(b.totalBillable)}</td>
                      <td
                        className={`num ${
                          b.marginPct != null && b.marginPct < 0.2 ? "bad" : ""
                        }`}
                      >
                        {pct(b.marginPct, 1)}
                      </td>
                      <td>
                        <RiskBadge risk={b.risk} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6}>Total</td>
                    <td className="num">{usd(totalContract)}</td>
                    <td className="num">{usd(totalBillable)}</td>
                    <td className="num">{pct(totalMarginPct, 1)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
