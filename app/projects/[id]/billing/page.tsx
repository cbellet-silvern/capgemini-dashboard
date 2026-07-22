import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";

import { setInvoiceStatusAction } from "@/app/actions";
import { PolicyBadge, StatusBadge } from "@/components/Badge";
import { PeriodPicker } from "@/components/PeriodPicker";
import { PrintButton } from "@/components/PrintButton";
import { StatTile } from "@/components/StatTile";
import { buildStatement, round2, sum } from "@/lib/billing";
import {
  date,
  dateRange,
  monthLabel,
  pct,
  usd,
  usdCents,
  usdRate,
} from "@/lib/format";
import {
  availableMonths,
  getInvoiceForPeriod,
  getSetting,
  projectBillingInput,
  resolvePeriod,
} from "@/lib/queries";
import type {
  AiPolicy,
  EngagementType,
  InvoiceStatus,
  Statement,
  StatementGroup,
  StatementLine,
} from "@/lib/types";

const ENGAGEMENT_LABEL: Record<EngagementType, string> = {
  time_and_materials: "Time & materials",
  capped_tm: "Capped time & materials",
  fixed_fee: "Fixed fee",
};

// Only reached when the settings row is missing; kept identical to the seeded one.
const DEFAULT_FIRM_ADDRESS = "18 Finsbury Circus\nLondon EC2M 7EB\nUnited Kingdom";

/**
 * The one step a filed invoice can take from where it is. 'paid' is terminal and
 * deliberately absent, so a paid invoice offers no button — its status is already
 * on the statement head.
 */
const NEXT_STATUS: Partial<
  Record<InvoiceStatus, { status: InvoiceStatus; label: string; className: string }>
> = {
  draft: { status: "issued", label: "Issue invoice", className: "btn is-primary" },
  issued: { status: "paid", label: "Mark paid", className: "btn" },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + days * 86_400_000);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** Quantity, with its unit spelled out — the client should see what was counted. */
function qtyText(line: StatementLine): string {
  switch (line.unit) {
    // Two decimals, matching the round2 the engine applies to `qty`. A
    // quarter-hour entry makes the hundredths load-bearing: printing 7.3 for
    // 7.25 stops the line multiplying out.
    case "hrs":
      return `${line.qty.toFixed(2)} hrs`;
    // Three decimals, matching the precision the engine put in `qty`. Printing
    // fewer would show the client a quantity that does not reproduce the amount.
    case "M tokens":
      return `${line.qty.toFixed(3)} M tok`;
    case "% of pool":
      return `${line.qty.toFixed(1)}% of pool`;
    case "milestone":
      return "1 milestone";
    default:
      return String(line.qty);
  }
}

/** Unit price carries its denominator, so hours x rate is checkable by eye. */
function priceText(line: StatementLine): string {
  switch (line.unit) {
    case "hrs":
      return `${usdCents(line.unitPrice)} / hr`;
    case "M tokens":
      return `${usdRate(line.unitPrice)} / M tok`;
    default:
      return usdCents(line.unitPrice);
  }
}

function lineMarginPct(line: StatementLine): number | null {
  if (line.internal?.marginPct != null) return line.internal.marginPct;
  const cost = line.internal?.cost;
  if (cost == null || line.amount === 0) return null;
  return (line.amount - cost) / line.amount;
}

function isAbsorbedLine(line: StatementLine): boolean {
  return (
    line.kind === "ai_passthrough" &&
    line.amount === 0 &&
    (line.internal?.cost ?? 0) > 0
  );
}

function hasClaudeUsage(group: StatementGroup): boolean {
  return group.lines.some(
    (l) =>
      l.kind === "ai_passthrough" && ((l.internal?.cost ?? 0) > 0 || l.amount > 0),
  );
}

/** One sentence, derived from the policies actually present on the statement. */
function claudeBillingSentence(groups: readonly StatementGroup[]): string {
  const withUsage = groups.filter(hasClaudeUsage);
  if (withUsage.length === 0) {
    return "No Claude platform usage was recorded against this engagement in this period.";
  }

  const policies = new Set<AiPolicy>(withUsage.map((g) => g.policy));
  const markupPcts = [
    ...new Set(withUsage.filter((g) => g.policy === "markup").map((g) => g.markupPct)),
  ];
  const singleMarkup = markupPcts.length === 1 ? markupPcts[0] : undefined;
  const feeText =
    singleMarkup !== undefined
      ? `a ${Math.round(singleMarkup * 100)}% AI platform management fee`
      : "the AI platform management fee shown on each workstream";

  if (policies.size === 1) {
    if (policies.has("markup")) {
      return `Claude platform usage is metered per model at Anthropic's published rates and rebilled at cost plus ${feeText}; the tokens and rates behind every line are itemised above.`;
    }
    if (policies.has("at_cost")) {
      return "Claude platform usage is metered per model at Anthropic's published rates and rebilled at cost, with no margin added; the tokens and rates behind every line are itemised above.";
    }
    return "Claude platform usage on this engagement is absorbed by Meridian Advisory and is not rebilled to you.";
  }

  const codesFor = (policy: AiPolicy) =>
    withUsage
      .filter((g) => g.policy === policy)
      .map((g) => g.workstreamCode)
      .join(", ");

  const parts: string[] = [];
  if (policies.has("markup")) parts.push(`rebilled at cost plus ${feeText} on ${codesFor("markup")}`);
  if (policies.has("at_cost")) parts.push(`rebilled at cost on ${codesFor("at_cost")}`);
  if (policies.has("absorbed")) {
    parts.push(`absorbed by Meridian Advisory at no charge to you on ${codesFor("absorbed")}`);
  }
  return `Claude platform usage is metered per model and treated by workstream: ${parts.join("; ")}.`;
}

export default async function BillingStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const { month, period } = resolvePeriod(first(sp.month));
  const internal = first(sp.view) === "internal";

  const input = projectBillingInput(id, period);
  if (!input) notFound();

  const { project, client } = input;

  const invoice = getInvoiceForPeriod(id, period);
  const terms = client.payment_terms_days;
  const invoiceNumber =
    invoice?.number ?? `DRAFT-${project.code}-${month.replace("-", "")}`;
  const status: Statement["status"] = invoice?.status ?? "draft";
  const issuedDate = invoice?.issued_date ?? period.end;
  const dueDate = invoice?.due_date ?? addDays(issuedDate, terms);
  // A draft carries no filed dates, so the ones shown are the ones it *would*
  // carry if issued today — say so rather than passing them off as filed.
  const datesProjected = invoice?.issued_date == null;
  // Only a filed invoice row can be advanced; without one there is nothing to
  // post an id for, so the toolbar says so instead of offering a button.
  const advance = invoice ? NEXT_STATUS[invoice.status] : undefined;

  const parsedTax = Number.parseFloat(getSetting("tax_rate", "0"));
  const taxRate = Number.isFinite(parsedTax) && parsedTax > 0 ? parsedTax : 0;

  const statement = buildStatement(input, {
    invoiceNumber,
    issuedDate,
    dueDate,
    status,
    taxRate,
  });

  const groups = statement.groups.filter((g) => g.lines.length > 0);
  const cols = internal ? 6 : 4;

  const addressLines = (raw: string) =>
    raw
      .split(/\r?\n|\s*\|\s*/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const configuredAddress = addressLines(getSetting("firm_address", ""));
  const firmAddress =
    configuredAddress.length > 0 ? configuredAddress : addressLines(DEFAULT_FIRM_ADDRESS);
  const firmEmail = getSetting("firm_billing_email", "");
  // Settings owns the issuer name, so editing it there actually reaches the document.
  const firmName = getSetting("firm_name", "Meridian Advisory LLP");

  const viewHref = (view: "client" | "internal") =>
    `/projects/${project.id}/billing?view=${view}&month=${month}`;

  // Internal audit figures, all derived from the same Statement the client view
  // renders — the internal view adds columns, it never recomputes the bill.
  const allLines = statement.groups.flatMap((g) => g.lines);
  const claudeCost = round2(
    sum(
      allLines
        .filter((l) => l.kind === "ai_passthrough")
        .map((l) => l.internal?.cost ?? 0),
    ),
  );
  const laborCost = round2(statement.totalCost - claudeCost);
  const claudeShare =
    statement.totalCost > 0 ? claudeCost / statement.totalCost : null;

  const renderedLineSum = round2(sum(allLines.map((l) => l.amount)));
  const recomputedTotal = round2(renderedLineSum + statement.taxAmount);
  const totalsAgree = Math.abs(recomputedTotal - statement.total) < 0.005;

  const poolParts = round2(
    statement.unattributedAllocatedCost +
      statement.unattributedElsewhereCost +
      statement.unattributedResidualCost,
  );
  // Comes from the engine, which checks the identity BEFORE rounding. Comparing
  // the four displayed figures here instead would need an arbitrary tolerance:
  // each is rounded to cents independently, so a sound statement can show a
  // one-cent drift — which is precisely what made this red callout fire on 11 of
  // 32 real statements when the check lived in the page.
  const poolAgrees = statement.unattributedBalances;
  const poolRoundingDrift = round2(poolParts - statement.unattributedPoolCost);

  const snapshotDiff = invoice ? round2(invoice.total - statement.total) : 0;
  const snapshotDrifted =
    invoice != null && invoice.status !== "draft" && Math.abs(snapshotDiff) >= 0.01;

  const totalRows: Array<{ label: string; value: number }> = [
    { label: "Professional services", value: statement.subtotalLabor },
    { label: "Claude platform usage", value: statement.subtotalAi },
    { label: "AI platform management fee", value: statement.subtotalAiMarkup },
    { label: "Fixed-fee milestones", value: statement.subtotalFixedFee },
  ].filter((r) => r.value !== 0);

  return (
    <div className="page">
      <div className="page-head no-print">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">{client.name}</div>
            <h1 className="page-title">
              Billing statement — {monthLabel(month)}
            </h1>
            <p className="page-sub">
              {project.code} {project.name}. Consultant hours and rebilled Claude
              platform usage, itemised per workstream.{" "}
              <Link href={`/projects/${project.id}`}>Back to project</Link>
            </p>
          </div>
        </div>
      </div>

      <div className="toolbar no-print">
        <div className="seg">
          <Link href={viewHref("client")} className={internal ? "" : "is-active"}>
            Client view
          </Link>
          <Link href={viewHref("internal")} className={internal ? "is-active" : ""}>
            Internal view
          </Link>
        </div>
        <PeriodPicker months={availableMonths()} current={month} />
        <span className="spacer" />
        <PrintButton />
        <a
          className="btn"
          href={`/api/export/statement?project=${project.id}&month=${month}`}
        >
          Export CSV
        </a>
        {invoice == null ? (
          <span className="small muted">
            Unsaved draft — no invoice filed for this period.
          </span>
        ) : advance ? (
          <form action={setInvoiceStatusAction}>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <input type="hidden" name="status" value={advance.status} />
            <button type="submit" className={advance.className}>
              {advance.label}
            </button>
          </form>
        ) : null}
      </div>

      <div className="statement">
        <div className="statement-head">
          <div className="stack">
            <div>
              <div className="statement-issuer">{firmName}</div>
              {firmAddress.map((line) => (
                <div key={line} className="small muted">
                  {line}
                </div>
              ))}
              {firmEmail ? <div className="small muted">{firmEmail}</div> : null}
            </div>
            <div>
              <div className="micro">Billed to</div>
              <div className="cell-strong">{client.name}</div>
              <div className="small dim">{client.billing_contact_name}</div>
              <div className="small muted">{client.billing_contact_email}</div>
            </div>
          </div>

          <dl className="statement-meta">
            <dt>Invoice number</dt>
            <dd className="mono">{statement.invoiceNumber}</dd>

            <dt>Status</dt>
            <dd>
              <StatusBadge status={statement.status} />
            </dd>

            <dt>Period</dt>
            <dd>{dateRange(statement.period.start, statement.period.end)}</dd>

            <dt>Issue date</dt>
            <dd>
              {statement.issuedDate ? date(statement.issuedDate) : "—"}
              {datesProjected ? <span className="muted"> (projected)</span> : null}
            </dd>

            <dt>Due date</dt>
            <dd>
              {statement.dueDate ? date(statement.dueDate) : "—"}
              {datesProjected ? <span className="muted"> (projected)</span> : null}
            </dd>

            <dt>Project code</dt>
            <dd className="mono">{project.code}</dd>

            <dt>PO number</dt>
            <dd className="mono">{project.po_number || "—"}</dd>

            <dt>Engagement type</dt>
            <dd>{ENGAGEMENT_LABEL[project.engagement_type]}</dd>
          </dl>
        </div>

        <div className="statement-body">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Quantity</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                  {internal ? <th className="num">Cost</th> : null}
                  {internal ? <th className="num">Margin</th> : null}
                </tr>
              </thead>
              <tbody>
                {groups.length === 0 ? (
                  <tr>
                    <td colSpan={cols}>
                      <div className="empty">
                        No billable activity was recorded on this engagement in{" "}
                        {monthLabel(month)}.
                      </div>
                    </td>
                  </tr>
                ) : null}

                {groups.map((group) => {
                  const lines = internal
                    ? group.lines
                    : group.lines.filter((l) => l.amount !== 0);
                  const absorbedHere = group.lines.some(isAbsorbedLine);

                  return (
                    <Fragment key={group.workstreamId}>
                      <tr className="is-group">
                        <td colSpan={cols}>
                          <span className="row-tight">
                            <span className="mono">{group.workstreamCode}</span>
                            <span>{group.workstreamName}</span>
                            <PolicyBadge
                              policy={group.policy}
                              markupPct={group.markupPct}
                            />
                          </span>
                        </td>
                      </tr>

                      {lines.map((line, i) => {
                        const marginPct = lineMarginPct(line);
                        const absorbed = isAbsorbedLine(line);
                        const negative =
                          absorbed || (marginPct != null && marginPct < 0);
                        return (
                          <tr key={`${group.workstreamId}-${line.kind}-${i}`}>
                            <td className="is-indent">
                              {line.description}
                              {internal && line.internal?.note ? (
                                <span className="cell-sub">{line.internal.note}</span>
                              ) : null}
                            </td>
                            <td className="num">{qtyText(line)}</td>
                            <td className="num">{priceText(line)}</td>
                            <td className="num">{usdCents(line.amount)}</td>
                            {internal ? (
                              <td className="num">
                                {line.internal?.cost != null
                                  ? usdCents(line.internal.cost)
                                  : "—"}
                              </td>
                            ) : null}
                            {internal ? (
                              <td className={negative ? "num bad" : "num"}>
                                {absorbed
                                  ? usdCents(line.internal?.margin ?? 0)
                                  : pct(marginPct)}
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}

                      {!internal && absorbedHere ? (
                        <tr>
                          <td className="is-indent muted small" colSpan={cols}>
                            Claude platform usage on this workstream is included at no
                            charge. Meridian Advisory absorbs the platform cost.
                          </td>
                        </tr>
                      ) : null}

                      <tr className="is-subtotal">
                        <td colSpan={3}>Subtotal — {group.workstreamCode}</td>
                        <td className="num">{usdCents(group.subtotal)}</td>
                        {internal ? (
                          <td className="num">{usdCents(group.cost)}</td>
                        ) : null}
                        {internal ? (
                          <td
                            className={
                              group.marginPct != null && group.marginPct < 0
                                ? "num bad"
                                : "num"
                            }
                          >
                            {pct(group.marginPct)}
                          </td>
                        ) : null}
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="statement-total">
          <div className="statement-total-inner">
            {totalRows.map((r) => (
              <div className="total-row" key={r.label}>
                <span>{r.label}</span>
                <span className="total-num">{usdCents(r.value)}</span>
              </div>
            ))}
            <div className="total-row">
              <span>Subtotal</span>
              <span className="total-num">{usdCents(statement.subtotal)}</span>
            </div>
            {statement.taxRate > 0 ? (
              <div className="total-row">
                <span>Tax ({pct(statement.taxRate, 1)})</span>
                <span className="total-num">{usdCents(statement.taxAmount)}</span>
              </div>
            ) : null}
            <div className="total-row is-grand">
              <span>Total due</span>
              <span className="total-num">{usdCents(statement.total)}</span>
            </div>
          </div>
        </div>

        <div className="statement-note">
          <p>
            Payment due within {terms} days of the invoice date
            {statement.dueDate ? ` — on or before ${date(statement.dueDate)}` : ""}.
            Remit in {client.currency} quoting invoice {statement.invoiceNumber}
            {project.po_number ? ` and purchase order ${project.po_number}` : ""}.
          </p>
          <p>{claudeBillingSentence(statement.groups)}</p>
        </div>
      </div>

      {internal ? (
        // The audit block is screen-only: printing this page must always yield
        // the document a client would receive, never the internal margin view.
        <div className="stack no-print">
          <hr className="hairline" />
          {snapshotDrifted && invoice ? (
            <div className="callout is-warn">
              <strong>Issued snapshot differs from a recompute.</strong> Invoice{" "}
              {invoice.number} was filed at {usdCents(invoice.total)}; recomputing
              from current time, usage and rate data gives{" "}
              {usdCents(statement.total)} — the filed figure is{" "}
              {snapshotDiff > 0 ? "higher" : "lower"} by{" "}
              {usdCents(Math.abs(snapshotDiff))}. The filed document remains the
              client&apos;s version of record; reconcile the difference before
              re-issuing or crediting.
            </div>
          ) : null}

          <div className="grid grid-4">
            <StatTile
              label="Total billed"
              value={usd(statement.total)}
              foot={`Invoice ${statement.invoiceNumber}`}
            />
            <StatTile
              label="Cost to serve"
              value={usd(statement.totalCost)}
              foot={`Labor ${usd(laborCost)} · Claude ${usdCents(claudeCost)}`}
            />
            <StatTile
              label="Gross margin"
              value={usd(statement.margin)}
              foot={`${pct(statement.marginPct, 1)} of billed`}
            />
            <StatTile
              label="Claude share of cost"
              value={pct(claudeShare, 1)}
              foot={`${usdCents(claudeCost)} of ${usd(statement.totalCost)} cost to serve`}
            />
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Reconciliation</div>
                <div className="card-sub">
                  How the untagged Claude pool was split, and whether the rendered
                  lines add up to the total on the document.
                </div>
              </div>
            </div>
            <div className="card-body is-flush">
              <table className="data">
                <tbody>
                  <tr className="is-group">
                    <td colSpan={2}>Untagged Claude usage pool</td>
                  </tr>
                  <tr>
                    <td>
                      Pool cost for consultants on this engagement
                      <span className="cell-sub">
                        Sessions that carried no workstream tag, {dateRange(
                          statement.period.start,
                          statement.period.end,
                        )}
                      </span>
                    </td>
                    <td className="num">
                      {usdCents(statement.unattributedPoolCost)}
                    </td>
                  </tr>
                  <tr>
                    <td className="is-indent">Allocated to this project</td>
                    <td className="num">
                      {usdCents(statement.unattributedAllocatedCost)}
                    </td>
                  </tr>
                  <tr>
                    <td className="is-indent">
                      Allocated to the same consultants&apos; other engagements
                    </td>
                    <td className="num">
                      {usdCents(statement.unattributedElsewhereCost)}
                    </td>
                  </tr>
                  <tr>
                    <td className="is-indent">
                      Unallocable residual
                      <span className="cell-sub">
                        Usage by consultants with no logged hours in the period — never
                        pushed onto a client
                      </span>
                    </td>
                    <td className="num">
                      {usdCents(statement.unattributedResidualCost)}
                    </td>
                  </tr>
                  <tr className="is-subtotal">
                    <td>
                      Allocated + elsewhere + residual
                      {poolAgrees && poolRoundingDrift !== 0 ? (
                        <span className="cell-sub">
                          Reads {usdCents(Math.abs(poolRoundingDrift))} from the pool
                          above because each figure is rounded to cents on its own. The
                          underlying allocation balances exactly.
                        </span>
                      ) : null}
                    </td>
                    <td className={poolAgrees ? "num" : "num bad"}>
                      {usdCents(poolParts)}
                    </td>
                  </tr>

                  <tr className="is-group">
                    <td colSpan={2}>Absorbed Claude cost</td>
                  </tr>
                  <tr>
                    <td>
                      Metered Claude cost not rebilled
                      <span className="cell-sub">
                        Workstreams on an absorbed AI policy — margin cost, client
                        goodwill
                      </span>
                    </td>
                    <td className="num">{usdCents(statement.absorbedAiCost)}</td>
                  </tr>

                  <tr className="is-group">
                    <td colSpan={2}>Line-to-total check</td>
                  </tr>
                  <tr>
                    <td>Sum of rendered line amounts ({allLines.length} lines)</td>
                    <td className="num">{usdCents(renderedLineSum)}</td>
                  </tr>
                  <tr>
                    <td className="is-indent">Tax at {pct(statement.taxRate, 1)}</td>
                    <td className="num">{usdCents(statement.taxAmount)}</td>
                  </tr>
                  <tr className="is-subtotal">
                    <td>Lines plus tax</td>
                    <td className="num">{usdCents(recomputedTotal)}</td>
                  </tr>
                  <tr className="is-subtotal">
                    <td>Total stated on the statement</td>
                    <td className={totalsAgree ? "num" : "num bad"}>
                      {usdCents(statement.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="card-foot">
              {totalsAgree ? (
                <span className="good">
                  Rendered lines reconcile to the stated total to the cent.
                </span>
              ) : (
                <span className="bad">
                  Rendered lines do not reconcile to the stated total.
                </span>
              )}
              {poolAgrees ? (
                <span className="muted">
                  Untagged pool fully accounted for across allocation, other
                  engagements and residual.
                </span>
              ) : (
                <span className="bad">Untagged pool does not add up.</span>
              )}
            </div>
          </div>

          {!totalsAgree ? (
            <div className="callout is-bad">
              <strong>The lines do not add up to the total.</strong> Rendered lines
              plus tax come to {usdCents(recomputedTotal)}, but the statement states{" "}
              {usdCents(statement.total)} — a discrepancy of{" "}
              {usdCents(Math.abs(round2(recomputedTotal - statement.total)))}. Do not
              issue this invoice until it is resolved.
            </div>
          ) : null}

          {!poolAgrees ? (
            <div className="callout is-bad">
              <strong>Untagged pool allocation is unbalanced.</strong> Allocation,
              other engagements and residual come to {usdCents(poolParts)} against a
              pool of {usdCents(statement.unattributedPoolCost)}. The allocation input
              is inconsistent — investigate before rebilling any Claude cost.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
