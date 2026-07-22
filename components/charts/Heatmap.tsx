"use client";

import { useState } from "react";
import { formatValue, type ValueFormat } from "./valueFormat";
import { TableView } from "./TableView";

export interface HeatmapProps {
  rows: Array<{ key: string; label: string; sub?: string }>;
  columns: Array<{ key: string; label: string }>;
  values: Array<{ row: string; col: string; value: number }>;
  valueFormat?: ValueFormat;
  ariaLabel: string;
  scaleLabel?: string;
  cellSize?: number;
}

/**
 * Row labels live in a reserved gutter and are measured before they are drawn.
 * There is no text-measurement API available server-side and this component has
 * to emit the same markup on both sides of hydration, so width is estimated per
 * character. 0.55em over-estimates mixed-case prose in this UI sans, which is
 * the safe direction to be wrong in: a label loses one more character rather
 * than spilling outside the viewBox, where `.chart svg { overflow: visible }`
 * would let the card clip it mid-glyph.
 */
const LABEL_FONT = 11; // .chart-label
const SUB_FONT = 10; // floor for legible secondary type — never smaller
const TICK_FONT = 10.5; // .chart-tick
const CHAR_EM = 0.55;
/** Ticks are tabular dates — caps and figures run wider than prose does. */
const TICK_CHAR_EM = 0.66;
const LABEL_GAP = 9; // gutter edge → first cell
const GUTTER_MIN = 112;
const GUTTER_MAX = 200;

const estWidth = (chars: number, font: number): number => chars * font * CHAR_EM;

/** Characters that fit in `px`, never fewer than the two an ellipsis needs. */
const fitChars = (px: number, font: number): number =>
  Math.max(2, Math.floor(px / (font * CHAR_EM)));

/** Truncate the string itself: an ellipsis is honest, a clipped glyph is not. */
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** One hue, light → dark. A heatmap that mixes hues stops being readable. */
const RAMP = [
  "--seq-100",
  "--seq-200",
  "--seq-300",
  "--seq-400",
  "--seq-500",
  "--seq-600",
  "--seq-700",
];

export function Heatmap(props: HeatmapProps) {
  const {
    rows,
    columns,
    values,
    valueFormat = "usd",
    ariaLabel,
    scaleLabel,
    cellSize = 26,
  } = props;

  const [hot, setHot] = useState<{ r: number; c: number } | null>(null);

  if (rows.length === 0 || columns.length === 0) {
    return <div className="empty">No usage to map for this period.</div>;
  }

  const cells = new Map<string, number>();
  for (const v of values) {
    if (!Number.isFinite(v.value)) continue;
    const k = `${v.row}\u0000${v.col}`;
    cells.set(k, (cells.get(k) ?? 0) + v.value);
  }
  const at = (rowKey: string, colKey: string) => cells.get(`${rowKey}\u0000${colKey}`) ?? 0;

  let max = 0;
  let minPositive = Number.POSITIVE_INFINITY;
  const rowTotals: number[] = [];
  for (const r of rows) {
    let t = 0;
    for (const c of columns) {
      const v = at(r.key, c.key);
      t += v;
      if (v > max) max = v;
      if (v > 0 && v < minPositive) minPositive = v;
    }
    rowTotals.push(t);
  }
  const colTotals = columns.map((c) => rows.reduce((a, r) => a + at(r.key, c.key), 0));
  const grand = rowTotals.reduce((a, b) => a + b, 0);
  const lowBound = Number.isFinite(minPositive) ? minPositive : 0;

  function fillFor(v: number): string {
    // "No usage" must not read as "a little usage", so zero leaves the ramp.
    if (v <= 0 || max <= 0) return "var(--surface-sunken)";
    const step = Math.min(RAMP.length - 1, Math.max(0, Math.ceil((v / max) * RAMP.length) - 1));
    return `var(${RAMP[step] ?? "--seq-100"})`;
  }

  // The gutter is sized to the widest of both label lines, then capped: past the
  // cap the text is cut to fit rather than the grid pushed off the card.
  const widestLabel = rows.reduce(
    (n, r) =>
      Math.max(n, estWidth(r.label.length, LABEL_FONT), estWidth((r.sub ?? "").length, SUB_FONT)),
    0,
  );
  const labelW = Math.round(
    Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, widestLabel + LABEL_GAP + 4)),
  );
  // Labels are right-anchored at `labelW - LABEL_GAP`, so this is the run of
  // pixels between x=0 and the anchor that the text has to live in.
  const textBudget = labelW - LABEL_GAP;
  const maxLabelChars = fitChars(textBudget, LABEL_FONT);
  const maxSubChars = fitChars(textBudget, SUB_FONT);

  const longestColLabel = columns.reduce((n, c) => Math.max(n, c.label.length), 0);
  // Column labels are dropped rather than clipped or overlapped.
  const colStep = Math.max(1, Math.ceil((longestColLabel * 6.2 + 8) / cellSize));
  const headH = 20;
  const gridW = columns.length * cellSize;
  // The last column's centred tick overhangs its cell, so the viewBox carries
  // that overhang instead of letting the tick fall outside it.
  const rightPad = Math.ceil(
    Math.max(0, (longestColLabel * TICK_FONT * TICK_CHAR_EM) / 2 - cellSize / 2),
  );
  const width = labelW + gridW + rightPad;
  const height = headH + rows.length * cellSize;

  const hotRow = hot ? rows[hot.r] : undefined;
  const hotCol = hot ? columns[hot.c] : undefined;
  const hotX = hot ? labelW + hot.c * cellSize + cellSize / 2 : 0;
  const hotY = hot ? headH + hot.r * cellSize : 0;

  return (
    <div className="chart">
      <div style={{ position: "relative", overflowX: "auto" }}>
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${width} ${height}`}
          style={{ width, height, display: "block" }}
          onMouseLeave={() => setHot(null)}
        >
          {columns.map((c, ci) =>
            ci % colStep === 0 ? (
              <text
                key={`col-${c.key}`}
                className="chart-tick"
                x={labelW + ci * cellSize + cellSize / 2}
                y={headH - 7}
                textAnchor="middle"
              >
                {c.label}
              </text>
            ) : null,
          )}

          {rows.map((r, ri) => {
            const cy = headH + ri * cellSize + cellSize / 2;
            return (
              <g key={`row-${r.key}`}>
                <text
                  className="chart-label"
                  x={labelW - LABEL_GAP}
                  y={r.sub ? cy - 3 : cy + 3.5}
                  textAnchor="end"
                >
                  {/* The untruncated string stays reachable on hover, and in the
                      TableView below, so nothing is lost to the gutter. */}
                  <title>{r.label}</title>
                  {truncate(r.label, maxLabelChars)}
                </text>
                {r.sub ? (
                  <text
                    x={labelW - LABEL_GAP}
                    y={cy + 8}
                    textAnchor="end"
                    fill="var(--ink-3)"
                    fontSize={SUB_FONT}
                  >
                    <title>{r.sub}</title>
                    {truncate(r.sub, maxSubChars)}
                  </text>
                ) : null}
                {columns.map((c, ci) => {
                  const v = at(r.key, c.key);
                  const isHot = hot?.r === ri && hot?.c === ci;
                  return (
                    <rect
                      key={`${r.key}-${c.key}`}
                      className="heat-cell"
                      x={labelW + ci * cellSize}
                      y={headH + ri * cellSize}
                      width={cellSize}
                      height={cellSize}
                      rx={2}
                      fill={fillFor(v)}
                      opacity={hot === null || isHot ? 1 : 0.68}
                      onMouseEnter={() => setHot({ r: ri, c: ci })}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>

        {hotRow && hotCol ? (
          <div
            className="tooltip"
            style={{
              left: Math.min(Math.max(hotX, 80), Math.max(width - 80, 80)),
              top: Math.max(hotY - 6, 0),
              transform: "translate(-50%, -100%)",
            }}
          >
            <div className="tooltip-title">{hotRow.label}</div>
            <div className="tooltip-row">
              <span className="tooltip-name">{hotCol.label}</span>
              <span className="tooltip-num">
                {formatValue(at(hotRow.key, hotCol.key), valueFormat)}
              </span>
            </div>
            <div className="tooltip-foot">
              Row total {formatValue(rowTotals[hot?.r ?? 0] ?? 0, valueFormat)} · column total{" "}
              {formatValue(colTotals[hot?.c ?? 0] ?? 0, valueFormat)}
            </div>
          </div>
        ) : null}
      </div>

      <div className="heat-scale" style={{ marginTop: 10, flexWrap: "wrap" }}>
        {scaleLabel ? <span>{scaleLabel}</span> : null}
        <span className="tnum">{formatValue(lowBound, valueFormat)}</span>
        <span className="heat-scale-swatches">
          {RAMP.map((step) => (
            <i key={step} style={{ background: `var(${step})` }} />
          ))}
        </span>
        <span className="tnum">{formatValue(max, valueFormat)}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 6 }}>
          <i
            style={{
              width: 14,
              height: 9,
              borderRadius: 2,
              display: "block",
              background: "var(--surface-sunken)",
            }}
          />
          no usage
        </span>
      </div>

      <TableView
        columns={[
          { key: "__row", label: "Row" },
          ...columns.map((c) => ({ key: `c_${c.key}`, label: c.label, numeric: true })),
          { key: "__total", label: "Total", numeric: true },
        ]}
        rows={rows.map((r, ri) => {
          const rec: Record<string, string | number> = {
            __row: r.sub ? `${r.label} — ${r.sub}` : r.label,
          };
          for (const c of columns) {
            rec[`c_${c.key}`] = formatValue(at(r.key, c.key), valueFormat);
          }
          rec.__total = formatValue(rowTotals[ri] ?? 0, valueFormat);
          return rec;
        })}
        caption={`${ariaLabel} — ${formatValue(grand, valueFormat)} in total`}
      />
    </div>
  );
}
