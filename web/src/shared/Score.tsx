/** A 0-100 score with a thin bar: the one way scores are drawn across the app. */
type Tone = "accent" | "good" | "warn" | "neutral";

const FILL: Record<Tone, string> = {
  accent: "bg-aq-accent",
  good: "bg-aq-good",
  warn: "bg-aq-warn",
  neutral: "bg-aq-ink-muted",
};

export function ScoreBar({
  value,
  tone = "accent",
  size = "md",
}: {
  value: number | null;
  tone?: Tone;
  size?: "sm" | "md";
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span className={`flex items-center gap-2.5 ${size === "sm" ? "w-32" : "w-44"}`}>
      <span
        className={`text-aq-ink shrink-0 text-right font-mono font-medium ${size === "sm" ? "text-aq-sm w-10" : "text-aq-md w-12"}`}
      >
        {value === null ? "—" : value.toFixed(1)}
      </span>
      <span className="bg-aq-zebra h-1.5 flex-1 overflow-hidden rounded-full" aria-hidden="true">
        {/* Width is data, not a style token: the bar length is the score. */}
        <span className={`block h-full rounded-full ${FILL[tone]}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/** Track label shown as a small chip-like tag next to a team. */
export const trackLabel = (track: string | null): string =>
  track === "elevenlabs" ? "ElevenLabs" : track ? track[0].toUpperCase() + track.slice(1) : "No track";
