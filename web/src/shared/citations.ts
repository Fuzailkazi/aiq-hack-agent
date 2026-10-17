/** Citations are free text from the LLM ("slide 4", "02:13-02:41", "src/agent.py:42"); parse what we can link. */
import type { Citation } from "../api/client";

export type Focus =
  | { kind: "slide"; index: number }
  | { kind: "time"; seconds: number }
  | { kind: "code"; path: string; line: number }
  | { kind: "form" }
  | { kind: "none" };

export function parseCitation(c: Citation): Focus {
  if (c.source === "deck") {
    const m = c.ref.match(/slides?\s+(\d+)/i);
    return m ? { kind: "slide", index: Number(m[1]) } : { kind: "none" };
  }
  if (c.source === "video") {
    const m = c.ref.match(/(\d+(?::\d{2}){1,2})/);
    if (!m) return { kind: "none" };
    const seconds = m[1].split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
    return { kind: "time", seconds };
  }
  if (c.source === "form") return { kind: "form" };
  const m = c.ref.match(/^(.+?):(\d+)/);
  return m ? { kind: "code", path: m[1], line: Number(m[2]) } : { kind: "none" };
}

export const mmss = (seconds: number): string => {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};
