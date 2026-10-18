/** What the ADK analyst agents and synthesis produce. */
import { z } from "zod";
import { SourceSchema } from "./rubric";

export const CitationSchema = z.object({
  source: SourceSchema,
  /** "slide 4" | "02:13-02:41" | "src/agent.py:42" */
  ref: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const CriterionFindingSchema = z.object({
  criterionId: z.string(),
  observations: z.array(z.string()).default([]),
  citations: z.array(CitationSchema).default([]),
  /** The artifact needed for this criterion was not submitted. */
  absent: z.boolean().default(false),
  /** The analyst's level from this artifact alone. */
  provisionalLabel: z.string().nullable().default(null),
});
export type CriterionFinding = z.infer<typeof CriterionFindingSchema>;

export const ArtifactFindingsSchema = z.object({
  source: SourceSchema,
  summary: z.string(),
  findings: z.array(CriterionFindingSchema).default([]),
  claims: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
  /**
   * Set when this artifact could not be analyzed because of our side (download failed, model quota, outage), as
   * opposed to the team not submitting it. Its criteria are judged from other sources, or left out of the score.
   */
  unavailable: z.string().nullable().default(null),
});
export type ArtifactFindings = z.infer<typeof ArtifactFindingsSchema>;

export const CriterionScoreSchema = z.object({
  criterionId: z.string(),
  /** What the LLM outputs. */
  levelLabel: z.string(),
  /** 0-based index, mapped from levelLabel in code. */
  level: z.number().int(),
  rationale: z.string(),
  citations: z.array(CitationSchema).default([]),
  /** No source for this criterion could be analyzed: excluded from the score until the team is re-scored. */
  notAssessed: z.boolean().default(false),
});
export type CriterionScore = z.infer<typeof CriterionScoreSchema>;

export const ScorecardSchema = z.object({
  scores: z.array(CriterionScoreSchema),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  inconsistencies: z.array(z.string()).default([]),
  feedbackMd: z.string().default(""),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

export const levelsById = (card: Scorecard): Record<string, number> =>
  Object.fromEntries(card.scores.map((s) => [s.criterionId, s.level]));
