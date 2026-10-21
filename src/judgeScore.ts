/**
 * A judge's own score for a team, entered as points per criterion next to the AI score. It does not change the
 * team's status; the leaderboard ranks by the judges' average when there is one.
 */
import { applyPenalties } from "./penalties";
import { ReviewError } from "./review";
import type { Evaluation, JudgeScore, Status } from "./schemas/evaluation";
import type { DB } from "./store/db";
import * as q from "./store/queries";

/** A judge can score a team once the AI has scored it. */
const SCORABLE: Status[] = ["needs_review", "finalized"];

export interface JudgeScoreInput {
  reviewer: string;
  points: Record<string, number>;
  notes?: string;
}

export function saveJudgeScore(
  db: DB,
  submissionId: string,
  input: JudgeScoreInput,
  now: string,
): JudgeScore {
  const { submission, status } = q.getSubmission(db, submissionId);
  if (!SCORABLE.includes(status))
    throw new ReviewError(`a judge can score a team once the AI has scored it (this team is '${status}')`);
  const evaluation = q.getEvaluation(db, submissionId);
  if (!evaluation) throw new ReviewError("this team has no evaluation yet");
  const rubric = q.activeRubric(db, submission.hackathonId);

  const points: Record<string, number> = {};
  for (const c of rubric.criteria) {
    const value = input.points[c.id];
    if (value === undefined || !Number.isFinite(value))
      throw new ReviewError(`give points for every criterion (missing '${c.name}')`, 400);
    if (value < 0 || value > c.weight)
      throw new ReviewError(`'${c.name}' takes 0 to ${c.weight} points (got ${value})`, 400);
    points[c.id] = value;
  }
  const unknown = Object.keys(input.points).filter((k) => !(k in points));
  if (unknown.length) throw new ReviewError(`unknown criteria: ${unknown.join(", ")}`, 400);

  const weights = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  const awarded = Object.values(points).reduce((sum, p) => sum + p, 0);
  const rubricScore = Math.round((10000 * awarded) / weights) / 100;
  const score: JudgeScore = {
    reviewer: input.reviewer.trim(),
    points,
    notes: input.notes?.trim() ?? "",
    // The same deductions for missing requirements as the AI score: they are facts, not judgement.
    total: applyPenalties(rubricScore, evaluation.calibration?.penalties ?? []),
    at: now,
    rubricVersion: rubric.version,
  };
  const others = evaluation.judgeScores.filter(
    (s) => s.reviewer.toLowerCase() !== score.reviewer.toLowerCase(),
  );
  q.saveEvaluation(db, { ...evaluation, status, judgeScores: [...others, score] }, status);
  return score;
}

/** The judges' average total, or null when no judge has scored the team. */
export function judgeAverage(evaluation: Pick<Evaluation, "judgeScores"> | null): number | null {
  const scores = evaluation?.judgeScores ?? [];
  if (!scores.length) return null;
  return Math.round((100 * scores.reduce((sum, s) => sum + s.total, 0)) / scores.length) / 100;
}
