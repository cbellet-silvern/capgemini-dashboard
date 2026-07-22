"use client";

import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { shortDate } from "@/lib/format";
import { TableView } from "./TableView";
import { formatTick, formatValue, type ValueFormat } from "./valueFormat";
import { niceMax, niceTicks } from "./scale";

export interface StackedBarSeries {
  name: string;
  slot: number;
  values: number[];
}

export interface StackedBarChartProps {
  categories: string[];
  series: StackedBarSeries[];
  height?: number;
  yFormat?: ValueFormat;
  horizontal?: boolean;
  showTotals?: boolean;
  xIsDate?: boolean;
  ariaLabel: string;
}

/**
 * Authored in a fixed 720-unit coordinate system and scaled by CSS with the
 * aspect ratio preserved, so type never distorts and every fit test (label
 * widths, bar thickness, tick stride) can be done once in chart units.
 */
const VW = 720;
const CHAR = 6.1;
const BAR_MAX = 24;
const GAP = 2;
const TIP_W = 208;

function hue(slot: number): string {
  const n = Math.min(8, Math.max(1, Math.round(slot)));
  return `var(--series-${n})`;
}

function truncate(label: string, maxChars: number): string {
  if (maxChars < 2) return "…";
  return label.length <= maxChars ? label : `${label.slice(0, maxChars - 1)}…`;
}

/** Rounded on the data end only; the baseline end stays square. */
function capPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  end: "top" | "right",
): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (end === "top") {
    return [
      `M${x} ${y + h}`,
      `L${x} ${y + rr}`,
      `Q${x} ${y} ${x + rr} ${y}`,
      `L${x + w - rr} ${y}`,
      `Q${x + w} ${y} ${x + w} ${y + rr}`,
      `L${x + w} ${y + h}`,
      "Z",
    ].join(" ");
  }
  const rh = Math.max(0, Math.min(r, h / 2, w));
  return [
    `M${x} ${y}`,
    `L${x + w - rh} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + rh}`,
    `L${x + w} ${y + h - rh}`,
    `Q${x + w} ${y + h} ${x + w - rh} ${y + h}`,
    `L${x} ${y + h}`,
    "Z",
  ].join(" ");
}

interface Seg {
  cat: number;
  si: number;
  x: number;
  y: number;
  w: number;
  h: number;
  outer: boolean;
}

export function StackedBarChart({
  categories,
  series,
  height = 260,
  yFormat = "usd",
  horizontal = false,
  showTotals = false,
  xIsDate = false,
  ariaLabel,
}: StackedBarChartProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ cat: number; si: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; boxW: number; boxH: number }>({
    x: 0,
    y: 0,
    boxW: VW,
    boxH: 0,
  });

  const n = categories.length;

  const valueAt = (s: StackedBarSeries, i: number): number => {
    const v = s.values[i];
    if (v == null || !Number.isFinite(v) || v < 0) return 0;
    return v;
  };

  if (n === 0 || series.length === 0) {
    return <div className="empty">No data to chart for this period.</div>;
  }

  const totals = categories.map((_, i) =>
    series.reduce((acc, s) => acc + valueAt(s, i), 0),
  );
  const maxTotal = totals.reduce((a, b) => (b > a ? b : a), 0);
  // A 0-max domain would divide by zero; keep the axis honest but finite.
  const domainMax = Math.max(niceMax(maxTotal), 1);
  const ticks = niceTicks(0, domainMax);

  const label = (c: string): string => (xIsDate ? shortDate(c) : c);
  const labels = categories.map(label);

  const mt = showTotals && !horizontal ? 22 : 12;
  const ml = horizontal
    ? Math.min(180, Math.max(72, Math.round(Math.max(...labels.map((l) => l.length)) * CHAR) + 12))
    : 56;
  const mr = horizontal ? (showTotals ? 68 : 18) : 18;
  const mb = 32;
  const pw = Math.max(40, VW - ml - mr);
  const ph = Math.max(40, height - mt - mb);

  const band = (horizontal ? ph : pw) / n;
  const thick = Math.max(3, Math.min(BAR_MAX, band - 6));
  const valueLen = horizontal ? pw : ph;
  const scaleVal = (v: number): number => (v / domainMax) * valueLen;

  const segs: Seg[] = [];
  const capAt: number[] = [];
  categories.forEach((_, ci) => {
    const bandStart = (horizontal ? mt : ml) + band * ci;
    const centre = bandStart + band / 2;
    let cum = 0;
    let placedBelow = false;
    let cap = horizontal ? ml : mt + ph;
    // The outermost non-zero segment owns the rounded cap.
    let lastNonZero = -1;
    series.forEach((s, si) => {
      if (valueAt(s, ci) > 0) lastNonZero = si;
    });
    series.forEach((s, si) => {
      const v = valueAt(s, ci);
      const len = scaleVal(v);
      const start = scaleVal(cum);
      cum += v;
      if (len <= 0) return;
      const outer = si === lastNonZero;
      if (horizontal) {
        let x = ml + start;
        let w = len;
        if (placedBelow) {
          x += GAP;
          w -= GAP;
        }
        if (w > 0.4) {
          segs.push({
            cat: ci,
            si,
            x,
            y: centre - thick / 2,
            w,
            h: thick,
            outer,
          });
        }
        cap = ml + start + len;
      } else {
        const bottom = mt + ph - start;
        const y = bottom - len;
        let h = len;
        if (placedBelow) h -= GAP;
        if (h > 0.4) {
          segs.push({
            cat: ci,
            si,
            x: centre - thick / 2,
            y,
            w: thick,
            h,
            outer,
          });
        }
        cap = bottom - len;
      }
      placedBelow = true;
    });
    capAt.push(cap);
  });

  const bandCentre = (ci: number): number =>
    (horizontal ? mt : ml) + band * ci + band / 2;

  // Value-axis tick labels on the value axis; category labels on the other one.
  const catStride = horizontal
    ? 1
    : Math.max(
        1,
        Math.ceil(
          n /
            Math.max(
              2,
              Math.floor(pw / Math.max(28, Math.max(...labels.map((l) => l.length)) * CHAR + 10)),
            ),
        ),
      );

  const track = (clientX: number, clientY: number, cat: number, si: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setTip({
      x: clientX - rect.left,
      y: clientY - rect.top,
      boxW: rect.width,
      boxH: rect.height,
    });
    setHover({ cat, si });
  };

  const hoverSeries = hover ? series[hover.si] : undefined;
  const hoverTotal = hover ? totals[hover.cat] ?? 0 : 0;
  const flip = tip.x + 14 + TIP_W > tip.boxW;
  const rawLeft = flip ? tip.x - 14 - TIP_W : tip.x + 14;
  const tipLeft = Math.max(2, Math.min(rawLeft, Math.max(2, tip.boxW - TIP_W - 2)));
  // 88 is a comfortable upper bound on the three-row tooltip's height.
  const tipTop = Math.max(2, Math.min(tip.y - 12, Math.max(2, tip.boxH - 88)));

  const columns = [
    { key: "c", label: xIsDate ? "Period" : "Category", numeric: false },
    ...series.map((s, i) => ({ key: `s${i}`, label: s.name, numeric: true })),
    { key: "total", label: "Total", numeric: true },
  ];
  const rows = categories.map((c, i) => {
    const row: Record<string, string | number> = { c: label(c) };
    series.forEach((s, si) => {
      row[`s${si}`] = formatValue(valueAt(s, i), yFormat);
    });
    row.total = formatValue(totals[i] ?? 0, yFormat);
    return row;
  });

  type TotalLabel = {
    ci: number;
    text: string;
    x: number;
    y: number;
    anchor: "start" | "middle";
  };
  const totalLabels: Array<TotalLabel | null> = showTotals
    ? categories.map((_, ci): TotalLabel | null => {
        const total = totals[ci] ?? 0;
        if (total <= 0) return null;
        const text = formatValue(total, yFormat);
        const width = text.length * CHAR;
        const cap = capAt[ci] ?? 0;
        if (horizontal) {
          if (cap + 6 + width > VW - 2) return null;
          return { ci, text, x: cap + 6, y: bandCentre(ci) + 3.5, anchor: "start" };
        }
        if (width > band - 2 || cap - 6 < 8) return null;
        return { ci, text, x: bandCentre(ci), y: cap - 6, anchor: "middle" };
      })
    : [];

  return (
    <div className="chart">
      <div ref={wrapRef} style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${VW} ${height}`}
          role="img"
          aria-label={ariaLabel}
          style={{ display: "block" }}
        >
          <g className="chart-grid">
            {ticks.map((t) =>
              horizontal ? (
                <line
                  key={`g-${t}`}
                  x1={ml + scaleVal(t)}
                  x2={ml + scaleVal(t)}
                  y1={mt}
                  y2={mt + ph}
                />
              ) : (
                <line
                  key={`g-${t}`}
                  x1={ml}
                  x2={ml + pw}
                  y1={mt + ph - scaleVal(t)}
                  y2={mt + ph - scaleVal(t)}
                />
              ),
            )}
          </g>

          {ticks.map((t) =>
            horizontal ? (
              <text
                key={`vt-${t}`}
                className="chart-tick"
                x={ml + scaleVal(t)}
                y={mt + ph + 16}
                textAnchor="middle"
              >
                {formatTick(t, yFormat)}
              </text>
            ) : (
              <text
                key={`vt-${t}`}
                className="chart-tick"
                x={ml - 8}
                y={mt + ph - scaleVal(t) + 3.5}
                textAnchor="end"
              >
                {formatTick(t, yFormat)}
              </text>
            ),
          )}

          <g className="chart-axis">
            {horizontal ? (
              <line x1={ml} x2={ml} y1={mt} y2={mt + ph} />
            ) : (
              <line x1={ml} x2={ml + pw} y1={mt + ph} y2={mt + ph} />
            )}
          </g>

          {labels.map((l, ci) =>
            horizontal ? (
              <text
                key={`cl-${ci}`}
                className="chart-label"
                x={ml - 8}
                y={bandCentre(ci) + 3.5}
                textAnchor="end"
              >
                {truncate(l, Math.max(2, Math.floor((ml - 12) / CHAR)))}
              </text>
            ) : ci % catStride === 0 ? (
              <text
                key={`cl-${ci}`}
                className="chart-tick"
                x={bandCentre(ci)}
                y={mt + ph + 16}
                textAnchor="middle"
              >
                {l}
              </text>
            ) : null,
          )}

          {segs.map((sg) => {
            const s = series[sg.si];
            if (!s) return null;
            const active = hover != null && hover.cat === sg.cat && hover.si === sg.si;
            return sg.outer ? (
              <path
                key={`sg-${sg.cat}-${sg.si}`}
                d={capPath(sg.x, sg.y, sg.w, sg.h, 4, horizontal ? "right" : "top")}
                fill={hue(s.slot)}
                fillOpacity={hover == null || active ? 1 : 0.55}
              />
            ) : (
              <rect
                key={`sg-${sg.cat}-${sg.si}`}
                x={sg.x}
                y={sg.y}
                width={sg.w}
                height={sg.h}
                fill={hue(s.slot)}
                fillOpacity={hover == null || active ? 1 : 0.55}
              />
            );
          })}

          {totalLabels.map((t) =>
            t ? (
              <text
                key={`tl-${t.ci}`}
                className="chart-value"
                x={t.x}
                y={t.y}
                textAnchor={t.anchor}
              >
                {t.text}
              </text>
            ) : null,
          )}

          {/* Hit targets span the whole band so a thin segment is still easy to hit. */}
          {segs.map((sg) => (
            <rect
              key={`hit-${sg.cat}-${sg.si}`}
              className="chart-hover-target"
              x={horizontal ? sg.x : bandCentre(sg.cat) - band / 2}
              y={horizontal ? bandCentre(sg.cat) - band / 2 : sg.y}
              width={horizontal ? sg.w : band}
              height={horizontal ? band : sg.h}
              onMouseMove={(e) => track(e.clientX, e.clientY, sg.cat, sg.si)}
              onMouseEnter={(e) => track(e.clientX, e.clientY, sg.cat, sg.si)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>

        {hover && hoverSeries ? (
          <div className="tooltip" style={{ left: tipLeft, top: tipTop, width: TIP_W }} role="status">
            <div className="tooltip-title">{labels[hover.cat] ?? ""}</div>
            <div className="tooltip-row">
              <span className="legend-swatch" style={{ background: hue(hoverSeries.slot) }} />
              <span className="tooltip-name">{hoverSeries.name}</span>
              <span className="tooltip-num">
                {formatValue(valueAt(hoverSeries, hover.cat), yFormat)}
              </span>
            </div>
            <div className="tooltip-foot">
              Stack total {formatValue(hoverTotal, yFormat)}
            </div>
          </div>
        ) : null}
      </div>

      {series.length >= 2 ? (
        <div className="chart-legend">
          {series.map((s) => (
            <span className="legend-item" key={`lg-${s.name}`}>
              <span className="legend-swatch" style={{ background: hue(s.slot) }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}

      <TableView columns={columns} rows={rows} caption={ariaLabel} />
    </div>
  );
}
