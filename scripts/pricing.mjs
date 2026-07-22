/**
 * Token → money, for the seeder.
 *
 * The app does this in `lib/pricing.ts` against the `model_pricing` table. The
 * seeder cannot import TypeScript (it runs on plain Node, before the database
 * even exists), so the formula lives here a second time. If you change one,
 * change both — a divergence shows up as invoice totals that do not reconcile.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = path.join(HERE, "..", "lib", "model-pricing.json");

const MTOK = 1_000_000;

/** Matches BATCH_DISCOUNT in lib/pricing.ts; overridden by the file when present. */
const DEFAULT_BATCH_DISCOUNT = 0.5;

/** The parsed pricing file. Read at call time — no import attributes. */
export function loadPricing() {
  return JSON.parse(readFileSync(PRICING_PATH, "utf8"));
}

/** Accepts either the rate array or the whole pricing object. */
function rateList(rates) {
  return Array.isArray(rates) ? rates : (rates?.rates ?? []);
}

function batchDiscount(rates) {
  if (Array.isArray(rates)) return DEFAULT_BATCH_DISCOUNT;
  return typeof rates?.batchDiscount === "number"
    ? rates.batchDiscount
    : DEFAULT_BATCH_DISCOUNT;
}

/**
 * The rate row in effect for `model` on `date`: greatest effectiveFrom <= date.
 * Null when the model is unknown or every row postdates `date`.
 */
export function rateOn(rates, model, date) {
  let best = null;
  for (const row of rateList(rates)) {
    if (row.model !== model) continue;
    if (row.effectiveFrom > date) continue;
    if (best === null || row.effectiveFrom > best.effectiveFrom) best = row;
  }
  return best;
}

/** Metered cost in USD at full precision. Rounding belongs at the invoice line. */
export function costOf(rates, model, date, tokens) {
  const rate = rateOn(rates, model, date);
  if (!rate) return 0;

  const cacheWriteRate =
    tokens.cacheWriteTtl === "1h"
      ? rate.cacheWrite1hPerMTok
      : rate.cacheWrite5mPerMTok;

  const raw =
    ((tokens.inputTokens ?? 0) / MTOK) * rate.inputPerMTok +
    ((tokens.outputTokens ?? 0) / MTOK) * rate.outputPerMTok +
    ((tokens.cacheReadTokens ?? 0) / MTOK) * rate.cacheReadPerMTok +
    ((tokens.cacheWriteTokens ?? 0) / MTOK) * cacheWriteRate;

  return tokens.batch ? raw * (1 - batchDiscount(rates)) : raw;
}
