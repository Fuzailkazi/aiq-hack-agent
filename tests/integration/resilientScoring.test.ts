import { describe, expect, it } from "vitest";
import { fallbackScorecard, shortCause, unavailableFindings } from "../../src/pipeline/resilience";
import { WorkflowRunner } from "../../src/pipeline/runner";
import { buildScoringWorkflow } from "../../src/pipeline/scoringWorkflow";
import { type ArtifactFindings, ArtifactFindingsSchema } from "../../src/schemas/findings";
import { partialWeightedScore } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";
import { loadSettings, policyOf } from "../../src/settings";
import { fakeDeps } from "../fakes";
import { exampleRubric } from "../helpers";

const rubric = exampleRubric();
const policy = policyOf(loadSettings({}));
const QUOTA =
  "You exceeded your current quota, please check your plan and billing details. Please retry in 22h";
const initial = {
  submission: SubmissionSchema.parse({
    id: "s",
    hackathonId: "h",
    teamName: "T",
    repoUrl: "u",
    submittedAt: "2026-10-01T00:00:00Z",
  }),
  evidence: null,
  gateFlags: [],
};
const run = (deps: ReturnType<typeof fakeDeps>) =>
  new WorkflowRunner(buildScoringWorkflow(deps)).run(initial);

describe("scoring that degrades instead of stopping", () => {
  it("scores without the video when the video step fails, leaves video-only criteria out, and warns", async () => {
    const base = fakeDeps(rubric, policy, {});
    const state = await run({
      ...base,
      analyze: async (...args: Parameters<typeof base.analyze>) => {
        if (args[0] === "video") throw new Error(QUOTA);
        return base.analyze(...args);
      },
    });
    const scores = (state.scorecard as { scores: { criterionId: string; notAssessed: boolean }[] }).scores;
    // demo_quality is judged only from the video in the example rubric.
    expect(scores.find((s) => s.criterionId === "demo_quality")?.notAssessed).toBe(true);
    expect(scores.filter((s) => s.notAssessed)).toHaveLength(1);
    expect(state.warnings).toEqual([
      "Video not watched: the Gemini quota is used up.",
      expect.stringMatching(/^Not judged: Working demo\. The score covers the other criteria only/),
    ]);
    expect(state.calibration).toMatchObject({ autoScore: expect.any(Number) });
  });

  it("falls back to the individual reviews when the final review fails", async () => {
    const base = fakeDeps(rubric, policy, {});
    const state = await run({
      ...base,
      synthesize: async () => {
        throw new Error("fetch failed");
      },
    });
    const card = state.scorecard as {
      scores: { notAssessed: boolean; rationale: string }[];
      feedbackMd: string;
    };
    expect(card.scores.every((s) => !s.notAssessed)).toBe(true);
    expect(card.scores[0].rationale).toMatch(/^From the /);
    expect(state.warnings).toEqual([
      expect.stringMatching(/^Final AI review did not run \(the connection to Gemini dropped\)/),
    ]);
  });

  it("is a real failure only when nothing at all could be judged", async () => {
    const base = fakeDeps(rubric, policy, {});
    await expect(
      run({
        ...base,
        analyze: async () => {
          throw new Error(QUOTA);
        },
        synthesize: async () => {
          throw new Error(QUOTA);
        },
      }),
    ).rejects.toThrow(/quota/);
  });
});

describe("resilience helpers", () => {
  it("scores only the judged criteria, renormalized by their weights", () => {
    const levels = Object.fromEntries(rubric.criteria.map((c) => [c.id, c.levels.length - 1]));
    const all = new Set(rubric.criteria.map((c) => c.id));
    expect(partialWeightedScore(rubric, levels, all)).toBe(100);
    all.delete("demo_quality");
    expect(partialWeightedScore(rubric, levels, all)).toBe(100);
    expect(() => partialWeightedScore(rubric, levels, new Set())).toThrow(/no criterion/);
  });

  it("builds a fallback scorecard from analysts' own levels, and marks the rest not assessed", () => {
    const repo = ArtifactFindingsSchema.parse({
      source: "repo",
      summary: "s",
      findings: [
        { criterionId: "armoriq_integration", observations: ["guards every call"], provisionalLabel: "Core" },
      ],
    });
    const findings: ArtifactFindings[] = [
      repo,
      unavailableFindings(rubric, "deck", "x"),
      unavailableFindings(rubric, "video", "y"),
    ];
    const card = fallbackScorecard(rubric, findings);
    const integration = card.scores.find((s) => s.criterionId === "armoriq_integration");
    expect(integration).toMatchObject({ levelLabel: "Core", notAssessed: false });
    expect(card.scores.filter((s) => s.notAssessed).map((s) => s.criterionId)).toEqual(
      rubric.criteria.filter((c) => c.id !== "armoriq_integration").map((c) => c.id),
    );
  });

  it("explains causes in a few words", () => {
    expect(shortCause(QUOTA)).toBe("the Gemini quota is used up");
    expect(shortCause("TypeError: fetch failed")).toBe("the connection to Gemini dropped");
    expect(shortCause("503 high demand")).toBe("Gemini was overloaded");
  });
});
