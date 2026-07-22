const STEPS = [1, 2, 2.5, 5, 10];

/** Kills float dust like 0.30000000000000004 from repeated addition of a step. */
function snap(v: number, step: number): number {
  const decimals = Math.min(10, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

function chooseStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  for (const s of STEPS) {
    if (norm <= s) return s * mag;
  }
  return 10 * mag;
}

/**
 * Rounded tick values covering the domain. Callers pass min = 0 for the usual
 * baseline-at-zero chart; a domain that straddles zero keeps 0 as a tick because
 * the step grid is anchored on it.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);

  // A degenerate domain has no scale to derive — fall back to a 0..1 axis so the
  // chart still draws gridlines instead of collapsing.
  if (lo === hi) {
    if (hi === 0) return [0, 1];
    if (hi > 0) lo = 0;
    else hi = 0;
  }

  const step = chooseStep(hi - lo, target);
  if (!Number.isFinite(step) || step <= 0) return [0, 1];

  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const guard = 64;
  for (let i = 0; i <= guard; i++) {
    const v = snap(start + i * step, step);
    ticks.push(v);
    if (v >= end) break;
  }
  if (ticks.length < 2) return [0, 1];
  return ticks;
}

/** Upper bound rounded to a clean number at or above `max`. */
export function niceMax(max: number): number {
  const ticks = niceTicks(0, max);
  const top = ticks[ticks.length - 1];
  if (top === undefined || !Number.isFinite(top)) return 1;
  return top;
}
