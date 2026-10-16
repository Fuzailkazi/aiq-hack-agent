import { describe, expect, it } from "vitest";
import { RoutingPolicySchema } from "../../src/config";
import { criterionState } from "../../src/jev/calibrationQuestions";
import type { JevClient, JevQuestion } from "../../src/jev/client";
import { PrescreenResultSchema } from "../../src/schemas/evaluation";
import { ArmorIQEvidenceSchema, type MediaDigest, MediaDigestSchema } from "../../src/schemas/evidence";
import { type Scorecard, ScorecardSchema } from "../../src/schemas/findings";
import type { JevDecision } from "../../src/schemas/jev";
import { SubmissionSchema } from "../../src/schemas/submission";
import { calibrate, NO_SECOND_OPINION } from "../../src/stages/calibrate";
import { exampleRubric } from "../helpers";

const rubric = exampleRubric();
const POLICY = RoutingPolicySchema.parse({});
const SUB = SubmissionSchema.parse({
  id: "s1",
  hackathonId: "h",
  teamName: "T",
  repoUrl: "https://github.com/o/r",
  submittedAt: "2026-10-01T00:00:00Z",
});
const MEDIA: MediaDigest = MediaDigestSchema.parse({
  deck: {
    sourceFormat: "pdf",
    slideCount: 2,
    slides: [
      { index: 1, text: "GuardRail problem statement" },
      { index: 2, text: "Architecture with ArmorIQ" },
    ],
  },
  video: {
    durationS: 90,
    hasSpeech: true,
    transcript: [{ startS: 30, endS: 40, text: "Live demo: the guard blocks a tool call" }],
    keyframes: [],
  },
});
const EVIDENCE = ArmorIQEvidenceSchema.parse({
  installs: [{ path: "requirements.txt", kind: "manifest", ecosystem: "pypi", package: "armoriq-sdk" }],
});
const card = (level = 2): Scorecard =>
  ScorecardSchema.parse({
    scores: rubric.criteria.map((c) => ({
      criterionId: c.id,
      levelLabel: c.levels[level].label,
      level,
      rationale: "SECRET_RATIONALE from the LLM",
      citations: [{ source: "deck", ref: "slide 2" }],
    })),
  });

/** Jev stand-in: score answers concentrate on `level` unless overridden; records calls; can fail one criterion. */
class ScriptJev implements JevClient {
  calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
  constructor(
    private readonly level = 2,
    private readonly sufficient = 0.9,
    private readonly claims = 0.1,
    private readonly failFor?: string,
  ) {}
  async decide(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevDecision>> {
    this.calls.push({ state, questions });
    const criterion = (state as { criterion?: string }).criterion;
    if (this.failFor && criterion === this.failFor) throw new Error("Jev unavailable");
    const out: Record<string, JevDecision> = {};
    for (const [id, q] of Object.entries(questions)) {
      const base = { questionId: id, model: "fake", requestId: null };
      if (q.type === "score") {
        const n = (q.criteria as readonly unknown[]).length;
        const probs = Object.fromEntries(
          Array.from({ length: n }, (_, i) => [String(i), i === this.level ? 1 : 0]),
        );
        out[id] = { ...base, type: "score", value: this.level, probabilities: probs, confidence: 1 };
      } else {
        const p = id === "sufficient" ? this.sufficient : this.claims;
        out[id] = {
          ...base,
          type: "noul",
          value: p,
          probabilities: { yes: p, no: 1 - p },
          confidence: Math.max(p, 1 - p),
        };
      }
    }
    return out;
  }
}

const run = (
  jev: JevClient | null,
  c = card(),
  gateFlags: string[] = [],
  prescreenFlags: Record<string, number> = {},
) =>
  calibrate(SUB, c, MEDIA, PrescreenResultSchema.parse({ flags: prescreenFlags }), EVIDENCE, gateFlags, {
    rubric,
    policy: POLICY,
    jev,
  });

describe("calibrate", () => {
  it("accepts when Jev agrees and evidence suffices; one call per criterion plus the claims check", async () => {
    const jev = new ScriptJev();
    const result = await run(jev);
    expect(jev.calls).toHaveLength(rubric.criteria.length + 1);
    expect(result.route).toBe("accept");
    expect(result.confidence).toBe(1);
    expect(result.autoScore).toBe(66.67);
    expect(result.flags.claims_unsupported).toBe(0.1);
    expect(result.criteria.every((c) => c.jevProbs?.length && c.agreement === 1)).toBe(true);
  });

  it("never shows Jev the LLM's levels or prose", async () => {
    const jev = new ScriptJev();
    await run(jev);
    const states = JSON.stringify(jev.calls.map((c) => c.state));
    expect(states).not.toContain("SECRET_RATIONALE");
    expect(states).toContain("GuardRail problem statement");
  });

  it("disagreement, low sufficiency, flags and late commits route to review", async () => {
    expect((await run(new ScriptJev(0))).route).toBe("review");
    expect((await run(new ScriptJev(2, 0.3))).reasons.some((r) => r.includes("sufficiency"))).toBe(true);
    expect((await run(new ScriptJev(2, 0.9, 0.9))).reasons).toContain("flag claims_unsupported = 0.90");
    expect((await run(new ScriptJev(), card(), [], { evaluator_injection_attempt: 0.8 })).route).toBe(
      "review",
    );
    expect((await run(new ScriptJev(), card(), ["1 commit(s) after the deadline"])).route).toBe("review");
  });

  it("a Jev failure on one criterion routes to review instead of crashing", async () => {
    const result = await run(new ScriptJev(2, 0.9, 0.1, "demo_quality"));
    expect(result.route).toBe("review");
    expect(result.reasons.some((r) => r.startsWith("demo_quality: no Jev second opinion"))).toBe(true);
  });

  it("a total Jev outage is an error (retryable), not a flood of review items", async () => {
    const down: JevClient = { decide: async () => Promise.reject(new Error("Jev unavailable")) };
    await expect(run(down)).rejects.toThrow("Jev unavailable");
  });

  it("falls back to cited evidence when the raw text is over budget", () => {
    const big = MediaDigestSchema.parse({
      deck: {
        sourceFormat: "pdf",
        slideCount: 3,
        slides: [
          { index: 1, text: "filler ".repeat(5000) },
          { index: 2, text: "THE CITED SLIDE" },
          { index: 3, text: "more filler ".repeat(5000) },
        ],
      },
    });
    const problem = rubric.criteria.find((c) => c.id === "problem_solution");
    if (!problem) throw new Error("fixture rubric changed");
    const state = criterionState(problem, big, null, card(), 2000);
    expect(state.evidence.length).toBeLessThanOrEqual(2000);
    expect(state.evidence).toContain("THE CITED SLIDE");
  });
});

describe("calibrate without a second opinion (HACKEVAL_SECOND_OPINION=none)", () => {
  it("keeps the LLM score and sends the result to a judge, saying why", async () => {
    const strong = await run(new ScriptJev(2));
    const result = await run(null);
    expect(result.route).toBe("review");
    expect(result.reasons[0]).toBe(NO_SECOND_OPINION);
    expect(result.autoScore).toBe(strong.autoScore);
    expect(result.criteria.map((c) => [c.llmLevel, c.jevScore])).toEqual(
      rubric.criteria.map(() => [2, null]),
    );
  });

  it("still carries prescreen flags and gate flags into the reasons", async () => {
    const result = await run(null, card(), ["2 commit(s) after the deadline"]);
    expect(result.reasons).toContain("gate: 2 commit(s) after the deadline");
  });
});
