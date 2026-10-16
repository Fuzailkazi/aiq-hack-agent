/** Jev's probability per rubric level as small bars; the LLM's chosen level is ringed. */
export function JevBar({ probs, llmLevel, labels }: { probs: number[]; llmLevel: number; labels: string[] }) {
  return (
    <div
      className="flex h-8 items-end gap-0.5"
      role="img"
      aria-label={`Jev distribution, LLM chose ${labels[llmLevel] ?? llmLevel}`}
    >
      {labels.map((label, i) => {
        const p = probs[i] ?? 0;
        return (
          <span
            key={label}
            title={`${label}: ${Math.round(p * 100)}%`}
            className={`flex-1 rounded-t-aq-xs ${i === llmLevel ? "bg-aq-info ring-aq-ink ring-1 ring-offset-1" : "bg-aq-info/40"}`}
            // Bar height is data, not styling.
            style={{ height: `${Math.max(6, p * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
