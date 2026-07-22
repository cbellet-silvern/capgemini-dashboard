/**
 * Parity check between the seeder's cost formula and the app's.
 *
 * `scripts/pricing.mjs` reimplements the token→money formula because it runs on
 * plain Node before any TypeScript exists. That duplication is deliberate but it
 * is a real drift risk: if the two ever disagree, the app would display a cost
 * different from the one frozen on the invoice, and nothing else would notice.
 *
 * So this recomputes every stored `claude_usage.cost_usd` with `PricingBook` —
 * the app's implementation, reading rates from the database — and asserts it
 * matches what the seeder wrote, to the sub-cent.
 *
 * Run with `npm run test:parity`. Requires a seeded database.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

const DB = path.join(process.cwd(), "data", "ledger.db");
if (!existsSync(DB)) {
  console.log("parity check skipped — no data/ledger.db (run `npm run seed`)");
  process.exit(0);
}

// Imported dynamically so the "no database" exit above happens before `lib/db`
// tries to open one.
const { all } = await import("./db");
const { PricingBook } = await import("./pricing");

import type { ClaudeUsageRow, ModelPricingRow } from "./types";

const pricing = new PricingBook(
  all<ModelPricingRow>("SELECT * FROM model_pricing"),
);

const rows = all<ClaudeUsageRow>("SELECT * FROM claude_usage");
assert.ok(rows.length > 0, "expected seeded usage rows");

let worst = 0;
let worstRow: ClaudeUsageRow | null = null;
let mismatches = 0;

for (const r of rows) {
  const recomputed = pricing.cost(r.model, r.usage_date, {
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    cacheWriteTtl: r.cache_write_ttl,
    batch: r.batch === 1,
  });
  const diff = Math.abs(recomputed - r.cost_usd);
  if (diff > worst) {
    worst = diff;
    worstRow = r;
  }
  // A tenth of a cent: far tighter than anything that could reach an invoice,
  // loose enough to tolerate float association order.
  if (diff > 0.001) mismatches++;
}

const totalStored = rows.reduce((t, r) => t + r.cost_usd, 0);

if (mismatches > 0) {
  console.error(
    `\nparity FAILED: ${mismatches} of ${rows.length} rows disagree.\n` +
      `worst diff $${worst.toFixed(6)} on row ${worstRow?.id} ` +
      `(${worstRow?.model} on ${worstRow?.usage_date})\n\n` +
      `scripts/pricing.mjs and lib/pricing.ts have drifted apart — fix both.`,
  );
  process.exit(1);
}

console.log(
  `pricing parity: ${rows.length} usage rows agree with lib/pricing.ts ` +
    `(worst diff $${worst.toExponential(2)}, total $${totalStored.toFixed(2)})`,
);
