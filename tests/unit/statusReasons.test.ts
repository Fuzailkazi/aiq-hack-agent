import { describe, expect, it } from "vitest";
import { EvaluationSchema } from "../../src/schemas/evaluation";
import { statusReasons } from "../../src/service";

const ev = (fields: Record<string, unknown>) => EvaluationSchema.parse({ submissionId: "s", ...fields });
const gate = (status: string, reasons: string[]) => ({ status, reasons });

describe("statusReasons", () => {
  it("explains a gate disqualification", () => {
    const e = ev({ status: "disqualified", gate: gate("fail", ["No ArmorIQ SDK install declaration"]) });
    expect(statusReasons("disqualified", e)).toEqual(["No ArmorIQ SDK install declaration"]);
  });

  it("names the reviewer who disqualified a team, with their note", () => {
    const e = ev({
      status: "disqualified",
      gate: gate("pass", ["SDK installed and called"]),
      reviews: [
        {
          reviewer: "fuzail",
          kind: "score",
          decision: "disqualify",
          notes: "copied project",
          at: "2026-10-17T00:00:00Z",
        },
      ],
    });
    expect(statusReasons("disqualified", e)).toEqual(["disqualified by fuzail: copied project"]);
  });

  it("prefers an unreachable artifact over the gate's pass reason for needs_attention", () => {
    const e = ev({
      status: "needs_attention",
      gate: gate("pass", ["SDK installed and called"]),
      mediaUnreachable: { video: "video download failed: yt-dlp is not installed" },
    });
    expect(statusReasons("needs_attention", e)).toEqual([
      "video: video download failed: yt-dlp is not installed",
    ]);
    const repo = ev({ status: "needs_attention", gate: gate("needs_attention", ["repository unreachable"]) });
    expect(statusReasons("needs_attention", repo)).toEqual(["repository unreachable"]);
  });

  it("explains infrastructure failures in plain words, and stays quiet for normal statuses", () => {
    const failed = (error: string) => statusReasons("error", ev({ status: "error", error }));
    expect(
      failed("Error: agent video_analyst returned no structured output (error=429 message=quota)")[0],
    ).toMatch(/^Not scored yet: the Gemini rate limit was reached/);
    expect(
      failed(
        "Error: agent synthesis returned no structured output (error=UNKNOWN_ERROR message=fetch failed)",
      )[0],
    ).toMatch(/^Not scored yet: the connection to Gemini dropped/);
    expect(failed("Error: agent x returned no structured output (error=503 message=high demand)")[0]).toMatch(
      /^Not scored yet: Gemini was overloaded/,
    );
    expect(failed("Error: API key must be provided via constructor")[0]).toMatch(/no Gemini API key/);
    expect(failed("Error: disk full")).toEqual(["Scoring failed: disk full"]);
    expect(statusReasons("scoring", ev({ status: "scoring" }))).toEqual([]);
    expect(statusReasons("finalized", null)).toEqual([]);
  });
});
