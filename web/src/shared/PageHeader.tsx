import type { ReactNode } from "react";

/** Page title block: heading, supporting line, trailing actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5.5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-aq-h2 tracking-aq-tight text-aq-ink flex flex-wrap items-center gap-2.5 font-semibold">
          {title}
        </h1>
        {subtitle && <p className="text-aq-sm text-aq-ink-muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
