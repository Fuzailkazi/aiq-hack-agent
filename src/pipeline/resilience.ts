/**
 * Scoring that degrades instead of stopping. A step that fails on our side (a video that cannot be fetched, a model
 * quota, an outage) is recorded as unavailable; the team is still scored from everything else, criteria with no
 * usable source are left out of the score, and every gap becomes a plain-language warning for the judge.
 */
import type { ArtifactFindings, Scorecard } from "../schemas/findings";
import { forSource, type Rubric, type Source } from "../schemas/rubric";

const SOURCE_NAME: Record<Source, string> = {
  repo: "Code and ArmorIQ integration",
  form: "Form answers and live demo",
  deck: "Pitch deck",
  video: "Demo video",
};

/** A failure in a few words a judge understands. */
export function shortCause(message: string): string {
  if (/exceeded your current quota|billing|retry in \d+h/i.test(message))
    return "the Gemini quota is used up";
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(message)) return "Gemini rate limit";
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message))
    return "the connection to Gemini dropped";
  if (/\b50[234]\b|UNAVAILABLE|high demand|overloaded/i.test(message)) return "Gemini was overloaded";
  return message.replace(/^Error:\s*/, "").slice(0, 160);
}

/** Findings for an artifact we could not analyze: every criterion it feeds has no observation from it. */
export function unavailableFindings(rubric: Rubric, source: Source, reason: string): ArtifactFindings {
  return {
    source,
    summary: `${SOURCE_NAME[source]} could not be analyzed: ${reason}.`,
    findings: forSource(rubric, source).map((c) => ({
      criterionId: c.id,
      observations: [],
      citations: [],
      absent: false,
      provisionalLabel: null,
    })),
    claims: [],
    redFlags: [],
    unavailable: reason,
  };
}

const usable = (f: ArtifactFindings | undefined): f is ArtifactFindings => !!f && f.unavailable === null;

/** Criteria none of whose sources could be analyzed. */
export function unjudgeable(rubric: Rubric, findings: ArtifactFindings[]): Set<string> {
  const bySource = new Map(findings.map((f) => [f.source, f]));
  return new Set(
    rubric.criteria.filter((c) => !c.sources.some((s) => usable(bySource.get(s)))).map((c) => c.id),
  );
}

/**
 * When the final synthesis cannot run, each criterion takes the level its analysts already chose (first usable
 * source in the criterion's order); criteria with none are marked not assessed.
 */
export function fallbackScorecard(rubric: Rubric, findings: ArtifactFindings[]): Scorecard {
  const bySource = new Map(findings.map((f) => [f.source, f]));
  return {
    scores: rubric.criteria.map((c) => {
      for (const s of c.sources) {
        const f = bySource.get(s);
        if (!usable(f)) continue;
        const own = f.findings.find((x) => x.criterionId === c.id);
        const label = own?.absent ? c.levels[0].label : own?.provisionalLabel;
        const level = label ? c.levels.findIndex((l) => l.label === label) : -1;
        if (level >= 0)
          return {
            criterionId: c.id,
            levelLabel: c.levels[level].label,
            level,
            rationale: own?.absent
              ? `Not submitted (${SOURCE_NAME[s].toLowerCase()}).`
              : `From the ${SOURCE_NAME[s].toLowerCase()} review: ${own?.observations.slice(0, 2).join(" ") || "no detail recorded"}`,
            citations: own?.citations ?? [],
            notAssessed: false,
          };
      }
      return notAssessedScore(rubric, c.id);
    }),
    strengths: [],
    weaknesses: [],
    inconsistencies: [],
    feedbackMd: "",
  };
}

function notAssessedScore(rubric: Rubric, criterionId: string) {
  const c = rubric.criteria.find((x) => x.id === criterionId);
  if (!c) throw new Error(`rubric has no criterion '${criterionId}'`);
  return {
    criterionId,
    levelLabel: c.levels[0].label,
    level: 0,
    rationale: `Not judged: ${c.sources.map((s) => SOURCE_NAME[s].toLowerCase()).join(" and ")} could not be analyzed. Left out of the score until the team is re-scored.`,
    citations: [],
    notAssessed: true,
  };
}

/** Marks criteria with no usable source as not assessed (whatever level the synthesis picked). */
export function markNotAssessed(rubric: Rubric, card: Scorecard, findings: ArtifactFindings[]): Scorecard {
  const skip = unjudgeable(rubric, findings);
  return {
    ...card,
    scores: card.scores.map((s) => (skip.has(s.criterionId) ? notAssessedScore(rubric, s.criterionId) : s)),
  };
}

/** Plain-language warnings for the judge: what could not be looked at, and what that does to the score. */
export function scoringWarnings(
  rubric: Rubric,
  findings: ArtifactFindings[],
  card: Scorecard,
  synthesisError: string | null,
): string[] {
  const warnings = findings
    .filter((f) => f.unavailable !== null)
    .map((f) =>
      f.source === "video"
        ? `Video not watched: ${f.unavailable}.`
        : `${SOURCE_NAME[f.source]} not analyzed: ${f.unavailable}.`,
    );
  if (synthesisError)
    warnings.push(
      `Final AI review did not run (${synthesisError}); levels come from the individual reviews and there is no written feedback.`,
    );
  const skipped = card.scores.filter((s) => s.notAssessed);
  if (skipped.length) {
    const names = skipped.map(
      (s) => rubric.criteria.find((c) => c.id === s.criterionId)?.name ?? s.criterionId,
    );
    warnings.push(
      `Not judged: ${names.join(", ")}. The score covers the other criteria only and is provisional; press Score this team to retry.`,
    );
  }
  return warnings;
}
