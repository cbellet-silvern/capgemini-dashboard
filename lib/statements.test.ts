/**
 * Integration test: drives the real engine over every project-month in the
 * seeded database and asserts the invariants that a statement must satisfy
 * before anyone sends it to a client.
 *
 * The unit tests in billing.test.ts use fixtures; this one uses the actual data,
 * which is where rounding interactions and empty-period edge cases surface. It
 * exists because a false alarm on the reconciliation panel — a red "do not issue
 * this invoice" banner on a perfectly sound statement — is as damaging in a
 * client meeting as a real error, and only running all 32 catches it.
 *
 * Run with `npm run test:statements`. Requires a seeded database.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

if (!existsSync(path.join(process.cwd(), "data", "ledger.db"))) {
  console.log("statement check skipped — no data/ledger.db (run `npm run seed`)");
  process.exit(0);
}

const { buildStatement, computePortfolio, computeProjectBilling, round2, sum } =
  await import("./billing");
const {
  availableMonths,
  getInvoiceForPeriod,
  listProjects,
  monthPeriod,
  pricingBook,
  projectBillingInput,
} = await import("./queries");

const months = availableMonths().slice().sort();
const projects = listProjects();
const pricing = pricingBook();

assert.ok(months.length > 0, "expected at least one month of data");
assert.ok(projects.length > 0, "expected seeded projects");

let statements = 0;
let unbalanced = 0;
let poolDriftRows = 0;
let worstPoolDrift = 0;
let worstLineDrift = 0;
let worstTokenDrift = 0;
let worstCrossPathDrift = 0;
const hoursLineFailures: string[] = [];
const crossPathFailures: string[] = [];
const qtyPrecisionFailures: string[] = [];
const nonFinitePaths: string[] = [];

/** Walks a computed result looking for NaN / Infinity, reporting where it sits. */
function assertFinite(value: unknown, trail: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) nonFinitePaths.push(`${trail} = ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertFinite(v, `${trail}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertFinite(v, `${trail}.${k}`);
  }
}

for (const project of projects) {
  for (const month of months) {
    const period = monthPeriod(month);
    const input = projectBillingInput(project.id, period, pricing);
    assert.ok(input, `no billing input for ${project.code} ${month}`);

    const invoice = getInvoiceForPeriod(project.id, period);
    const billing = computeProjectBilling(input);
    const statement = buildStatement(input, {
      invoiceNumber: invoice?.number ?? `DRAFT-${project.code}-${month}`,
      status: invoice?.status ?? "draft",
      taxRate: 0,
    });
    statements++;

    // 1. The untagged pool must account for every dollar, checked unrounded.
    if (!statement.unattributedBalances) {
      unbalanced++;
      console.error(`  unbalanced pool: ${project.code} ${month}`);
    }

    // 2. The rounded display figures may drift a cent. Track it so the number in
    //    the reconciliation panel's tolerance story stays honest.
    const poolParts = round2(
      statement.unattributedAllocatedCost +
        statement.unattributedElsewhereCost +
        statement.unattributedResidualCost,
    );
    const poolDrift = Math.abs(poolParts - statement.unattributedPoolCost);
    if (poolDrift > 0.0001) poolDriftRows++;
    worstPoolDrift = Math.max(worstPoolDrift, poolDrift);

    // 3. The lines on the page must add up to the total on the page, exactly.
    const lineSum = round2(sum(statement.groups.flatMap((g) => g.lines.map((l) => l.amount))));
    const lineDrift = Math.abs(round2(lineSum + statement.taxAmount) - statement.total);
    worstLineDrift = Math.max(worstLineDrift, lineDrift);

    // 4. Group subtotals must sum to the statement subtotal.
    assert.equal(
      round2(sum(statement.groups.map((g) => g.subtotal))),
      statement.subtotal,
      `${project.code} ${month}: group subtotals do not sum to the statement subtotal`,
    );

    // 5. Every line must multiply out as printed. Checked here rather than only in
    //    the unit tests because the error scales with magnitude: a fixture with
    //    single-digit token counts passes a 2dp rate that is $1.69 out on a real
    //    198-million-token line.
    for (const line of statement.groups.flatMap((g) => g.lines)) {
      if (line.amount === 0) continue;
      if (line.unit === "hrs") {
        if (round2(line.qty * line.unitPrice) !== line.amount) {
          hoursLineFailures.push(
            `${project.code} ${month}: ${line.description} — ${line.qty} x ${line.unitPrice} != ${line.amount}`,
          );
        }
        // The quantity's contract is two decimals. Whatever renders it prints two,
        // so this pins the precision the engine promises rather than the one the
        // current seed happens to produce (half hours, exact at one decimal).
        if (line.qty !== round2(line.qty)) {
          qtyPrecisionFailures.push(
            `${project.code} ${month}: ${line.description} — qty ${line.qty} is finer than 2dp`,
          );
        }
      } else if (line.unit === "M tokens") {
        const drift = Math.abs(round2(line.qty * line.unitPrice) - line.amount);
        worstTokenDrift = Math.max(worstTokenDrift, drift);
      }
    }

    // 6. The invoice and the dashboards must agree to the cent. The project pages
    //    and the portfolio CSV print WorkstreamBilling.totalBillable while the
    //    statement page foots the same workstream's lines to group.subtotal — two
    //    paths over one input, so nobody can reconcile them if they differ. They
    //    did: rounding the AI charge over the aggregate put 34 workstream-months
    //    up to 2c out and 16 project-months up to 4c out.
    for (const g of statement.groups) {
      const w = billing.workstreams.find((x) => x.workstream.id === g.workstreamId);
      if (!w) {
        crossPathFailures.push(`${project.code} ${month}: no workstream for ${g.workstreamId}`);
        continue;
      }
      const drift = Math.abs(g.subtotal - w.totalBillable);
      worstCrossPathDrift = Math.max(worstCrossPathDrift, drift);
      if (drift > 0.0001) {
        crossPathFailures.push(
          `${project.code} ${month} ${g.workstreamCode}: lines foot to ${g.subtotal}, reported total ${w.totalBillable}`,
        );
      }
      const fees = round2(sum(g.lines.filter((l) => l.kind === "fixed_fee").map((l) => l.amount)));
      if (fees !== w.fixedFee) {
        crossPathFailures.push(
          `${project.code} ${month} ${g.workstreamCode}: fixed-fee lines ${fees} vs reported ${w.fixedFee}`,
        );
      }
    }
    const projectDrift = Math.abs(statement.subtotal - billing.totalBillable);
    worstCrossPathDrift = Math.max(worstCrossPathDrift, projectDrift);
    if (projectDrift > 0.0001) {
      crossPathFailures.push(
        `${project.code} ${month}: statement subtotal ${statement.subtotal} vs project total ${billing.totalBillable}`,
      );
    }

    // 7. Nothing non-finite may reach the page.
    assertFinite(statement, `${project.code}/${month}`);
    assertFinite(billing, `${project.code}/${month}/billing`);

    // 8. An issued invoice's stored snapshot must still match a recompute. If
    //    this ever drifts the statement page says so; here it must not drift at
    //    all, because nothing has edited the data since the seed wrote it.
    if (invoice && invoice.status !== "draft") {
      assert.ok(
        Math.abs(invoice.total - statement.total) < 0.011,
        `${project.code} ${month}: issued snapshot ${invoice.total} vs recompute ${statement.total}`,
      );
    }
  }
}

// Portfolio roll-up over the latest month must also be finite and consistent.
const latest = months[months.length - 1];
assert.ok(latest);
const portfolio = computePortfolio(
  projects
    .map((p) => projectBillingInput(p.id, monthPeriod(latest), pricing))
    .filter((i): i is NonNullable<typeof i> => i !== null)
    .map((i) => computeProjectBilling(i)),
);
assertFinite(portfolio, "portfolio");
assert.equal(
  portfolio.margin,
  round2(portfolio.totalBillable - portfolio.totalCost),
  "portfolio margin must equal billable minus cost",
);

const problems: string[] = [];
if (unbalanced > 0) problems.push(`${unbalanced} statements have an unbalanced untagged pool`);
if (worstLineDrift > 0.0001) {
  problems.push(`lines do not reconcile to the total (worst $${worstLineDrift.toFixed(6)})`);
}
if (nonFinitePaths.length > 0) {
  problems.push(`${nonFinitePaths.length} non-finite values: ${nonFinitePaths.slice(0, 5).join("; ")}`);
}
if (hoursLineFailures.length > 0) {
  problems.push(
    `${hoursLineFailures.length} hours lines do not multiply out: ${hoursLineFailures.slice(0, 3).join(" | ")}`,
  );
}
if (qtyPrecisionFailures.length > 0) {
  problems.push(
    `${qtyPrecisionFailures.length} hours quantities are finer than 2dp: ${qtyPrecisionFailures.slice(0, 3).join(" | ")}`,
  );
}
if (crossPathFailures.length > 0) {
  problems.push(
    `${crossPathFailures.length} totals disagree between the statement and the dashboards: ${crossPathFailures.slice(0, 3).join(" | ")}`,
  );
}
// Two cents of slack. The quantity (3dp) and the rate (4dp) are rounded for
// display independently, so the printed product cannot be exact: the residual is
// bounded by (qty_error x rate) + (qty x rate_error), which grows with the size of
// the line. Anything beyond this means a precision somewhere is too coarse for the
// magnitudes in play — which is exactly how the $1.69 version was caught.
if (worstTokenDrift > 0.021) {
  problems.push(`worst token-line drift $${worstTokenDrift.toFixed(4)} exceeds two cents`);
}

if (problems.length > 0) {
  console.error(`\nstatement integration FAILED:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(
  `statements: ${statements} across ${projects.length} projects x ${months.length} months\n` +
    `  untagged pool balances on all ${statements} (checked unrounded)\n` +
    `  lines reconcile to the stated total exactly (worst drift $${worstLineDrift.toFixed(6)})\n` +
    `  every hours line multiplies out exactly at a 2dp quantity; worst token-line drift $${worstTokenDrift.toFixed(4)}\n` +
    `  every workstream and project total equals the lines the statement prints (worst drift $${worstCrossPathDrift.toFixed(6)})\n` +
    `  cent-level display drift on ${poolDriftRows} of ${statements} pool subtotals (worst $${worstPoolDrift.toFixed(4)}) — expected, and annotated in the UI\n` +
    `  no NaN or Infinity anywhere in any statement or roll-up`,
);
