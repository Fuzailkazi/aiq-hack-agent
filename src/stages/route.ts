/** Routing math (design §3.5): pure functions over stored calibration data, so re-routing needs no model calls. */
import type { RoutingPolicy } from "../config";
import type { CriterionCalibration } from "../schemas/calibration";
import type { Rubric } from "../schemas/rubric";

const DEADLINE_FLAG = "after the deadline";

export interface RouteDecision {
  route: "accept" | "review";
  confidence: number;
  reasons: string[];
  notes: string[];
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Jev probability mass within ±tolerance of the LLM level; a distance-based fallback without probabilities. */
export function criterionAgreement(
  probs: number[] | null,
  jevScore: number | null,
  llmLevel: number,
  tolerance: number,
  maxGap: number,
): number | null {
  if (probs?.length)
    return round4(
      probs.reduce((sum, p, level) => (Math.abs(level - llmLevel) <= tolerance ? sum + p : sum), 0),
    );
  if (jevScore === null) return null;
  return round4(Math.max(0, 1 - Math.abs(jevScore - llmLevel) / (maxGap + 1)));
}

/** Re-derive agreement and gap from stored Jev outputs under a (possibly changed) policy. */
export function recompute(criteria: CriterionCalibration[], policy: RoutingPolicy): CriterionCalibration[] {
  return criteria.map((c) => ({
    ...c,
    agreement: criterionAgreement(
      c.jevProbs,
      c.jevScore,
      c.llmLevel,
      policy.levelTolerance,
      policy.maxLevelGap,
    ),
    levelGap: c.jevScore === null ? null : Math.abs(c.jevScore - c.llmLevel),
  }));
}

export function decideRoute(
  criteria: CriterionCalibration[],
  rubric: Rubric,
  policy: RoutingPolicy,
  flags: Record<string, number>,
  gateFlags: string[],
): RouteDecision {
  const weight = new Map(rubric.criteria.map((c) => [c.id, c.weight]));
  const scored = criteria.filter((c) => c.agreement !== null);
  const total = scored.reduce((s, c) => s + (weight.get(c.criterionId) ?? 0), 0);
  const confidence = total
    ? round4(scored.reduce((s, c) => s + (weight.get(c.criterionId) ?? 0) * (c.agreement ?? 0), 0) / total)
    : 0;

  const reasons: string[] = [];
  const notes: string[] = [];
  if (confidence < policy.autoAcceptConfidence) {
    reasons.push(`confidence ${confidence.toFixed(2)} is below ${policy.autoAcceptConfidence.toFixed(2)}`);
  }
  for (const c of criteria) {
    const fired: string[] = [];
    if (c.agreement === null) fired.push("no Jev second opinion");
    else {
      if (c.agreement < policy.minCriterionAgreement)
        fired.push(`agreement ${c.agreement.toFixed(2)} < ${policy.minCriterionAgreement.toFixed(2)}`);
      if (c.levelGap !== null && c.levelGap > policy.maxLevelGap)
        fired.push(`level gap ${c.levelGap.toFixed(2)} > ${policy.maxLevelGap}`);
    }
    if (c.sufficiency !== null && c.sufficiency < policy.minSufficiency) {
      fired.push(`evidence sufficiency ${c.sufficiency.toFixed(2)} < ${policy.minSufficiency.toFixed(2)}`);
    }
    if (fired.length) {
      reasons.push(`${c.criterionId}: ${fired.join("; ")}`);
      notes.push(note(c));
    }
  }
  for (const rule of policy.flagRules) {
    const value = flags[rule.flag];
    if (value !== undefined && (rule.op === "ge" ? value >= rule.threshold : value <= rule.threshold)) {
      reasons.push(`flag ${rule.flag} = ${value.toFixed(2)}`);
    }
  }
  for (const flag of gateFlags) {
    if (flag.includes(DEADLINE_FLAG) && policy.reviewOnCommitsAfterDeadline) reasons.push(`gate: ${flag}`);
  }
  return { route: reasons.length ? "review" : "accept", confidence, reasons, notes };
}

function note(c: CriterionCalibration): string {
  let jev = c.jevScore === null ? "Jev unavailable" : `Jev expected level ${c.jevScore.toFixed(2)}`;
  if (c.jevProbs?.length) jev += ` (${c.jevProbs.map((p, i) => `L${i}=${p.toFixed(2)}`).join(", ")})`;
  const sufficiency = c.sufficiency === null ? "" : `; sufficiency ${c.sufficiency.toFixed(2)}`;
  return `${c.criterionId}: LLM level ${c.llmLevel} vs ${jev}${sufficiency}`;
}
