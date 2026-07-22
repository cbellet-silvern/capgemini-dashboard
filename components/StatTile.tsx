import Link from "next/link";
import type { ReactElement } from "react";
import { Sparkline } from "@/components/charts/Sparkline";
import { pctSigned } from "@/lib/format";

export interface StatTileProps {
  label: string;
  value: string;
  delta?: { pct: number | null; label: string; goodWhenUp?: boolean } | null;
  foot?: string;
  spark?: number[];
  sparkSlot?: number;
  href?: string;
}

function deltaClass(pctValue: number | null, goodWhenUp: boolean): string {
  if (pctValue == null || !Number.isFinite(pctValue) || pctValue === 0) {
    return "stat-delta";
  }
  const good = pctValue > 0 ? goodWhenUp : !goodWhenUp;
  return good ? "stat-delta is-good" : "stat-delta is-bad";
}

export function StatTile(props: StatTileProps): ReactElement {
  const { label, value, delta, foot, spark, sparkSlot, href } = props;
  const hasSpark = spark !== undefined && spark.length > 1;

  const card = (
    <div className="card">
      <div className="stat">
        <div className="stat-label">{label}</div>
        <div className="stat-row">
          <div className="stat-value">{value}</div>
          {delta ? (
            <div className={deltaClass(delta.pct, delta.goodWhenUp !== false)}>
              {pctSigned(delta.pct)} {delta.label}
            </div>
          ) : null}
        </div>
        {foot ? <div className="stat-foot">{foot}</div> : null}
        {hasSpark ? (
          // Sparkline carries `.stat-spark` itself; a wrapper would double its margin.
          <Sparkline values={spark} slot={sparkSlot ?? 1} ariaLabel={`${label} trend`} />
        ) : null}
      </div>
    </div>
  );

  if (!href) return card;
  return (
    <Link href={href} style={{ color: "inherit", textDecoration: "none" }}>
      {card}
    </Link>
  );
}
