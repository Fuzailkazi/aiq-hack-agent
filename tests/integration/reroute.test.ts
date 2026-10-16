import { beforeEach, describe, expect, it } from "vitest";
import { type Policy, PolicySchema } from "../../src/config";
import { reroute } from "../../src/reroute";
import { CalibrationResultSchema } from "../../src/schemas/calibration";
import { EvaluationSchema, GateResultSchema, type Status } from "../../src/schemas/evaluation";
import { ScorecardSchema } from "../../src/schemas/findings";
import { SubmissionSchema } from "../../src/schemas/submission";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { exampleRubric, testDb } from "../helpers";

const T0 = "2026-10-01T00:00:00Z";
const rubric = exampleRubric();
const DEFAULT = PolicySchema.parse({});
const withRouting = (routing: Partial<Policy["routing"]>): Policy => ({
  ...DEFAULT,
  routing: { ...DEFAULT.routing, ...routing },
});
let db: DB;

/** Every criterion scored level 2 by the LLM; Jev's distribution is `probs`. */
function store(
  id: string,
  status: Status,
  probs: number[],
  gateFlags: string[] = [],
  version = rubric.version,
) {
  const scorecard = ScorecardSchema.parse({
    scores: rubric.criteria.map((c) => ({
      criterionId: c.id,
      levelLabel: c.levels[2].label,
      level: 2,
      rationale: "r",
    })),
  });
  const criteria = rubric.criteria.map((c) => ({
    criterionId: c.id,
    llmLevel: 2,
    jevScore: probs.reduce((s, p, i) => s + p * i, 0),
    jevProbs: probs,
    sufficiency: 0.9,
  }));
  const route = status === "finalized" ? "accept" : "review";
  q.saveEvaluation(
    db,
    EvaluationSchema.parse({
      submissionId: id,
      status,
      rubricId: rubric.id,
      rubricVersion: version,
      gate: GateResultSchema.parse({ status: "pass", flags: gateFlags }),
      scorecard,
      calibration: CalibrationResultSchema.parse({ criteria, autoScore: 66.67, confidence: 0.8, route }),
      autoScore: 66.67,
      finalScore: status === "finalized" ? 66.67 : null,
    }),
  );
}

beforeEach(() => {
  db = testDb();
  q.createHackathon(db, "h", "Hack", null);
  q.activateRubric(db, "h", rubric);
  for (const id of ["a", "b", "c", "d"]) {
    q.upsertSubmission(
      db,
      SubmissionSchema.parse({
        id,
        hackathonId: "h",
        externalId: id,
        teamName: `Team ${id}`,
        repoUrl: `https://github.com/o/${id}`,
        submittedAt: T0,
      }),
      null,
    );
  }
});

describe("reroute", () => {
  it("re-applies a looser policy to stored calibrations: review becomes finalized", () => {
    store("a", "needs_review", [0, 0.2, 0.8, 0]);
    const report = reroute(db, "h", rubric, withRouting({ levelTolerance: 1 }));
    expect(report.changed).toEqual(["a (Team a): needs_review → finalized"]);
    const ev = q.getEvaluation(db, "a");
    expect(ev?.status).toBe("finalized");
    expect(ev?.finalScore).toBe(66.67);
    expect(ev?.calibration?.route).toBe("accept");
    expect(ev?.calibration?.confidence).toBe(1);
    expect(ev?.calibration?.reasons).toEqual([]);
  });

  it("a stricter policy sends finalized results back to review and clears the final score", () => {
    store("a", "finalized", [0, 0, 1, 0]);
    const report = reroute(db, "h", rubric, withRouting({ minSufficiency: 0.95 }));
    expect(report.changed).toEqual(["a (Team a): finalized → needs_review"]);
    const ev = q.getEvaluation(db, "a");
    expect(ev?.status).toBe("needs_review");
    expect(ev?.finalScore).toBeNull();
    expect(ev?.calibration?.reasons.join(" ")).toContain("sufficiency 0.90 < 0.95");
  });

  it("leaves human decisions, late-commit gate flags and other rubric versions alone", () => {
    store("a", "finalized", [0, 0.2, 0.8, 0]);
    q.addReview(db, "a", {
      reviewer: "judge",
      kind: "score",
      decision: "accept",
      overrides: {},
      notes: "",
      at: T0,
    });
    store("b", "needs_review", [0, 0.2, 0.8, 0], ["1 commit(s) after the deadline"]);
    store("c", "needs_review", [0, 0.2, 0.8, 0], [], "old");
    store("d", "needs_review", [0, 0, 1, 0]);
    const report = reroute(db, "h", rubric, withRouting({ levelTolerance: 1 }));
    expect(report.changed).toEqual(["d (Team d): needs_review → finalized"]);
    expect(report.unchanged).toBe(1);
    expect(report.skipped).toEqual([
      "a (Team a): decided by a human reviewer",
      "c (Team c): scored under rubric version old",
    ]);
    expect(q.getEvaluation(db, "a")?.status).toBe("finalized");
    expect(q.getEvaluation(db, "b")?.calibration?.reasons).toEqual(["gate: 1 commit(s) after the deadline"]);
  });
});
