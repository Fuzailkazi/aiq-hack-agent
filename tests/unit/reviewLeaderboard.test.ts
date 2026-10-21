import { parse } from "csv-parse/sync";
import { beforeEach, describe, expect, it } from "vitest";
import { judgeAverage, saveJudgeScore } from "../../src/judgeScore";
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

  it("an override re-levels criteria but keeps the deductions for missing requirements", () => {
    const ev = scored("a", 2, "needs_review");
    ev.calibration = CalibrationResultSchema.parse({
      ...ev.calibration,
      penalties: [{ id: "social_post", label: "No X or LinkedIn post", points: 5, detail: "no link" }],
    });
    q.saveEvaluation(db, ev);
    expect(resolveReview(db, "a", review("override", { demo_quality: "End-to-end" }), rubric)).toBe(
      "finalized",
    );
    // 75 from the rubric (as in the plain override test above), minus 5.
    expect(q.getEvaluation(db, "a")?.finalScore).toBe(70);
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
      "rank,submission_id,team_name,final_score,auto_score,overridden,track,judge_score",
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
    expect(leaderboardCsv(rows).trim().split("\n").at(-1)?.endsWith(",elevenlabs,")).toBe(true);
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
        judgeScore: null,
        overridden: false,
      },
    ]);
    const rows = parse(csv, { columns: true }) as Record<string, string>[];
    expect(rows[0].team_name).toBe(`'=HYPERLINK("http://x")`);
  });
});

describe("judge scores", () => {
  /** Every criterion at the same fraction of its weight. */
  const points = (fraction: number) =>
    Object.fromEntries(rubric.criteria.map((c) => [c.id, Math.round(1e6 * c.weight * fraction) / 1e6]));

  it("normalizes points to 0-100, keeps the AI's deductions and replaces a judge's earlier score", () => {
    const ev = scored("d", 1, "needs_review");
    ev.calibration = CalibrationResultSchema.parse({
      ...ev.calibration,
      penalties: [{ id: "social_post", label: "No post", points: 5, detail: "none" }],
    });
    q.saveEvaluation(db, ev);
    expect(saveJudgeScore(db, "d", { reviewer: "Fuzail", points: points(0.5) }, T0).total).toBe(45);
    saveJudgeScore(db, "d", { reviewer: "fuzail", points: points(1), notes: "great" }, T0);
    saveJudgeScore(db, "d", { reviewer: "Isha", points: points(0.5) }, T0);
    const saved = q.getEvaluation(db, "d");
    expect(saved?.judgeScores.map((s) => [s.reviewer, s.total])).toEqual([
      ["fuzail", 95],
      ["Isha", 45],
    ]);
    expect(judgeAverage(saved)).toBe(70);
    // A judge's score never changes the team's status.
    expect(q.getSubmission(db, "d").status).toBe("needs_review");
  });

  it("rejects missing criteria, points above the weight, and teams the AI has not scored", () => {
    q.saveEvaluation(db, scored("d", 1, "needs_review"));
    const { [rubric.criteria[0].id]: _, ...partial } = points(0.5);
    expect(() => saveJudgeScore(db, "d", { reviewer: "j", points: partial }, T0)).toThrow(/every criterion/);
    expect(() =>
      saveJudgeScore(db, "d", { reviewer: "j", points: { ...points(0.5), [rubric.criteria[0].id]: 99 } }, T0),
    ).toThrow(/takes 0 to/);
    q.saveEvaluation(db, { ...scored("c", 1, "scoring"), scorecard: null });
    expect(() => saveJudgeScore(db, "c", { reviewer: "j", points: points(0.5) }, T0)).toThrow(/once the AI/);
  });

  it("ranks by the judges' average, and lists AI-scored teams a judge has scored", () => {
    q.saveEvaluation(db, scored("a", 3, "finalized"));
    q.saveEvaluation(db, scored("d", 1, "needs_review"));
    q.saveEvaluation(db, scored("b", 2, "needs_review"));
    saveJudgeScore(db, "a", { reviewer: "j", points: points(0.4) }, T0);
    saveJudgeScore(db, "d", { reviewer: "j", points: points(0.9) }, T0);
    const rows = buildLeaderboard(db, "h");
    expect(rows.map((r) => [r.rank, r.teamName, r.finalScore, r.judgeScore])).toEqual([
      [1, "Delta", 90, 90],
      [2, "Alpha", 40, 40],
    ]);
    expect(leaderboardCsv(rows).split("\n")[1].endsWith(",90")).toBe(true);
  });
});
