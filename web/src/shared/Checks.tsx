/** The submission requirements checklist (SDK, video, live demo, social post, Pro, partner SDK). */
import { IconAlert, IconCheckCircle, IconClock, IconErrorCircle, type IconProps } from "@shared/icons";
import type { ComponentType } from "react";

export interface Check {
  id: string;
  label: string;
  state: "pass" | "fail" | "warn" | "pending";
  detail: string;
}

const LOOK: Record<Check["state"], { icon: ComponentType<IconProps>; ink: string; label: string }> = {
  pass: { icon: IconCheckCircle, ink: "text-aq-good", label: "Met" },
  warn: { icon: IconAlert, ink: "text-aq-warn", label: "Check" },
  fail: { icon: IconErrorCircle, ink: "text-aq-bad", label: "Missing" },
  pending: { icon: IconClock, ink: "text-aq-ink-faint", label: "Pending" },
};

/** Full list, one requirement per row: icon, label, and what was found. */
export function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="divide-aq-border flex flex-col divide-y" data-testid="checklist">
      {checks.map((c) => {
        const look = LOOK[c.state];
        const Icon = look.icon;
        return (
          <li key={c.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <span className={`mt-0.5 shrink-0 ${look.ink}`}>
              <Icon size={16} />
              <span className="sr-only">{look.label}: </span>
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-aq-sm text-aq-ink font-medium">{c.label}</span>
              <span className="text-aq-xs text-aq-ink-muted break-words">{c.detail}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Compact row of dots for lists: one per requirement, coloured by state, with the label as a tooltip. */
export function CheckDots({ checks }: { checks: Check[] }) {
  return (
    <span className="flex items-center gap-1">
      {checks.map((c) => {
        const look = LOOK[c.state];
        const Icon = look.icon;
        return (
          <span key={c.id} className={look.ink} title={`${c.label}: ${c.detail}`}>
            <Icon size={14} />
            <span className="sr-only">
              {c.label}: {look.label}.{" "}
            </span>
          </span>
        );
      })}
    </span>
  );
}
