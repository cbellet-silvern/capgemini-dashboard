import {
  count,
  hours,
  mtok,
  pct,
  tokens,
  usd,
  usdCents,
  usdCompact,
  usdRate,
} from "@/lib/format";

export type ValueFormat =
  | "usd"
  | "usdCents"
  | "usdRate"
  | "count"
  | "hours"
  | "tokens"
  | "pct"
  | "mtok";

/** Full-precision form: table views, tooltips, end labels. */
export function formatValue(v: number, f: ValueFormat): string {
  if (!Number.isFinite(v)) return "—";
  switch (f) {
    case "usd":
      return usd(v);
    case "usdCents":
      return usdCents(v);
    case "usdRate":
      return usdRate(v);
    case "count":
      return count(v);
    case "hours":
      return hours(v);
    case "tokens":
      return tokens(v);
    case "pct":
      return pct(v);
    case "mtok":
      return mtok(v);
  }
}

const compact1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const compact0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Bare compact number: 4.2M, 812K, 940. Used for non-currency axis ticks. */
function compact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${compact1.format(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}${compact0.format(abs / 1000)}K`;
  if (abs >= 1000) return `${sign}${compact1.format(abs / 1000)}K`;
  return `${sign}${compact1.format(abs)}`;
}

/**
 * Axis ticks are deliberately lossy — a tick only has to place the reader on the
 * scale; the exact figure lives in the tooltip and the table view.
 */
export function formatTick(v: number, f: ValueFormat): string {
  if (!Number.isFinite(v)) return "—";
  switch (f) {
    case "usd":
    case "usdCents":
    case "usdRate":
      return usdCompact(v);
    case "count":
    case "hours":
      return compact(v);
    case "tokens":
      return tokens(v);
    case "pct":
      return pct(v);
    case "mtok":
      return mtok(v);
  }
}
