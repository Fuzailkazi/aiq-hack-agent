/** One mapping from pipeline status to the system's status grammar (tone + icon + label). */
import {
  IconAlert,
  IconCheckCircle,
  IconClock,
  IconErrorCircle,
  IconEye,
  IconHistory,
  type IconProps,
  IconRefresh,
  IconShield,
} from "@shared/icons";
import { StatusBadge } from "@shared/ui";
import type { ComponentType } from "react";
import type { Status } from "../api/client";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export const STATUS: Record<Status, { label: string; tone: Tone; icon: ComponentType<IconProps> }> = {
  queued: { label: "Queued", tone: "neutral", icon: IconClock },
  needs_attention: { label: "Needs attention", tone: "warn", icon: IconAlert },
  disqualified: { label: "Disqualified", tone: "bad", icon: IconErrorCircle },
  gate_review: { label: "Gate review", tone: "warn", icon: IconShield },
  scoring: { label: "Scoring", tone: "info", icon: IconRefresh },
  needs_review: { label: "Needs review", tone: "warn", icon: IconEye },
  finalized: { label: "Finalized", tone: "good", icon: IconCheckCircle },
  stale: { label: "Stale", tone: "info", icon: IconHistory },
  superseded: { label: "Superseded", tone: "neutral", icon: IconHistory },
  error: { label: "Error", tone: "bad", icon: IconErrorCircle },
};

export function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return <StatusBadge tone={s.tone} label={s.label} icon={s.icon} shimmer={status === "scoring"} />;
}

export const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`;
export const score = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toFixed(2));
