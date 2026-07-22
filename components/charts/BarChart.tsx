"use client";

import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { formatValue, type ValueFormat } from "./valueFormat";
import { TableView } from "./TableView";
import { pct } from "@/lib/format";

export interface BarChartRow {
  label: string;
  value: number;
  slot?: number;
  sub?: string;
  href?: string;
}

export interface BarChartProps {
  rows: BarChartRow[];
  valueFormat?: ValueFormat;
  height?: number;
  ariaLabel: string;
}

interface Hover {
  i: number;
  x: number;
  y: number;
}

function seriesVar(slot: number | undefined): string {
  const n = Math.min(8, Math.max(1, Math.round(slot ?? 1)));
  return `var(--series-${n})`;
}

export function BarChart(props: BarChartProps) {
  const { rows, valueFormat = "usd", height, ariaLabel } = props;
  const [hover, setHover] = useState<Hover | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  if (rows.length === 0) {
    return <div className="empty">Nothing to rank for this period.</div>;
  }

  let max = 0;
  let total = 0;
  for (const r of rows) {
    const v = Number.isFinite(r.value) ? r.value : 0;
    if (v > max) max = v;
    total += v;
  }

  const hasSub = rows.some((r) => typeof r.sub === "string" && r.sub.length > 0);
  const rowH = height
    ? Math.max(hasSub ? 40 : 30, height / rows.length)
    : hasSub ? 44 : 32;
  // Thickness is capped so a short list doesn't turn into slabs; the rest of the
  // row height becomes air between bars.
  const barH = Math.min(24, Math.max(10, Math.round(rowH * 0.48)));

  function track(e: ReactMouseEvent<HTMLDivElement>, i: number) {
    const host = hostRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - box.left, 76), Math.max(box.width - 76, 76));
    setHover({ i, x, y: e.clientY - box.top });
  }

  const hoveredRow = hover ? rows[hover.i] : undefined;

  return (
    <div className="chart" ref={hostRef}>
      <div role="img" aria-label={ariaLabel}>
        {rows.map((row, i) => {
          const v = Number.isFinite(row.value) ? row.value : 0;
          const frac = max > 0 ? Math.max(0, v) / max : 0;
          const isHot = hover?.i === i;
          return (
            <div
              key={`${row.label}-${i}`}
              onMouseMove={(e) => track(e, i)}
              onMouseLeave={() => setHover(null)}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(88px, 30%) 1fr auto",
                alignItems: "center",
                columnGap: 12,
                minHeight: rowH,
                padding: "2px 6px",
                borderRadius: 4,
                background: isHot ? "var(--surface-3)" : "transparent",
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 550, color: "var(--ink-2)", lineHeight: 1.3 }}>
                {row.href ? <a href={row.href}>{row.label}</a> : row.label}
                {row.sub ? <span className="cell-sub">{row.sub}</span> : null}
              </div>

              <div
                style={{
                  position: "relative",
                  height: barH,
                  background: "var(--surface-sunken)",
                  borderRadius: 2,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${(frac * 100).toFixed(3)}%`,
                    minWidth: v > 0 ? 2 : 0,
                    background: seriesVar(row.slot),
                    borderRadius: "0 4px 4px 0",
                  }}
                />
              </div>

              <div
                className="chart-value tnum"
                style={{ color: "var(--ink-1)", textAlign: "right", minWidth: 62 }}
              >
                {formatValue(v, valueFormat)}
              </div>
            </div>
          );
        })}
      </div>

      {hover && hoveredRow ? (
        <div
          className="tooltip"
          style={{
            left: hover.x,
            top: Math.max(hover.y - 10, 0),
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="tooltip-title">{hoveredRow.label}</div>
          <div className="tooltip-row">
            <span className="tooltip-name">Value</span>
            <span className="tooltip-num">
              {formatValue(Number.isFinite(hoveredRow.value) ? hoveredRow.value : 0, valueFormat)}
            </span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-name">Share of total</span>
            <span className="tooltip-num">
              {pct(total > 0 ? hoveredRow.value / total : null, 1)}
            </span>
          </div>
          {hoveredRow.sub ? <div className="tooltip-foot">{hoveredRow.sub}</div> : null}
        </div>
      ) : null}

      <TableView
        columns={[
          { key: "label", label: "Item" },
          { key: "value", label: "Value", numeric: true },
          { key: "share", label: "Share", numeric: true },
        ]}
        rows={rows.map((r) => ({
          label: r.sub ? `${r.label} — ${r.sub}` : r.label,
          value: formatValue(Number.isFinite(r.value) ? r.value : 0, valueFormat),
          share: pct(total > 0 ? r.value / total : null, 1),
        }))}
        caption={ariaLabel}
      />
    </div>
  );
}
