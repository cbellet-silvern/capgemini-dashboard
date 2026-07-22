/**
 * CSV export. Four fixed shapes, chosen by an allow-listed path segment — the
 * segment never reaches a query or a filename unvalidated.
 *
 * The output is spreadsheet input, not a report: numbers carry full precision,
 * money is rounded to cents, and nothing wears a currency symbol or a thousands
 * separator.
 */

import { buildStatement, computeProjectBilling, round2 } from "@/lib/billing";
import { fileSlug } from "@/lib/format";
import {
  allProjectBillingInputs,
  getInvoiceForPeriod,
  getProject,
  getSetting,
  listConsultants,
  listProjects,
  listTimeEntries,
  listUsage,
  listUsageByModel,
  listUsageForProject,
  listWorkstreams,
  projectBillingInput,
  resolvePeriod,
} from "@/lib/queries";
import {
  AI_POLICY_LABEL,
  ATTRIBUTION_LABEL,
  GRADE_LABEL,
  SURFACE_LABEL,
  type Grade,
} from "@/lib/types";

const KINDS = ["statement", "usage", "time", "margin"] as const;
type Kind = (typeof KINDS)[number];

function isKind(s: string): s is Kind {
  return (KINDS as readonly string[]).includes(s);
}

type Cell = string | number | null | undefined;

/** Leading these characters makes a spreadsheet treat the cell as a formula. */
const INJECTION_PREFIX = new Set(["=", "+", "-", "@", "\t", "\r"]);

function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    // A non-finite number would render as "NaN"/"Infinity" in the sheet.
    return Number.isFinite(v) ? String(v) : "";
  }
  let s = v;
  const first = s.charAt(0);
  if (first !== "" && INJECTION_PREFIX.has(first)) s = `'${s}`;
  const needsQuotes =
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r") ||
    /^\s/.test(s);
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: Cell[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Money in cents-precision, never formatted. */
function money(n: number): number {
  return Number.isFinite(n) ? round2(n) : 0;
}

/**
 * A published *rate*, at whatever precision the engine chose for it — cents for
 * an hourly rate, four decimals for a per-million-token rate. Rounding a rate to
 * cents here would undo that choice and put the exported product up to $1.69
 * from the exported amount on a line carrying hundreds of millions of tokens,
 * i.e. a CSV that contradicts the statement it was exported from.
 */
function rate(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** A 0..1 ratio published under a "%" header. */
function pctCell(n: number | null): Cell {
  return n === null || !Number.isFinite(n) ? "" : round2(n * 100);
}

function first(v: string | null): string | undefined {
  return v === null || v === "" ? undefined : v;
}

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function gradeLabel(g: Grade): string {
  return GRADE_LABEL[g];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await params;
  if (!isKind(kind)) return notFound(`Unknown export "${kind}".`);

  const sp = new URL(request.url).searchParams;
  const projectId = first(sp.get("project"));
  const monthParam = first(sp.get("month"));
  const modelFilter = first(sp.get("model"));
  const internal = sp.get("view") === "internal";

  const { month, period } = resolvePeriod(monthParam);

  const project = projectId ? getProject(projectId) : undefined;
  if (projectId && !project) return notFound(`No project "${projectId}".`);
  if (kind === "statement" && !project) {
    return notFound("A statement export requires ?project=<id>.");
  }

  let rows: Cell[][];

  if (kind === "statement" && project) {
    const input = projectBillingInput(project.id, period);
    if (!input) return notFound(`No billing data for project "${project.id}".`);

    const invoice = getInvoiceForPeriod(project.id, period);
    // The tax rate comes from the setting, exactly as the statement page reads it
    // (app/projects/[id]/billing/page.tsx). `invoices.tax_rate` would be the right
    // source for an issued invoice — a snapshot must not move when a setting
    // changes later — but nothing writes that column, so reading it here made the
    // CSV omit tax the page was charging. One source until issue time populates
    // the column; the same floor as the page, so a negative rate cannot credit.
    const parsedTax = Number.parseFloat(getSetting("tax_rate", "0"));
    const taxRate = Number.isFinite(parsedTax) && parsedTax > 0 ? parsedTax : 0;

    const statement = buildStatement(input, {
      invoiceNumber: invoice?.number ?? `DRAFT-${project.code}-${month}`,
      issuedDate: invoice?.issued_date ?? null,
      dueDate: invoice?.due_date ?? null,
      status: invoice?.status ?? "draft",
      taxRate,
    });

    const header: Cell[] = [
      "Workstream code",
      "Workstream",
      "Line kind",
      "Description",
      "Qty",
      "Unit",
      "Unit price",
      "Amount",
    ];
    if (internal) header.push("Cost", "Margin");
    rows = [header];

    for (const g of statement.groups) {
      for (const line of g.lines) {
        const row: Cell[] = [
          g.workstreamCode,
          line.workstreamName,
          line.kind,
          line.description,
          line.qty,
          line.unit,
          rate(line.unitPrice),
          money(line.amount),
        ];
        if (internal) {
          row.push(
            line.internal?.cost === undefined ? "" : money(line.internal.cost),
            line.internal?.margin === undefined ? "" : money(line.internal.margin),
          );
        }
        rows.push(row);
      }
    }

    // The total row carries tax, like the page's "Total due". Where a tax applies
    // it is spelled out as its own row, so the sheet's own rows still add up to
    // the total a reader is asked to pay; with no tax there is nothing to state
    // and the shape stays as it was.
    if (statement.taxRate > 0) {
      const taxPct = round2(statement.taxRate * 100);
      rows.push([
        "",
        "",
        "subtotal",
        `Subtotal ${statement.invoiceNumber}`,
        "",
        "",
        "",
        money(statement.subtotal),
      ]);
      rows.push(["", "", "tax", `Tax (${taxPct}%)`, "", "", "", money(statement.taxAmount)]);
    }

    const totals: Cell[] = [
      "",
      "",
      "total",
      `Total ${statement.invoiceNumber}`,
      "",
      "",
      "",
      money(statement.total),
    ];
    if (internal) totals.push(money(statement.totalCost), money(statement.margin));
    rows.push(totals);
  } else if (kind === "usage") {
    const consultants = new Map(listConsultants().map((c) => [c.id, c]));
    const workstreams = new Map(listWorkstreams().map((w) => [w.id, w]));
    const projects = new Map(listProjects().map((p) => [p.id, p]));

    const usage = modelFilter
      ? listUsageByModel(period, modelFilter)
      : project
        ? listUsageForProject(project.id, period)
        : listUsage(period);
    const sorted = [...usage].sort((a, b) =>
      a.usage_date === b.usage_date
        ? a.id.localeCompare(b.id)
        : a.usage_date.localeCompare(b.usage_date),
    );

    rows = [
      [
        "Date",
        "Consultant",
        "Grade",
        "Project code",
        "Workstream",
        "Model",
        "Surface",
        "Requests",
        "Sessions",
        "Input tokens",
        "Output tokens",
        "Cache read tokens",
        "Cache write tokens",
        "Cache TTL",
        "Batch",
        "Attribution",
        "Cost",
      ],
    ];

    for (const u of sorted) {
      const consultant = consultants.get(u.consultant_id);
      const ws = u.workstream_id === null ? undefined : workstreams.get(u.workstream_id);
      const proj = ws ? projects.get(ws.project_id) : undefined;
      rows.push([
        u.usage_date,
        consultant?.name ?? u.consultant_id,
        consultant ? gradeLabel(consultant.grade) : "",
        proj?.code ?? "",
        ws?.name ?? "",
        u.model,
        SURFACE_LABEL[u.surface],
        u.requests,
        u.sessions,
        u.input_tokens,
        u.output_tokens,
        u.cache_read_tokens,
        u.cache_write_tokens,
        u.cache_write_ttl,
        u.batch === 1 ? "yes" : "no",
        ATTRIBUTION_LABEL[u.attribution],
        money(u.cost_usd),
      ]);
    }
  } else if (kind === "time") {
    const consultants = new Map(listConsultants().map((c) => [c.id, c]));
    const workstreams = new Map(listWorkstreams().map((w) => [w.id, w]));
    const projects = new Map(listProjects().map((p) => [p.id, p]));

    const entries = listTimeEntries(
      project ? { period, projectId: project.id } : { period },
    );

    rows = [
      [
        "Date",
        "Consultant",
        "Grade",
        "Project code",
        "Workstream",
        "Activity",
        "Hours",
        "Billable",
        "Status",
        "Narrative",
      ],
    ];

    for (const t of entries) {
      const consultant = consultants.get(t.consultant_id);
      const ws = workstreams.get(t.workstream_id);
      const proj = ws ? projects.get(ws.project_id) : undefined;
      rows.push([
        t.work_date,
        consultant?.name ?? t.consultant_id,
        consultant ? gradeLabel(consultant.grade) : "",
        proj?.code ?? "",
        ws?.name ?? "",
        t.activity_code,
        t.hours,
        t.billable === 1 ? "yes" : "no",
        t.status,
        t.narrative,
      ]);
    }
  } else {
    // margin — one row per workstream across the whole portfolio.
    rows = [
      [
        "Client",
        "Project code",
        "Workstream",
        "Policy",
        "Billable hours",
        "Labor billable",
        "Labor cost",
        "Claude cost",
        "AI billed",
        "Total billable",
        "Total cost",
        "Margin",
        "Margin %",
        "Budget amount",
        "Amount used",
        "Risk",
      ],
    ];

    for (const input of allProjectBillingInputs(period)) {
      const billing = computeProjectBilling(input);
      for (const w of billing.workstreams) {
        rows.push([
          billing.client.name,
          billing.project.code,
          w.workstream.name,
          AI_POLICY_LABEL[w.policy],
          w.billableHours,
          money(w.laborBillable),
          money(w.laborCost),
          money(w.ai.totalCost),
          money(w.aiBillable),
          money(w.totalBillable),
          money(w.totalCost),
          money(w.margin),
          pctCell(w.marginPct),
          money(w.budget.budgetAmount),
          money(w.budget.amountUsed),
          w.budget.risk,
        ]);
      }
    }
  }

  const filename = `${fileSlug([kind, project?.code ?? "", month].join(" "))}.csv`;

  return new Response(csv(rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
