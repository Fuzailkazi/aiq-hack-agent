/** The walking-skeleton scenario: tests/fixtures/submissions.csv plus how the fake pipeline treats each team. */
import type { Scripted } from "./fakes";

export const FIXTURE = "tests/fixtures/submissions.csv";
export const SCRIPT: Record<string, Scripted> = {
  "https://github.com/example/bravo": { gate: "fail" },
  "https://github.com/example/charlie": { gate: "review" },
  "https://github.com/example/delta": { gate: "needs_attention" },
  "https://github.com/example/echo": { route: "review" },
  "https://github.com/example/foxtrot": { mediaUnreachable: true },
  "https://github.com/example/golf": { level: 1 },
};
