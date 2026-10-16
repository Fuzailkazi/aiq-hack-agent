import { describe, expect, it } from "vitest";
import { RoutingPolicySchema } from "../../src/config";
import type { CriterionCalibration } from "../../src/schemas/calibration";
import { criterionAgreement, decideRoute } from "../../src/stages/route";
import { exampleRubric } from "../helpers";

const POLICY = RoutingPolicySchema.parse({});
const rubric = exampleRubric();

function cc(
  id: string,
  llm: number,
  probs: number[] | null,
  score?: number | null,
  sufficiency = 0.9,
): CriterionCalibration {
  const jevScore = score !== undefined ? score : probs ? probs.reduce((sum, p, i) => sum + i * p, 0) : null;
  return {
    criterionId: id,
    llmLevel: llm,
    jevScore,
    jevProbs: probs,
    agreement: criterionAgreement(probs, jevScore, llm, POLICY.levelTolerance, POLICY.maxLevelGap),
    sufficiency,
    levelGap: jevScore === null ? null : Math.abs(jevScore - llm),
  };
}
const agreeing = () => rubric.criteria.map((c) => cc(c.id, 2, [0, 0, 1, 0]));

describe("criterionAgreement", () => {
  it.each([
    [[0, 0.1, 0.9, 0], null, 2, 0, 0.9],
    [[0, 0.3, 0.6, 0.1], null, 2, 1, 1],
    [[0.7, 0.3, 0, 0], null, 3, 0, 0],
    [null, 2, 2, 0, 1],
    [null, 1, 3, 0, 0], // gap 2 > max gap 1
    [null, 2.5, 3, 0, 0.75],
    [null, null, 1, 0, null],
  ])("probs=%j score=%s llm=%i tolerance=%i -> %s", (probs, score, llm, tolerance, expected) => {
    const got = criterionAgreement(probs as number[] | null, score as number | null, llm, tolerance, 1);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(expected as number, 6);
  });
});

describe("decideRoute", () => {
  it("accepts when Jev agrees everywhere", () => {
    const criteria = rubric.criteria.map((c) => cc(c.id, 2, [0, 0.05, 0.95, 0]));
    const decision = decideRoute(criteria, rubric, POLICY, {}, []);
    expect(decision.route).toBe("accept");
    expect(decision.confidence).toBeCloseTo(0.95, 6);
    expect(decision.reasons).toEqual([]);
  });

  it("weights confidence by criterion weight", () => {
    const agreement = Object.fromEntries(rubric.criteria.map((c, i) => [c.id, i ? 0.95 : 0.55]));
    const criteria = rubric.criteria.map((c) => cc(c.id, 1, [1 - agreement[c.id], agreement[c.id], 0, 0]));
    const weights = rubric.criteria.reduce((s, c) => s + c.weight, 0);
    const expected = rubric.criteria.reduce((s, c) => s + c.weight * agreement[c.id], 0) / weights;
    expect(decideRoute(criteria, rubric, POLICY, {}, []).confidence).toBeCloseTo(expected, 4);
  });

  it.each([
    ["agreement", (xs: CriterionCalibration[]) => (xs[0] = cc(xs[0].criterionId, 2, [0, 0.6, 0.4, 0]))],
    [
      "sufficiency",
      (xs: CriterionCalibration[]) => (xs[0] = cc(xs[0].criterionId, 2, [0, 0, 1, 0], undefined, 0.4)),
    ],
    ["level gap", (xs: CriterionCalibration[]) => (xs[0] = cc(xs[0].criterionId, 3, null, 1.5))],
    ["no Jev", (xs: CriterionCalibration[]) => (xs[0] = cc(xs[0].criterionId, 2, null, null))],
  ])("the %s rule fires on its own", (reason, mutate) => {
    const criteria = agreeing();
    mutate(criteria);
    const decision = decideRoute(criteria, rubric, POLICY, {}, []);
    expect(decision.route).toBe("review");
    expect(decision.reasons.some((r) => r.includes(reason))).toBe(true);
  });

  it.each([
    [{ evaluator_injection_attempt: 0.6 }, true],
    [{ evaluator_injection_attempt: 0.4 }, false],
    [{ claims_unsupported: 0.7 }, true],
    [{ artifacts_describe_same_project: 0.3 }, true],
    [{ artifacts_describe_same_project: 0.31 }, false],
    [{ video_shows_this_project: 0.2 }, true],
  ])("flags %j -> review=%s", (flags, fires) => {
    expect(decideRoute(agreeing(), rubric, POLICY, flags, []).route === "review").toBe(fires);
  });

  it("gate flags: late commits trigger review; a committed key is only reported", () => {
    expect(decideRoute(agreeing(), rubric, POLICY, {}, ["2 commit(s) after the deadline"]).route).toBe(
      "review",
    );
    expect(
      decideRoute(agreeing(), rubric, POLICY, {}, [
        "ArmorIQ API key committed to the repository (value redacted)",
      ]).route,
    ).toBe("accept");
    const relaxed = { ...POLICY, reviewOnCommitsAfterDeadline: false };
    expect(decideRoute(agreeing(), rubric, relaxed, {}, ["2 commit(s) after the deadline"]).route).toBe(
      "accept",
    );
  });

  it("routes to review when overall confidence is below 0.85 even if every criterion passes its own rules", () => {
    const criteria = rubric.criteria.map((c) => cc(c.id, 2, [0, 0.2, 0.8, 0])); // agreement 0.8 each, gap 0.2
    const decision = decideRoute(criteria, rubric, POLICY, {}, []);
    expect(decision.route).toBe("review");
    expect(decision.reasons).toEqual(["confidence 0.80 is below 0.85"]);
  });

  it("the 0.85 bar is inclusive", () => {
    expect(
      decideRoute(
        rubric.criteria.map((c) => cc(c.id, 2, [0, 0.15, 0.85, 0])),
        rubric,
        POLICY,
        {},
        [],
      ).route,
    ).toBe("accept");
  });

  it("discrepancy notes name the disagreement", () => {
    const criteria = agreeing();
    criteria[1] = cc(criteria[1].criterionId, 3, [0, 0.7, 0.3, 0]);
    const notes = decideRoute(criteria, rubric, POLICY, {}, []).notes;
    expect(
      notes.some(
        (n) => n.includes(criteria[1].criterionId) && n.includes("LLM level 3") && n.includes("Jev"),
      ),
    ).toBe(true);
  });

  it("supports custom flag rules", () => {
    const policy = { ...POLICY, flagRules: [{ flag: "x", op: "ge" as const, threshold: 0.1 }] };
    expect(decideRoute(agreeing(), rubric, policy, { x: 0.2 }, []).route).toBe("review");
  });
});
