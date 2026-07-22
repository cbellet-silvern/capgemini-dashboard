import type { ReactElement } from "react";
import { pct } from "@/lib/format";
import type { RiskLevel } from "@/lib/types";

export interface MeterProps {
  pct: number | null;
  markPct?: number;
  risk?: RiskLevel;
  showNum?: boolean;
}

const FILL_CLASS: Record<RiskLevel, string> = {
  ok: "meter-fill",
  watch: "meter-fill is-watch",
  over: "meter-fill is-over",
};

export function Meter(props: MeterProps): ReactElement {
  const value = props.pct;
  const usable = value != null && Number.isFinite(value) && value > 0;
  // The bar caps at 100% so it cannot overflow the track; the number keeps the truth.
  const width = usable ? Math.min(value, 1) * 100 : 0;
  const mark = props.markPct;
  const markLeft =
    mark != null && Number.isFinite(mark)
      ? Math.min(Math.max(mark, 0), 1) * 100
      : null;

  return (
    <div className="meter-row">
      <div className="meter">
        {usable ? (
          <div
            className={FILL_CLASS[props.risk ?? "ok"]}
            style={{ width: `${width}%` }}
          />
        ) : null}
        {markLeft !== null ? (
          <div className="meter-mark" style={{ left: `${markLeft}%` }} />
        ) : null}
      </div>
      {props.showNum === false ? null : (
        <div className="meter-num">{pct(value)}</div>
      )}
    </div>
  );
}
