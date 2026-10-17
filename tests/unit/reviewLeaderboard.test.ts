import { parse } from "csv-parse/sync";
import { beforeEach, describe, expect, it } from "vitest";
import { buildLeaderboard, leaderboardCsv } from "../../src/leaderboard";
import { resolveReview } from "../../src/review";
import { CalibrationResultSchema } from "../../src/schemas/calibration";
import {
  type Evaluation,
  EvaluationSchema,
  type HumanReview,
  type HumanReviewInput,
  type Status,
} from "../../src/schemas/evaluation";
import { levelsById, ScorecardSchema } from "../../src/schemas/findings";
import { weightedScore } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { exampleRubric, testDb } from "../helpers";

const T0 = "2026-10-01T00:00:00Z";
const rubric = exampleRubric();
let db: DB;

const review = (
  decision: HumanReview["decision"],
  overrides: Record<string, string> = {},
): HumanReviewInput => ({
  reviewer: "judge",
  kind: "score",
  decision,
  overrides,
  notes: "",
  at: T0,
});

function scored(id: string, level: number, status: Status): Evaluation {
  const scorecard = ScorecardSchema.parse({
    scores: rubric.criteria.map((c) => ({
      criterionId: c.id,
      levelLabel: c.levels[level].label,
      level,
      rationale: "r",
    })),
  });
  const auto = weightedScore(rubric, levelsById(scorecard));
  return EvaluationSchema.parse({
    submissionId: id,
    status,
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    scorecard,
    calibration: CalibrationResultSchema.parse({ autoScore: auto, confidence: 0.5, route: "review" }),
    autoScore: auto,
    finalScore: status === "finalized" ? auto : null,
  });
}

beforeEach(() => {
  db = testDb();
  q.createHackathon(db, "h", "Hack", null);
  q.activateRubric(db, "h", rubric);
  for (const [id, team] of [
    ["a", "Alpha"],
    ["b", "Bravo"],
    ["c", "Charlie"],
    ["d", "Delta"],
  ]) {
    q.upsertSubmission(
      db,
      SubmissionSchema.parse({
        id,
        hackathonId: "h",
        externalId: id,
        teamName: team,
        repoUrl: `https://github.com/o/${id}`,
        submittedAt: T0,
      }),
      null,
    );
  }
});

describe("review transitions", () => {
  it("gate review: reinstate and disqualify", () => {
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "a", status: "gate_review" }));
    expect(resolveReview(db, "a", review("reinstate"), rubric)).toBe("scoring");
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "b", status: "gate_review" }));
    expect(resolveReview(db, "b", review("disqualify"), rubric)).toBe("disqualified");
  });

  it("accept keeps the auto score", () => {
    q.saveEvaluation(db, scored("a", 2, "needs_review"));
    expect(resolveReview(db, "a", review("accept"), rubric)).toBe("finalized");
    const ev = q.getEvaluation(db, "a");
    expect(ev?.finalScore).toBe(66.67);
    expect(ev?.reviews).toHaveLength(1);
  });

  it("override recomputes the score from labels", () => {
    q.saveEvaluation(db, scored("a", 2, "needs_review"));
    expect(resolveReview(db, "a", review("override", { demo_quality: "End-to-end" }), rubric)).toBe(
      "finalized",
    );
    // demo_quality (weight .25) moves 2/3 -> 3/3: 66.67 + 25 * (1/3) = 75
    expect(q.getEvaluation(db, "a")?.finalScore).toBe(75);
  });

  it("refuses invalid transitions and unknown labels", () => {
    q.saveEvaluation(db, scored("a", 2, "finalized"));
    expect(() => resolveReview(db, "a", review("accept"), rubric)).toThrow(/cannot apply decision/);
    q.saveEvaluation(db, scored("b", 2, "needs_review"));
    expect(() => resolveReview(db, "b", review("override", { demo_quality: "Nope" }), rubric)).toThrow(
      /no level/,
    );
  });

  it("requeue recovers errors and attention", () => {
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "a", status: "error" }));
    expect(resolveReview(db, "a", review("requeue"), rubric)).toBe("queued");
    q.saveEvaluation(
      db,
      EvaluationSchema.parse({ submissionId: "b", status: "needs_attention", gate: { status: "pass" } }),
    );
    expect(resolveReview(db, "b", review("requeue"), rubric)).toBe("scoring");
  });
});

describe("leaderboard", () => {
  it("ranks with ties (1, 2, 2) and only includes finalized", () => {
    q.saveEvaluation(db, scored("a", 3, "finalized"));
    q.saveEvaluation(db, scored("b", 2, "finalized"));
    q.saveEvaluation(db, scored("c", 2, "finalized"));
    q.saveEvaluation(db, scored("d", 1, "needs_review"));
    const rows = buildLeaderboard(db, "h");
    expect(rows.map((r) => [r.rank, r.teamName, r.finalScore])).toEqual([
      [1, "Alpha", 100],
      [2, "Bravo", 66.67],
      [2, "Charlie", 66.67],
    ]);
    expect(leaderboardCsv(rows).split("\n")[0]).toBe(
      "rank,submission_id,team_name,final_score,auto_score,overridden,track",
    );
  });

  it("ranks each track on its own", () => {
    for (const [id, track] of [
      ["e", "elevenlabs"],
      ["f", "elevenlabs"],
    ]) {
      q.upsertSubmission(
        db,
        SubmissionSchema.parse({
          id,
          hackathonId: "h",
          externalId: id,
          teamName: `Team ${id}`,
          track,
          repoUrl: `https://github.com/o/${id}`,
          submittedAt: T0,
        }),
        null,
      );
    }
    q.saveEvaluation(db, scored("a", 2, "finalized"));
    q.saveEvaluation(db, scored("b", 3, "finalized"));
    q.saveEvaluation(db, scored("e", 1, "finalized"));
    q.saveEvaluation(db, scored("f", 3, "finalized"));
    const rows = buildLeaderboard(db, "h");
    expect(rows.map((r) => [r.track, r.rank, r.teamName])).toEqual([
      [null, 1, "Bravo"],
      [null, 2, "Alpha"],
      ["elevenlabs", 1, "Team f"],
      ["elevenlabs", 2, "Team e"],
    ]);
    expect(leaderboardCsv(rows).trim().split("\n").at(-1)?.endsWith(",elevenlabs")).toBe(true);
  });

  it("neutralizes spreadsheet formulas in team names", () => {
    const csv = leaderboardCsv([
      {
        rank: 1,
        track: null,
        submissionId: "a",
        teamName: '=HYPERLINK("http://x")',
        finalScore: 90,
        autoScore: 90,
        overridden: false,
      },
    ]);
    const rows = parse(csv, { columns: true }) as Record<string, string>[];
    expect(rows[0].team_name).toBe(`'=HYPERLINK("http://x")`);
  });
});
