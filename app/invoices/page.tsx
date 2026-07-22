import Link from "next/link";
import { Fragment } from "react";

import { StatusBadge } from "@/components/Badge";
import { round2, sum } from "@/lib/billing";
import { count, date, dateRange, monthLabel, usdCents } from "@/lib/format";
import { listInvoices } from "@/lib/queries";
import type { InvoiceStatus } from "@/lib/types";

type InvoiceRegisterRow = ReturnType<typeof listInvoices>[number];

const STATUSES: readonly InvoiceStatus[] = ["draft", "issued", "paid"];
const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  paid: "Paid",
};

/** Thirteen columns; every colSpan below has to add up to this. */
const COLS = 13;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function isStatus(v: string | undefined): v is InvoiceStatus {
  return v === "draft" || v === "issued" || v === "paid";
}

interface MonthGroup {
  month: string;
  rows: InvoiceRegisterRow[];
}

/** Rows arrive sorted by period_start DESC, so a single pass groups them. */
function groupByMonth(rows: readonly InvoiceRegisterRow[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const row of rows) {
    const month = row.period_start.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.rows.push(row);
    else groups.push({ month, rows: [row] });
  }
  return groups;
}

function totals(rows: readonly InvoiceRegisterRow[]) {
  return {
    labor: round2(sum(rows.map((r) => r.subtotal_labor))),
    ai: round2(sum(rows.map((r) => r.subtotal_ai_cost))),
    markup: round2(sum(rows.map((r) => r.ai_markup_amount))),
    fixedFee: round2(sum(rows.map((r) => r.subtotal_fixed_fee))),
    total: round2(sum(rows.map((r) => r.total))),
  };
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const requested = first(sp.status);
  const active = isStatus(requested) ? requested : null;

  const all = listInvoices();
  const rows = active ? all.filter((r) => r.status === active) : all;
  const groups = groupByMonth(rows);
  const grand = totals(rows);

  const countFor = (status: InvoiceStatus) =>
    all.filter((r) => r.status === status).length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Billing</div>
            <h1 className="page-title">Invoice register</h1>
            <p className="page-sub">
              Every invoice raised across the portfolio, with the labor and Claude
              platform components it was built from. Open a statement to see the
              itemised workstream detail behind a line.
            </p>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <Link href="/invoices" className={active ? "chip" : "chip is-active"}>
          All <span className="muted">{count(all.length)}</span>
        </Link>
        {STATUSES.map((status) => (
          <Link
            key={status}
            href={`/invoices?status=${status}`}
            className={active === status ? "chip is-active" : "chip"}
          >
            {STATUS_LABEL[status]}{" "}
            <span className="muted">{count(countFor(status))}</span>
          </Link>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">
              {active ? `${STATUS_LABEL[active]} invoices` : "All invoices"}
            </div>
            <div className="card-sub">
              {count(rows.length)}{" "}
              {rows.length === 1 ? "invoice" : "invoices"} · {usdCents(grand.total)}{" "}
              billed
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="card-body">
            <div className="empty">
              No {active ? STATUS_LABEL[active].toLowerCase() : ""} invoices to show.
            </div>
          </div>
        ) : (
          <div className="card-body is-flush">
            <div className="table-wrap">
              <table className="data">
                {/* Rounding each component to the dollar made the four columns
                    miss the to-the-cent total by up to $1.23 on real invoices —
                    a register whose columns do not sum reads as an error. Every
                    money column now carries cents. */}
                <caption>
                  Component columns carry cents and add up to the total. Tax where a
                  jurisdiction applies it, and any agreed discount, sit inside the
                  total and in no column.
                </caption>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Project</th>
                    <th>Client</th>
                    <th>Period</th>
                    <th>Status</th>
                    <th className="num">Labor</th>
                    <th className="num">Claude</th>
                    <th className="num">Markup</th>
                    <th className="num">Fixed fee</th>
                    <th className="num">Total</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th>Statement</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => {
                    const sub = totals(group.rows);
                    return (
                      <Fragment key={group.month}>
                        <tr className="is-group">
                          <td colSpan={COLS}>
                            {monthLabel(group.month)} · {count(group.rows.length)}{" "}
                            {group.rows.length === 1 ? "invoice" : "invoices"}
                          </td>
                        </tr>

                        {group.rows.map((inv) => {
                          const month = inv.period_start.slice(0, 7);
                          return (
                            <tr key={inv.id}>
                              <td className="mono nowrap">{inv.number}</td>
                              <td>
                                <Link
                                  href={`/projects/${inv.project_id}`}
                                  className="cell-strong"
                                >
                                  {inv.project_code}
                                </Link>
                                <span className="cell-sub">{inv.project_name}</span>
                              </td>
                              <td>{inv.client_name}</td>
                              <td className="nowrap">
                                {dateRange(inv.period_start, inv.period_end)}
                              </td>
                              <td>
                                <StatusBadge status={inv.status} />
                              </td>
                              <td className="num">{usdCents(inv.subtotal_labor)}</td>
                              <td className="num">{usdCents(inv.subtotal_ai_cost)}</td>
                              <td className="num">{usdCents(inv.ai_markup_amount)}</td>
                              <td className="num">{usdCents(inv.subtotal_fixed_fee)}</td>
                              <td className="num cell-strong">{usdCents(inv.total)}</td>
                              <td className="nowrap">
                                {inv.issued_date ? date(inv.issued_date) : "—"}
                              </td>
                              <td className="nowrap">
                                {inv.due_date ? date(inv.due_date) : "—"}
                              </td>
                              <td className="nowrap">
                                <Link
                                  href={`/projects/${inv.project_id}/billing?month=${month}`}
                                >
                                  Open
                                </Link>
                              </td>
                            </tr>
                          );
                        })}

                        <tr className="is-subtotal">
                          <td colSpan={5}>{monthLabel(group.month)} subtotal</td>
                          <td className="num">{usdCents(sub.labor)}</td>
                          <td className="num">{usdCents(sub.ai)}</td>
                          <td className="num">{usdCents(sub.markup)}</td>
                          <td className="num">{usdCents(sub.fixedFee)}</td>
                          <td className="num">{usdCents(sub.total)}</td>
                          <td colSpan={3} />
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>
                      {active ? `${STATUS_LABEL[active]} total` : "Portfolio total"}
                    </td>
                    <td className="num">{usdCents(grand.labor)}</td>
                    <td className="num">{usdCents(grand.ai)}</td>
                    <td className="num">{usdCents(grand.markup)}</td>
                    <td className="num">{usdCents(grand.fixedFee)}</td>
                    <td className="num">{usdCents(grand.total)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
