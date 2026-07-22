export interface SparklineProps {
  values: number[];
  slot?: number;
  width?: number;
  height?: number;
  ariaLabel?: string;
}

export function Sparkline({
  values,
  slot = 1,
  width = 96,
  height = 24,
  ariaLabel,
}: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  // One point cannot describe a trend; drawing a lone dot would read as data.
  if (clean.length < 2) return <span className="stat-spark" aria-hidden="true" />;

  const stroke = `var(--series-${Math.min(8, Math.max(1, Math.round(slot)))})`;
  const pad = 4; // room for the end dot plus its ring
  const x0 = pad;
  const x1 = width - pad;
  const y0 = pad;
  const y1 = height - pad;

  let lo = clean[0] ?? 0;
  let hi = lo;
  for (const v of clean) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const flat = hi === lo;
  const span = flat ? 1 : hi - lo;

  const stepX = (x1 - x0) / (clean.length - 1);
  const points = clean.map((v, i) => {
    const x = x0 + i * stepX;
    const y = flat ? (y0 + y1) / 2 : y1 - ((v - lo) / span) * (y1 - y0);
    return { x, y };
  });
  const last = points[points.length - 1];

  return (
    <svg
      className="stat-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? "Trend sparkline"}
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")}
      />
      {last ? (
        <circle
          cx={last.x.toFixed(2)}
          cy={last.y.toFixed(2)}
          r={2.5}
          fill={stroke}
          stroke="var(--surface-1)"
          strokeWidth={2}
        />
      ) : null}
    </svg>
  );
}
