/** Signed-out split layout (after ArmorIQ's AuthSplitLayout): form column + dark brand panel (lg and up). */
import type { ReactNode } from "react";
import { Brand } from "./Brand";

const STEPS = [
  ["Gate", "Clone, scan, and confirm the ArmorIQ SDK is installed and called. Never runs team code."],
  ["Score", "Deck and video analysts score each criterion against your rubric."],
  ["Calibrate", "Jev re-reads the raw evidence. Below 0.85 confidence, a judge decides."],
] as const;

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-aq-bg flex min-h-full">
      <div className="flex flex-1 flex-col px-6 py-6">
        <Brand />
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
      <aside className="bg-aq-ink-panel hidden w-140 shrink-0 flex-col justify-between p-10 lg:flex">
        <Brand onDark />
        <ol className="flex flex-col gap-6.5">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="border-aq-ink-on-line flex gap-4 border-l pl-4.5">
              <span className="text-aq-ink-on-muted text-aq-sm font-mono">0{i + 1}</span>
              <span className="flex flex-col gap-1">
                <span className="text-aq-ink-on text-aq-md font-semibold">{title}</span>
                <span className="text-aq-ink-on-soft text-aq-sm">{body}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-aq-ink-on-muted text-aq-xs">ArmorIQ hackathon judging</p>
      </aside>
    </div>
  );
}
