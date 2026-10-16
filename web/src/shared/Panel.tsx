import type { IconProps } from "@shared/icons";
import { SectionHeader } from "@shared/ui";
import type { ComponentType, ReactNode } from "react";

type Tone = "accent" | "good" | "warn" | "bad" | "info" | "neutral";

/** A card region: surface + hairline + resting shadow, optionally headed by a SectionHeader. */
export function Panel({
  title,
  icon,
  tone = "neutral",
  count,
  action,
  onAction,
  children,
  className = "",
  flush = false,
}: {
  title?: string;
  icon?: ComponentType<IconProps>;
  tone?: Tone;
  count?: number;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
  className?: string;
  /** Children render edge to edge (lists that draw their own row dividers). */
  flush?: boolean;
}) {
  return (
    <section className={`bg-aq-surface border-aq-border shadow-aq-card rounded-lg border ${className}`}>
      {title && (
        <div className="border-aq-border border-b px-4.5 py-3">
          <SectionHeader
            icon={icon}
            tone={tone}
            title={title}
            count={count}
            action={action}
            onAction={onAction}
          />
        </div>
      )}
      <div className={flush ? "" : "p-4.5"}>{children}</div>
    </section>
  );
}
