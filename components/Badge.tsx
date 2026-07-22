import type { ReactElement, ReactNode } from "react";
import { AI_POLICY_LABEL, type AiPolicy, type RiskLevel } from "@/lib/types";

export type BadgeTone = "neutral" | "ok" | "watch" | "over" | "info";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "badge",
  ok: "badge is-ok",
  watch: "badge is-watch",
  over: "badge is-over",
  info: "badge is-info",
};

export function Badge(p: {
  children: ReactNode;
  tone?: BadgeTone;
  glyph?: string;
}): ReactElement {
  return (
    <span className={TONE_CLASS[p.tone ?? "neutral"]}>
      {p.glyph ? (
        <span className="badge-glyph" aria-hidden="true">
          {p.glyph}
        </span>
      ) : null}
      {p.children}
    </span>
  );
}

const RISK_LABEL: Record<RiskLevel, string> = {
  ok: "On budget",
  watch: "▲ Watch",
  over: "● Over",
};

/** Colour alone never carries the status — the word is always present. */
export function RiskBadge(p: { risk: RiskLevel; title?: string }): ReactElement {
  return (
    <span className={TONE_CLASS[p.risk]} title={p.title}>
      {RISK_LABEL[p.risk]}
    </span>
  );
}

const POLICY_TONE: Record<AiPolicy, BadgeTone> = {
  markup: "info",
  at_cost: "neutral",
  absorbed: "watch",
};

export function PolicyBadge(p: {
  policy: AiPolicy;
  markupPct: number;
}): ReactElement {
  const label =
    p.policy === "markup"
      ? `${AI_POLICY_LABEL.markup} · ${Math.round(p.markupPct * 100)}%`
      : AI_POLICY_LABEL[p.policy];
  return <span className={TONE_CLASS[POLICY_TONE[p.policy]]}>{label}</span>;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  active: "ok",
  issued: "ok",
  approved: "ok",
  paid: "ok",
  delivered: "ok",
  draft: "neutral",
  submitted: "neutral",
  pending: "neutral",
  invoiced: "neutral",
  on_hold: "neutral",
  closing: "neutral",
  complete: "neutral",
  closed: "neutral",
};

function titleCase(status: string): string {
  return status
    .split("_")
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function StatusBadge(p: { status: string }): ReactElement {
  return (
    <span className={TONE_CLASS[STATUS_TONE[p.status] ?? "neutral"]}>
      {titleCase(p.status)}
    </span>
  );
}
