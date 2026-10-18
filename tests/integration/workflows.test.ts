import { describe, expect, it } from "vitest";
import { buildGateWorkflow } from "../../src/pipeline/gateWorkflow";
import { WorkflowRunner } from "../../src/pipeline/runner";
import { buildScoringWorkflow } from "../../src/pipeline/scoringWorkflow";
import { RubricSchema } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";
import { fakeDeps } from "../fakes";
import { exampleRubric, shippedPolicy } from "../helpers";

const sub = (url: string) =>
  SubmissionSchema.parse({
    id: "s1",
    hackathonId: "h",
    teamName: "T",
    repoUrl: url,
    submittedAt: "2026-10-01T00:00:00Z",
  });
const rubric = exampleRubric();
const policy = shippedPolicy();

describe("gate workflow", () => {
  it.each(["pass", "fail", "review", "needs_attention"] as const)("routes a %s gate", async (gate) => {
    const deps = fakeDeps(rubric, policy, { u: { gate } });
    const state = await new WorkflowRunner(buildGateWorkflow(deps)).run({ submission: sub("u") });
    expect((state.gate as { status: string }).status).toBe(gate);
    expect("evidence" in state).toBe(gate !== "needs_attention");
  });

  it("propagates a node exception", async () => {
    const deps = fakeDeps(rubric, policy, { u: { crashIn: "decideGate" } });
    await expect(new WorkflowRunner(buildGateWorkflow(deps)).run({ submission: sub("u") })).rejects.toThrow(
      /scripted crash in decideGate/,
    );
  });
});

describe("scoring workflow", () => {
  const initial = (url: string) => ({ submission: sub(url), evidence: null, gateFlags: [] });

  it("runs analysts in parallel, joins, synthesizes and calibrates", async () => {
    const deps = fakeDeps(rubric, policy, {});
    const state = await new WorkflowRunner(buildScoringWorkflow(deps)).run(initial("u"));
    // Cheapest and most reliable first: code, form, deck, then the video.
    expect((state.findings as { source: string }[]).map((f) => f.source)).toEqual([
      "repo",
      "form",
      "deck",
      "video",
    ]);
    expect(state.calibration).toMatchObject({ route: "accept", autoScore: 100 });
  });

  it("keeps scoring when the video cannot be fetched, and says so", async () => {
    const deps = fakeDeps(rubric, policy, { u: { mediaUnreachable: true } });
    const state = await new WorkflowRunner(buildScoringWorkflow(deps)).run(initial("u"));
    expect(state.media).toMatchObject({
      unreachable: { video: "link returned a login page instead of a video" },
    });
    const video = (state.findings as { source: string; unavailable: string | null }[]).find(
      (f) => f.source === "video",
    );
    expect(video?.unavailable).toBe("link returned a login page instead of a video");
    expect(state.calibration).toBeDefined();
    expect(state.warnings).toEqual(
      expect.arrayContaining(["Video not watched: link returned a login page instead of a video."]),
    );
  });

  it("skips the repo analyst when no criterion uses the repo", async () => {
    const noRepo = RubricSchema.parse({
      ...rubric,
      criteria: rubric.criteria.filter((c) => !c.sources.includes("repo")),
    });
    const base = fakeDeps(noRepo, policy, {});
    const calls: string[] = [];
    const deps = {
      ...base,
      analyze: async (...args: Parameters<typeof base.analyze>) => {
        calls.push(args[0]);
        return base.analyze(...args);
      },
    };
    const state = await new WorkflowRunner(buildScoringWorkflow(deps)).run(initial("u"));
    expect(calls.sort()).toEqual(["deck", "video"]);
    expect(
      (state.findings as { source: string; summary: string }[]).find((f) => f.source === "repo")?.summary,
    ).toBe("The rubric has no repo-sourced criteria.");
  });
});
