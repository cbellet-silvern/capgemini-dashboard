/**
 * Token → money.
 *
 * Rates are read from the `model_pricing` table, never from a file, so the
 * Settings screen can change them and the change is real. Rows are
 * effective-dated: the rate applied to a usage row is the one with the greatest
 * `effective_from` that is still <= the usage date. That is what makes a
 * repricing non-retroactive — an invoice issued in June is not rewritten when
 * September's rates land.
 *
 * The seeder carries the same formula in `scripts/pricing.mjs` (it runs on plain
 * Node, before any TypeScript exists). If you change the formula, change both.
 */

import type { CacheTtl, ModelPricingRow } from "./types";

/** Flat discount applied to every token rate when a request goes through the Batch API. */
export const BATCH_DISCOUNT = 0.5;

const MTOK = 1_000_000;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWriteTtl?: CacheTtl;
  batch?: boolean;
}

/** Indexes pricing rows by model, each list sorted newest-effective-first. */
export class PricingBook {
  private readonly byModel = new Map<string, ModelPricingRow[]>();

  constructor(rows: readonly ModelPricingRow[]) {
    for (const row of rows) {
      const list = this.byModel.get(row.model);
      if (list) list.push(row);
      else this.byModel.set(row.model, [row]);
    }
    for (const list of this.byModel.values()) {
      // Descending, so the first row whose effective_from <= date is the winner.
      list.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    }
  }

  models(): string[] {
    return [...this.byModel.keys()];
  }

  /** All rate rows for a model, newest-effective-first. */
  history(model: string): ModelPricingRow[] {
    return this.byModel.get(model) ?? [];
  }

  /**
   * The rate in effect for `model` on `date`, or null if the model is unknown or
   * the date precedes every rate row. Callers decide whether that is fatal.
   */
  rateOn(model: string, date: string): ModelPricingRow | null {
    const list = this.byModel.get(model);
    if (!list) return null;
    for (const row of list) {
      if (row.effective_from <= date) return row;
    }
    return null;
  }

  /** Display name for a model id, falling back to the id itself. */
  displayName(model: string): string {
    const list = this.byModel.get(model);
    return list?.[0]?.display_name ?? model;
  }

  /** Tier ('frontier' | 'opus' | 'sonnet' | 'haiku') for a model id. */
  tier(model: string): string {
    const list = this.byModel.get(model);
    return list?.[0]?.tier ?? "unknown";
  }

  /**
   * Metered cost in USD, at full floating precision — rounding belongs at the
   * invoice line, not here. Returns 0 when no rate applies rather than throwing,
   * so one unrecognised row cannot take down a whole statement.
   *
   * That 0 is deliberately ambiguous and therefore dangerous: it reads the same
   * as usage that genuinely cost nothing. A caller that has to tell the two
   * apart — anything that bills, warns, or reconciles — must use `costOrNull`.
   */
  cost(model: string, date: string, t: TokenCounts): number {
    return this.costOrNull(model, date, t) ?? 0;
  }

  /**
   * Metered cost, or null when no rate applies to `date`: an unknown model, or a
   * model whose every rate row starts after the usage happened. The second case
   * is the one that hides — the model looks known, so a "do we price this model"
   * check passes while the line silently costs $0 and the revenue is lost.
   */
  costOrNull(model: string, date: string, t: TokenCounts): number | null {
    const rate = this.rateOn(model, date);
    if (!rate) return null;
    const cacheWriteRate =
      t.cacheWriteTtl === "1h"
        ? rate.cache_write_1h_per_mtok
        : rate.cache_write_5m_per_mtok;

    const raw =
      (t.inputTokens / MTOK) * rate.input_per_mtok +
      (t.outputTokens / MTOK) * rate.output_per_mtok +
      (t.cacheReadTokens / MTOK) * rate.cache_read_per_mtok +
      (t.cacheWriteTokens / MTOK) * cacheWriteRate;

    return t.batch ? raw * (1 - BATCH_DISCOUNT) : raw;
  }

  /**
   * True when nothing can price this usage — surfaced as a data-quality warning.
   *
   * Pass the usage date. "Do we know this model at all" is the wrong question:
   * a model whose only rate row starts next month is known, and costs $0 for
   * every row before that date. Asking without a date answers the weaker
   * question, kept only for callers that hold no date to ask about.
   */
  isUnpriced(model: string, date?: string): boolean {
    if (date === undefined) return !this.byModel.has(model);
    return this.rateOn(model, date) === null;
  }
}

/**
 * What a model costs per million tokens at a nominal 3:1 input:output mix.
 * Used only for the Settings comparison column — never for billing.
 */
export function blendedPerMTok(rate: ModelPricingRow): number {
  return rate.input_per_mtok * 0.75 + rate.output_per_mtok * 0.25;
}
