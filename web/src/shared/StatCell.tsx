import { AnimatedNumber } from "@shared/ui";
import type { ReactNode } from "react";

/** One labelled KPI cell: uppercase micro-label over a mono readout. */
export function StatCell({
  label,
  value,
  format,
  hint,
}: {
  label: string;
  value: number | null;
  format?: (n: number) => string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-aq-caption tracking-aq-widest text-aq-ink-muted font-medium uppercase">
        {label}
      </span>
      <span className="text-aq-stat tracking-aq-tight text-aq-ink font-mono font-medium">
        {value === null ? "—" : <AnimatedNumber value={value} format={format} />}
      </span>
      {hint && <span className="text-aq-xs text-aq-ink-muted">{hint}</span>}
    </div>
  );
}

/** A row of stat cells divided by hairlines. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-5.5 sm:grid-cols-3 lg:grid-cols-6">{children}</div>;
}
