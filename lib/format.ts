/**
 * Formatting. Every formatter pins an explicit locale so server-rendered output
 * and client-rendered output cannot disagree — locale drift between the two is a
 * classic React hydration mismatch.
 */

const LOCALE = "en-US";

const money0 = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const money2 = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money4 = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const num0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

/** Whole dollars. For tables and totals. */
export function usd(n: number): string {
  return money0.format(n);
}

/** Dollars and cents. For invoice lines, where the cents are the point. */
export function usdCents(n: number): string {
  return money2.format(n);
}

/** Up to four decimals — Claude rates and per-token costs live down here. */
export function usdRate(n: number): string {
  return money4.format(n);
}

/**
 * Compact currency for stat tiles: $4.2M, $128K, $940. Deliberately lossy —
 * the exact figure belongs in the table view, not the headline.
 */
export function usdCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${num1.format(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}$${num0.format(abs / 1000)}K`;
  if (abs >= 1000) return `${sign}$${num1.format(abs / 1000)}K`;
  return `${sign}$${num0.format(abs)}`;
}

export function count(n: number): string {
  return num0.format(n);
}

/** Hours, one decimal: 1,284.5 h */
export function hours(n: number): string {
  return `${num1.format(n)} h`;
}

/** Percent from a 0..1 ratio. `null` renders as an em dash, never "NaN%". */
export function pct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toLocaleString(LOCALE, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** Signed percent, for deltas: +12%, -3%. */
export function pctSigned(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = pct(Math.abs(v), digits);
  return v < 0 ? `-${s}` : `+${s}`;
}

/** Token counts: 4.2M, 812K, 940. */
export function tokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${num1.format(n / 1_000_000)}M`;
  if (abs >= 1000) return `${num0.format(n / 1000)}K`;
  return num0.format(n);
}

/** Millions of tokens, two decimals — the unit invoice lines are priced in. */
export function mtok(n: number): string {
  return (n / 1_000_000).toLocaleString(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * ISO 'YYYY-MM-DD' → '14 Mar 2026'. Parsed by hand rather than via `new Date()`
 * so a date never shifts a day across timezones.
 */
export function date(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  const month = MONTHS[Number(m) - 1] ?? m;
  return `${Number(d)} ${month} ${y}`;
}

/** '1 Mar – 31 Mar 2026', collapsing a shared month or year. */
export function dateRange(start: string, end: string): string {
  const [sy, sm, sd] = start.split("-");
  const [ey, em, ed] = end.split("-");
  if (!sy || !sm || !sd || !ey || !em || !ed) return `${start} – ${end}`;
  const sMonth = MONTHS[Number(sm) - 1] ?? sm;
  const eMonth = MONTHS[Number(em) - 1] ?? em;
  if (sy === ey && sm === em) return `${Number(sd)}–${Number(ed)} ${eMonth} ${ey}`;
  if (sy === ey) return `${Number(sd)} ${sMonth} – ${Number(ed)} ${eMonth} ${ey}`;
  return `${Number(sd)} ${sMonth} ${sy} – ${Number(ed)} ${eMonth} ${ey}`;
}

/** 'YYYY-MM' → 'Mar 2026'. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  if (!y || !m) return ym;
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** 'YYYY-MM-DD' → 'Mar 14', for dense axis ticks. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
}

/** A slug safe to put in a Content-Disposition filename. */
export function fileSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
