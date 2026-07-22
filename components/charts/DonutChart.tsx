"use client";

import { useState } from "react";
import { formatValue, type ValueFormat } from "./valueFormat";
import { TableView } from "./TableView";
import { pct } from "@/lib/format";

export interface DonutSlice {
  name: string;
  value: number;
  slot: number;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  size?: number;
  centerLabel?: string;
  centerValue?: string;
  valueFormat?: ValueFormat;
  ariaLabel: string;
}

function seriesVar(slot: number): string {
  const n = Math.min(8, Math.max(1, Math.round(slot)));
  return `var(--series-${n})`;
}

export function DonutChart(props: DonutChartProps) {
  const {
    slices,
    size = 168,
    centerLabel,
    centerValue,
    valueFormat = "usd",
    ariaLabel,
  } = props;

  const [hot, setHot] = useState<number | null>(null);

  // A zero or negative slice has no arc to draw and no share to quote.
  const parts = slices.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = parts.reduce((a, s) => a + s.value, 0);

  if (parts.length === 0 || total <= 0) {
    return <div className="empty">No spend to break down for this period.</div>;
  }

  const thickness = Math.max(14, Math.round(size * 0.17));
  const r = size / 2 - thickness / 2 - 2;
  const circ = 2 * Math.PI * r;
  const gap = parts.length > 1 ? 2 : 0;
  const minHit = Math.min(circ, 16);

  const arcs = parts.map((s, i) => {
    const frac = s.value / total;
    const len = frac * circ;
    return {
      i,
      slice: s,
      frac,
      len,
      offset: 0,
      visible: Math.max(0.6, len - gap),
      hit: Math.max(len, minHit),
    };
  });
  let acc = 0;
  for (const a of arcs) {
    a.offset = acc;
    acc += a.len;
  }

  // Smallest arcs get their hit band painted last so a 1% sliver stays clickable
  // where a fat neighbour's oversized band overlaps it.
  const hitOrder = arcs.slice().sort((a, b) => b.len - a.len);

  const centre = size / 2;
  const hotArc = hot === null ? undefined : arcs[hot];
  // Anchor the tooltip on the hovered arc's midpoint, in the donut's own box.
  const hotAngle = hotArc ? ((hotArc.offset + hotArc.len / 2) / circ) * 2 * Math.PI - Math.PI / 2 : 0;
  const hotX = centre + r * Math.cos(hotAngle);
  const hotY = centre + r * Math.sin(hotAngle);

  return (
    <div className="chart">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div style={{ position: "relative", width: size, height: size, flex: "0 0 auto" }}>
          <svg
            role="img"
            aria-label={ariaLabel}
            viewBox={`0 0 ${size} ${size}`}
            style={{ width: size, height: size, display: "block" }}
            onMouseLeave={() => setHot(null)}
          >
            <g transform={`rotate(-90 ${centre} ${centre})`}>
              {arcs.map((a) => (
                <circle
                  key={`arc-${a.i}`}
                  cx={centre}
                  cy={centre}
                  r={r}
                  fill="none"
                  stroke={seriesVar(a.slice.slot)}
                  strokeWidth={hot === a.i ? thickness + 5 : thickness}
                  strokeDasharray={`${a.visible} ${Math.max(circ - a.visible, 0)}`}
                  strokeDashoffset={-a.offset}
                  opacity={hot === null || hot === a.i ? 1 : 0.45}
                  pointerEvents="none"
                />
              ))}
              {hitOrder.map((a) => (
                <circle
                  key={`hit-${a.i}`}
                  cx={centre}
                  cy={centre}
                  r={r}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={thickness + 12}
                  strokeDasharray={`${a.hit} ${Math.max(circ - a.hit, 0)}`}
                  strokeDashoffset={-a.offset}
                  pointerEvents="stroke"
                  onMouseEnter={() => setHot(a.i)}
                />
              ))}
            </g>
          </svg>

          {centerValue || centerLabel ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                pointerEvents: "none",
                textAlign: "center",
              }}
            >
              {centerValue ? (
                <div
                  className="tnum"
                  style={{
                    fontSize: Math.max(15, Math.round(size * 0.13)),
                    fontWeight: 600,
                    color: "var(--ink-1)",
                    lineHeight: 1.1,
                  }}
                >
                  {centerValue}
                </div>
              ) : null}
              {centerLabel ? <div className="micro">{centerLabel}</div> : null}
            </div>
          ) : null}

          {hotArc ? (
            <div
              className="tooltip"
              style={{
                left: hotX,
                top: Math.max(hotY - 8, 0),
                transform: "translate(-50%, -100%)",
              }}
            >
              <div className="tooltip-title">{hotArc.slice.name}</div>
              <div className="tooltip-row">
                <span className="tooltip-name">Value</span>
                <span className="tooltip-num">{formatValue(hotArc.slice.value, valueFormat)}</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-name">Share</span>
                <span className="tooltip-num">{pct(hotArc.frac, 1)}</span>
              </div>
              <div className="tooltip-foot">of {formatValue(total, valueFormat)} total</div>
            </div>
          ) : null}
        </div>

        <ul
          className="chart-legend"
          style={{ flexDirection: "column", listStyle: "none", margin: 0, padding: 0, flex: "1 1 180px" }}
        >
          {arcs.map((a) => (
            <li
              key={`legend-${a.i}`}
              className="legend-item"
              style={{
                width: "100%",
                opacity: hot === null || hot === a.i ? 1 : 0.55,
                cursor: "default",
              }}
              onMouseEnter={() => setHot(a.i)}
              onMouseLeave={() => setHot(null)}
            >
              <span className="legend-swatch" style={{ background: seriesVar(a.slice.slot) }} />
              <span>{a.slice.name}</span>
              <span className="legend-num" style={{ marginLeft: "auto" }}>
                {formatValue(a.slice.value, valueFormat)}
              </span>
              <span className="legend-num muted" style={{ width: 44, textAlign: "right" }}>
                {pct(a.frac, 0)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <TableView
        columns={[
          { key: "name", label: "Segment" },
          { key: "value", label: "Value", numeric: true },
          { key: "share", label: "Share", numeric: true },
        ]}
        rows={arcs.map((a) => ({
          name: a.slice.name,
          value: formatValue(a.slice.value, valueFormat),
          share: pct(a.frac, 1),
        }))}
        caption={ariaLabel}
      />
    </div>
  );
}
