/** Stage 3: Jev calibration over raw evidence, then routing. Jev calibrates; the LLM's levels stay the score of record. */
import type { RoutingPolicy } from "../config";
import {
  CLAIMS_UNSUPPORTED,
  claimsQuestions,
  claimsState,
  criterionQuestions,
  criterionState,
  SCORE,
  SUFFICIENT,
} from "../jev/calibrationQuestions";
import type { JevClient } from "../jev/client";
import type { CalibrationResult, CriterionCalibration } from "../schemas/calibration";
import type { PrescreenResult } from "../schemas/evaluation";
import type { ArmorIQEvidence, MediaDigest } from "../schemas/evidence";
import { levelsById, type Scorecard } from "../schemas/findings";
import type { JevDecision } from "../schemas/jev";
import { applyPenalties, assessPenalties } from "../penalties";
import { type Criterion, type Rubric, weightedScore } from "../schemas/rubric";
import type { Submission } from "../schemas/submission";
import { decideRoute, recompute } from "./route";

export interface CalibrateDeps {
  rubric: Rubric;
  policy: RoutingPolicy;
  /** null when no second opinion is configured: the LLM score stands and every result goes to a human. */
  jev: JevClient | null;
}

export const NO_SECOND_OPINION = "no second opinion is configured, so a judge confirms every score";

const noOpinion = (criterionId: string, llmLevel: number): CriterionCalibration => ({
  criterionId,
  llmLevel,
  jevScore: null,
  jevProbs: null,
  agreement: null,
  sufficiency: null,
  levelGap: null,
});

function probsArray(d: JevDecision, levels: number): number[] {
  return Array.from({ length: levels }, (_, i) => d.probabilities?.[String(i)] ?? 0);
}

async function secondOpinion(
  c: Criterion,
  llmLevel: number,
  media: MediaDigest,
  evidence: ArmorIQEvidence | null,
  card: Scorecard,
  jev: JevClient,
): Promise<CriterionCalibration> {
  const answers = await jev.decide(criterionState(c, media, evidence, card), criterionQuestions(c));
  const s = answers[SCORE];
  const sufficient = answers[SUFFICIENT];
  return {
    criterionId: c.id,
    llmLevel,
    jevScore: s ? Number(s.value) : null,
    jevProbs: s ? probsArray(s, c.levels.length) : null,
    agreement: null,
    sufficiency: sufficient ? Number(sufficient.value) : null,
    levelGap: null,
  };
}

export async function calibrate(
  sub: Submission,
  card: Scorecard,
  media: MediaDigest,
  prescreen: PrescreenResult,
  evidence: ArmorIQEvidence | null,
  gateFlags: string[],
  { rubric, policy, jev }: CalibrateDeps,
): Promise<CalibrationResult> {
  const levels = levelsById(card);
  const rubricScore = weightedScore(rubric, levels);
  const penalties = assessPenalties(rubric, sub, media, evidence);
  const autoScore = applyPenalties(rubricScore, penalties);
  if (!jev) {
    // The route rules send every criterion without a second opinion to review, so this always lands with a human.
    const criteria = recompute(
      rubric.criteria.map((c) => noOpinion(c.id, levels[c.id])),
      policy,
    );
    const flags = { ...prescreen.flags };
    const decision = decideRoute(criteria, rubric, policy, flags, gateFlags);
    return {
      criteria,
      rubricScore,
      penalties,
      autoScore,
      confidence: decision.confidence,
      route: decision.route,
      reasons: [NO_SECOND_OPINION, ...decision.reasons],
      discrepancyNotes: decision.notes,
      flags,
    };
  }
  const [opinions, claims] = await Promise.all([
    Promise.allSettled(
      rubric.criteria.map((c) => secondOpinion(c, levels[c.id], media, evidence, card, jev)),
    ),
    jev.decide(claimsState(media, evidence), claimsQuestions()).catch(() => null),
  ]);
  // Every criterion failing means Jev is down: raise so the run can be retried, instead of flooding review.
  const failed = opinions.filter((o) => o.status === "rejected");
  if (failed.length === opinions.length && failed[0]) throw (failed[0] as PromiseRejectedResult).reason;

  const raw = opinions.map((o, i) =>
    o.status === "fulfilled" ? o.value : noOpinion(rubric.criteria[i].id, levels[rubric.criteria[i].id]),
  );
  const criteria = recompute(raw, policy);
  const flags = { ...prescreen.flags };
  const claimed = claims?.[CLAIMS_UNSUPPORTED];
  if (claimed) flags[CLAIMS_UNSUPPORTED] = Number(claimed.value);

  const decision = decideRoute(criteria, rubric, policy, flags, gateFlags);
  return {
    criteria,
    rubricScore,
    penalties,
    autoScore,
    confidence: decision.confidence,
    route: decision.route,
    reasons: decision.reasons,
    discrepancyNotes: decision.notes,
    flags,
  };
}
