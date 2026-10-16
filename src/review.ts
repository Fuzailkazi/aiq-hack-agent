/** Apply a human judge's decision to a submission. */
import {
  type Evaluation,
  EvaluationSchema,
  GateResultSchema,
  type HumanReview,
  type HumanReviewInput,
  type Status,
} from "./schemas/evaluation";
import { levelsById } from "./schemas/findings";
import { criterion, levelIndex, type Rubric, weightedScore } from "./schemas/rubric";
import type { DB } from "./store/db";
import * as q from "./store/queries";

/** Which review form applies to a submission in a given status. */
export const REVIEW_KIND: Partial<Record<Status, HumanReview["kind"]>> = {
  gate_review: "gate",
  needs_review: "score",
  disqualified: "gate",
  needs_attention: "attention",
  error: "attention",
};

/** A decision that does not fit the submission's state (409) or names an unknown criterion/level (400). */
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 409 = 409,
  ) {
    super(message);
  }
}

export function resolveReview(
  db: DB,
  submissionId: string,
  review: HumanReviewInput,
  rubric: Rubric,
): Status {
  const status = q.getSubmission(db, submissionId).status;
  const evaluation: Evaluation =
    q.getEvaluation(db, submissionId) ?? EvaluationSchema.parse({ submissionId, status });
  const update: Partial<Evaluation> = {};
  let next: Status;
  const decision = review.decision;

  if (
    (status === "needs_attention" || status === "error") &&
    (decision === "requeue" || (decision === "attach" && status === "needs_attention"))
  ) {
    next = evaluation.gate?.status === "pass" ? "scoring" : "queued";
    update.error = null;
  } else if ((status === "gate_review" || status === "disqualified") && decision === "reinstate") {
    next = "scoring";
    // Record the human's gate decision itself, so later requeues (retry, attach) never re-gate and re-disqualify.
    const gate = evaluation.gate ?? GateResultSchema.parse({ status: "pass" });
    update.gate = {
      ...gate,
      status: "pass",
      reasons: [...gate.reasons, `reinstated by ${review.reviewer}`],
      feedbackMd: null,
    };
  } else if ((status === "gate_review" || status === "needs_review") && decision === "disqualify") {
    next = "disqualified";
  } else if (status === "needs_review" && decision === "accept") {
    next = "finalized";
    update.finalScore = evaluation.autoScore;
  } else if (status === "needs_review" && decision === "override") {
    if (!evaluation.scorecard) throw new ReviewError("cannot override: the submission has no scorecard");
    const levels = levelsById(evaluation.scorecard);
    for (const [criterionId, label] of Object.entries(review.overrides ?? {})) {
      try {
        levels[criterionId] = levelIndex(criterion(rubric, criterionId), label);
      } catch (e) {
        throw new ReviewError(e instanceof Error ? e.message : String(e), 400);
      }
    }
    next = "finalized";
    update.finalScore = weightedScore(rubric, levels);
  } else {
    throw new ReviewError(`cannot apply decision '${decision}' to a submission in status '${status}'`);
  }

  q.addReview(db, submissionId, { ...review, rubricVersion: evaluation.rubricVersion });
  q.saveEvaluation(db, { ...evaluation, ...update, status: next }, status);
  return next;
}

const lastScoreReview = (reviews: HumanReview[]): HumanReview | null =>
  reviews.filter((r) => r.kind === "score").at(-1) ?? null;

/**
 * After a rubric change, a human override made under the older version cannot silently carry over:
 * one reason per overridden criterion, saying whether that criterion changed.
 */
export function overridesToRecheck(
  reviews: HumanReview[],
  rubric: Rubric,
  rubricAt: (version: string) => Rubric | null,
): string[] {
  const last = lastScoreReview(reviews);
  if (last?.decision !== "override" || !last.rubricVersion || last.rubricVersion === rubric.version)
    return [];
  const old = rubricAt(last.rubricVersion);
  return Object.keys(last.overrides).map((id) => {
    const before = old?.criteria.find((c) => c.id === id);
    const now = rubric.criteria.find((c) => c.id === id);
    return before && now && JSON.stringify(before) === JSON.stringify(now)
      ? `human override of ${id} (rubric ${last.rubricVersion}): re-confirm under rubric ${rubric.version}`
      : `human override of ${id} (rubric ${last.rubricVersion}) no longer applies: the criterion changed`;
  });
}

/** A human decided this route (under the current rubric, or an older override awaiting re-check). */
export function humanOwnsRoute(evaluation: Evaluation): boolean {
  const last = lastScoreReview(evaluation.reviews);
  if (!last) return false;
  return (
    last.rubricVersion === null ||
    last.rubricVersion === evaluation.rubricVersion ||
    last.decision === "override"
  );
}
