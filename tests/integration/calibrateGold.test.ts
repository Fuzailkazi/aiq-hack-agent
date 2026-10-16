import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { calibrationReport, evaluatePolicy, loadGold, loadReplays, sweep } from "../../src/calibrateGold";
import { PolicySchema } from "../../src/config";
import { CalibrationResultSchema } from "../../src/schemas/calibration";
import { EvaluationSchema } from "../../src/schemas/evaluation";
import { ScorecardSchema } from "../../src/schemas/findings";
import { SubmissionSchema } from "../../src/schemas/submission";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { exampleRubric, tempDir, testDb } from "../helpers";

const rubric = exampleRubric();
const routing = PolicySchema.parse({}).routing;
let db: DB;
let dir: string;

/** Every criterion: the LLM chose `llm`, Jev answered `probs`, evidence sufficiency `suff`. */
function stored(id: string, llm: number, probs: number[], suff: number) {
  q.upsertSubmission(
    db,
    SubmissionSchema.parse({
      id,
      hackathonId: "h",
      externalId: `ext-${id}`,
      teamName: `T${id}`,
      repoUrl: `https://github.com/o/${id}`,
      submittedAt: "2026-10-01T00:00:00Z",
    }),
    null,
  );
  const scorecard = ScorecardSchema.parse({
    scores: rubric.criteria.map((c) => ({
      criterionId: c.id,
      levelLabel: c.levels[llm].label,
      level: llm,
      rationale: "r",
    })),
  });
  const criteria = rubric.criteria.map((c) => ({
    criterionId: c.id,
    llmLevel: llm,
    jevScore: probs.reduce((s, p, i) => s + p * i, 0),
    jevProbs: probs,
    sufficiency: suff,
  }));
  q.saveEvaluation(
    db,
    EvaluationSchema.parse({
      submissionId: id,
      status: "needs_review",
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      scorecard,
      autoScore: (100 * llm) / 3,
      calibration: CalibrationResultSchema.parse({
        criteria,
        autoScore: (100 * llm) / 3,
        confidence: 0,
        route: "review",
      }),
    }),
  );
}

function goldCsv(rows: [string, number][], extra = "") {
  const header = ["submission_id", ...rubric.criteria.map((c) => c.id)].join(",");
  const lines = rows.map(([id, level]) =>
    [id, ...rubric.criteria.map((c) => c.levels[level].label)].join(","),
  );
  const path = join(dir, "gold.csv");
  writeFileSync(path, `${[header, ...lines].join("\n")}\n${extra}`);
  return path;
}

beforeEach(() => {
  db = testDb();
  dir = tempDir();
  q.createHackathon(db, "h", "Hack", null);
  q.activateRubric(db, "h", rubric);
  stored("a", 2, [0, 0, 1, 0], 0.9); // agrees, accepted
  stored("b", 3, [0, 0, 0.3, 0.7], 0.9); // agreement 0.7 → review at tolerance 0, accept at 1
  stored("c", 3, [0, 0, 0, 1], 0.55); // Jev agrees, thin evidence → review; humans say 0 (the LLM is wrong)
  stored("d", 1, [0, 1, 0, 0], 0.9); // agrees, accepted
});

describe("gold-set calibration (replay only, no model calls)", () => {
  it("loads human levels by submission id or external id, reporting bad rows", () => {
    const path = goldCsv(
      [
        ["a", 2],
        ["ext-b", 3],
      ],
      "zzz,Missing\nc,NotALevel,,,,,\n",
    );
    const { rows, errors } = loadGold(db, "h", path, rubric);
    expect(rows.map((r) => r.submissionId)).toEqual(["a", "b"]);
    expect(rows[1].levels.problem_solution).toBe(3);
    expect(errors).toEqual([
      "row 4: unknown submission 'zzz'",
      "row 5: problem_solution: unknown level 'NotALevel' (expected Missing, Vague, Clear, Compelling)",
    ]);
  });

  it("measures agreement and review rate under a policy", () => {
    const gold = loadGold(
      db,
      "h",
      goldCsv([
        ["a", 2],
        ["b", 3],
        ["c", 0],
        ["d", 1],
      ]),
      rubric,
    ).rows;
    const m = evaluatePolicy(loadReplays(db, "h", rubric), gold, rubric, routing);
    expect(m).toMatchObject({
      goldScored: 4,
      accepted: 2,
      reviewRate: 0.5,
      acceptedWithin1: 1,
      allWithin1: 0.75,
      exact: 0.75,
    });
    expect(m.meanAbsScoreDiff).toBe(25);
  });

  it("sweeps tolerance/sufficiency/agreement with the 0.85 bar fixed and recommends the lowest safe review rate", () => {
    const gold = loadGold(
      db,
      "h",
      goldCsv([
        ["a", 2],
        ["b", 3],
        ["c", 0],
        ["d", 1],
      ]),
      rubric,
    ).rows;
    const result = sweep(loadReplays(db, "h", rubric), gold, rubric, routing, {
      targetWithin1: 0.9,
      maxReviewRate: 0.3,
    });
    expect(result.rows.every((r) => r.policy.autoAcceptConfidence === 0.85)).toBe(true);
    const loose = result.rows.find((r) => r.policy.levelTolerance === 1 && r.policy.minSufficiency === 0.5);
    expect(loose?.metrics.acceptedWithin1).toBe(0.75); // c gets accepted and is wrong
    expect(loose?.meetsTargets).toBe(false);
    expect(result.recommended?.policy).toMatchObject({
      levelTolerance: 1,
      minSufficiency: 0.8,
      minCriterionAgreement: 0.7,
    });
    expect(result.recommended?.metrics.reviewRate).toBe(0.25);
  });

  it("builds a report for the CLI", () => {
    const report = calibrationReport(
      db,
      "h",
      goldCsv([
        ["a", 2],
        ["b", 3],
        ["c", 0],
        ["d", 1],
      ]),
      rubric,
      PolicySchema.parse({}),
    );
    expect(report.current.reviewRate).toBe(0.5);
    expect(report.allScored).toBe(4);
    expect(report.recommended?.metrics.reviewRate).toBe(0.25);
    expect(report.errors).toEqual([]);
  });
});
