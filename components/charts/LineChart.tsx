"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { shortDate } from "@/lib/format";
import { TableView } from "./TableView";
import { formatTick, formatValue, type ValueFormat } from "./valueFormat";
import { niceTicks } from "./scale";

export interface LineSeries {
  name: string;
  slot: number;
  points: Array<{ x: string; y: number }>;
}

export interface LineChartProps {
  series: LineSeries[];
  height?: number;
  yFormat?: ValueFormat;
  area?: boolean;
  labelLast?: boolean;
  xIsDate?: boolean;
  ariaLabel: string;
}

/**
 * The SVG is authored in a fixed 720-unit coordinate system and scaled by CSS
 * (`.chart svg { width: 100% }`) with the aspect ratio preserved. Everything —
 * type size, tick stride, label collision — is therefore reasoned about once, in
 * chart units, and stays proportional at every container width. The only place
 * that needs real CSS pixels is the tooltip, which is a DOM node.
 */
const VW = 720;
/** Rough advance width of the 10.5px tick face, used for collision maths. */
const CHAR = 6.1;
const TIP_W = 196;

function hue(slot: number): string {
  const n = Math.min(8, Math.max(1, Math.round(slot)));
  return `var(--series-${n})`;
}

export function LineChart({
  series,
  height = 220,
  yFormat = "usd",
  area = false,
  labelLast,
  xIsDate = true,
  ariaLabel,
}: LineChartProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pointerX, setPointerX] = useState<number | null>(null);
  const [boxW, setBoxW] = useState(VW);

  const first = series[0];
  const xs = first ? first.points.map((p) => p.x) : [];
  const n = xs.length;

  const valueAt = (s: LineSeries, i: number): number => {
    const p = s.points[i];
    const v = p ? p.y : 0;
    return Number.isFinite(v) ? v : 0;
  };

  if (series.length === 0 || n === 0) {
    return <div className="empty">No data to chart for this period.</div>;
  }

  let dataMax = 0;
  let dataMin = 0;
  for (const s of series) {
    for (let i = 0; i < n; i += 1) {
      const v = valueAt(s, i);
      if (v > dataMax) dataMax = v;
      if (v < dataMin) dataMin = v;
    }
  }

  const ticks = niceTicks(dataMin, dataMax);
  const y0 = ticks[0] ?? dataMin;
  const y1 = ticks[ticks.length - 1] ?? dataMax;
  const span = y1 - y0 > 0 ? y1 - y0 : 1;

  const showEnd = labelLast ?? series.length <= 4;
  const endLabelRoom = showEnd
    ? Math.min(
        96,
        8 +
          CHAR *
            Math.max(
              ...series.map((s) => formatValue(valueAt(s, n - 1), yFormat).length),
            ),
      )
    : 14;

  const ml = 56;
  const mr = Math.max(14, endLabelRoom);
  const mt = 12;
  const mb = 30;
  const pw = Math.max(40, VW - ml - mr);
  const ph = Math.max(40, height - mt - mb);

  const step = n > 1 ? pw / (n - 1) : pw;
  const xPos = (i: number): number => (n > 1 ? ml + i * step : ml + pw / 2);
  const yPos = (v: number): number => mt + (1 - (v - y0) / span) * ph;

  const linePath = (s: LineSeries): string => {
    const parts: string[] = [];
    for (let i = 0; i < n; i += 1) {
      parts.push(`${i === 0 ? "M" : "L"}${xPos(i).toFixed(2)} ${yPos(valueAt(s, i)).toFixed(2)}`);
    }
    return parts.join(" ");
  };

  const areaSeries = area && series.length === 1 ? series[0] : undefined;
  const areaPath = (s: LineSeries): string => {
    const base = yPos(Math.max(y0, 0)).toFixed(2);
    return `${linePath(s)} L${xPos(n - 1).toFixed(2)} ${base} L${xPos(0).toFixed(2)} ${base} Z`;
  };

  // Thin the x labels until each one owns enough room for its own width.
  const widestX = Math.max(
    ...xs.map((x) => (xIsDate ? shortDate(x).length : x.length)),
  );
  const slotWidth = Math.max(28, widestX * CHAR + 10);
  const maxLabels = Math.max(2, Math.floor(pw / slotWidth));
  const stride = Math.max(1, Math.ceil(n / maxLabels));

  const endLabels: Array<{ y: number; text: string; slot: number }> = [];
  if (showEnd) {
    const cand = series
      .map((s) => ({
        y: yPos(valueAt(s, n - 1)),
        text: formatValue(valueAt(s, n - 1), yFormat),
        slot: s.slot,
      }))
      .sort((a, b) => a.y - b.y);
    for (const c of cand) {
      // Two end-labels closer than a line-height would overlap: legend only.
      if (endLabels.every((k) => Math.abs(k.y - c.y) >= 14)) endLabels.push(c);
    }
  }

  const track = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const scale = rect.width / VW;
    const local = clientX - rect.left;
    const svgX = local / scale;
    const raw = n > 1 ? Math.round((svgX - ml) / step) : 0;
    setBoxW(rect.width);
    setHoverIndex(Math.max(0, Math.min(n - 1, raw)));
    setPointerX(local);
  };

  const clear = () => {
    setHoverIndex(null);
    setPointerX(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const el = wrapRef.current;
      if (el) {
        const w = el.getBoundingClientRect().width;
        if (w > 0) setBoxW(w);
      }
      setPointerX(null);
      setHoverIndex((prev) => {
        const base = prev == null ? (delta > 0 ? -1 : n) : prev;
        return Math.max(0, Math.min(n - 1, base + delta));
      });
    } else if (e.key === "Escape") {
      clear();
    }
  };

  const scale = boxW > 0 ? boxW / VW : 1;
  const hoverX = hoverIndex == null ? 0 : xPos(hoverIndex);
  const anchor = pointerX ?? hoverX * scale;
  const flip = anchor + 14 + TIP_W > boxW;
  const rawLeft = flip ? anchor - 14 - TIP_W : anchor + 14;
  const tipLeft = Math.max(2, Math.min(rawLeft, Math.max(2, boxW - TIP_W - 2)));

  const hoverRows =
    hoverIndex == null
      ? []
      : series
          .map((s) => ({
            name: s.name,
            slot: s.slot,
            value: valueAt(s, hoverIndex),
          }))
          .sort((a, b) => b.value - a.value);

  const xLabel = (x: string): string => (xIsDate ? shortDate(x) : x);

  const columns = [
    { key: "x", label: xIsDate ? "Date" : "Period", numeric: false },
    ...series.map((s, i) => ({ key: `s${i}`, label: s.name, numeric: true })),
  ];
  const rows = xs.map((x, i) => {
    const row: Record<string, string | number> = { x: xLabel(x) };
    series.forEach((s, si) => {
      row[`s${si}`] = formatValue(valueAt(s, i), yFormat);
    });
    return row;
  });

  return (
    <div className="chart">
      <div
        ref={wrapRef}
        style={{ position: "relative" }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={clear}
      >
        <svg
          viewBox={`0 0 ${VW} ${height}`}
          role="img"
          aria-label={ariaLabel}
          style={{ display: "block" }}
        >
          <g className="chart-grid">
            {ticks.map((t) => (
              <line key={t} x1={ml} x2={ml + pw} y1={yPos(t)} y2={yPos(t)} />
            ))}
          </g>

          {ticks.map((t) => (
            <text
              key={`yt-${t}`}
              className="chart-tick"
              x={ml - 8}
              y={yPos(t) + 3.5}
              textAnchor="end"
            >
              {formatTick(t, yFormat)}
            </text>
          ))}

          <g className="chart-axis">
            <line x1={ml} x2={ml + pw} y1={mt + ph} y2={mt + ph} />
          </g>

          {xs.map((x, i) =>
            i % stride === 0 ? (
              <text
                key={`xt-${i}-${x}`}
                className="chart-tick"
                x={xPos(i)}
                y={mt + ph + 16}
                textAnchor="middle"
              >
                {xLabel(x)}
              </text>
            ) : null,
          )}

          {areaSeries ? (
            <path d={areaPath(areaSeries)} fill={hue(areaSeries.slot)} fillOpacity={0.1} stroke="none" />
          ) : null}

          {series.map((s) => (
            <path
              key={`line-${s.name}`}
              d={linePath(s)}
              fill="none"
              stroke={hue(s.slot)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {endLabels.map((l) => (
            <text
              key={`end-${l.slot}-${l.text}`}
              className="chart-value"
              x={ml + pw + 8}
              y={l.y + 3.5}
              textAnchor="start"
            >
              {l.text}
            </text>
          ))}

          {hoverIndex != null ? (
            <>
              <line
                className="chart-crosshair"
                x1={hoverX}
                x2={hoverX}
                y1={mt}
                y2={mt + ph}
              />
              {series.map((s) => (
                <circle
                  key={`mk-${s.name}`}
                  cx={hoverX}
                  cy={yPos(valueAt(s, hoverIndex))}
                  r={4}
                  fill={hue(s.slot)}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              ))}
            </>
          ) : null}

          <rect
            className="chart-hover-target"
            x={ml}
            y={mt}
            width={pw}
            height={ph}
            onMouseMove={(e) => track(e.clientX)}
            onMouseLeave={clear}
            onPointerMove={(e) => track(e.clientX)}
            onPointerLeave={clear}
          />
        </svg>

        {hoverIndex != null ? (
          <div
            className="tooltip"
            style={{ left: tipLeft, top: 8, width: TIP_W }}
            role="status"
          >
            <div className="tooltip-title">{xLabel(xs[hoverIndex] ?? "")}</div>
            {hoverRows.map((r) => (
              <div className="tooltip-row" key={`tr-${r.name}`}>
                <span className="legend-swatch" style={{ background: hue(r.slot) }} />
                <span className="tooltip-name">{r.name}</span>
                <span className="tooltip-num">{formatValue(r.value, yFormat)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {series.length >= 2 ? (
        <div className="chart-legend">
          {series.map((s) => (
            <span className="legend-item" key={`lg-${s.name}`}>
              <span className="legend-swatch is-line" style={{ background: hue(s.slot) }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}

      <TableView columns={columns} rows={rows} caption={ariaLabel} />
    </div>
  );
}
