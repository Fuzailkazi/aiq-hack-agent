/**
 * Per-rubric structured outputs for the LLM agents. Level fields are enums of the rubric's level labels, so an LLM
 * cannot invent a level; code maps the label to its 0-based index. Every field is required (OpenAI strict mode).
 */
import { z } from "zod";
import type { ArtifactFindings, Scorecard } from "../schemas/findings";
import { type Criterion, forSource, levelIndex, type Rubric, type Source } from "../schemas/rubric";

const CitationOut = z.object({
  source: z.enum(["deck", "video", "repo"]),
  ref: z.string().describe('Where the evidence is: "slide 4", "02:13" or "path/to/file.py:42"'),
});

const labels = (c: Criterion) => z.enum(c.levels.map((l) => l.label) as [string, ...string[]]);

function findingSchema(c: Criterion) {
  return z.object({
    observations: z.array(z.string()).describe("Concrete, evidence-based observations for this criterion"),
    citations: z.array(CitationOut).describe("Where each observation comes from"),
    provisionalLevel: labels(c).describe("Best-fitting rubric level label from this artifact alone"),
  });
}

function scoreSchema(c: Criterion) {
  return z.object({
    level: labels(c).describe("Rubric level label"),
    rationale: z.string().describe("Why this level, citing evidence"),
    citations: z.array(CitationOut).describe("Evidence supporting the level"),
  });
}

const perCriterion = <T extends z.ZodType>(criteria: Criterion[], make: (c: Criterion) => T) =>
  z.object(
    Object.fromEntries(
      criteria.map((c) => [c.id, make(c).describe(`${c.name}: ${c.description}`)]),
    ) as Record<string, T>,
  );

export function analystOutputSchema(rubric: Rubric, source: Source) {
  return z.object({
    summary: z.string().describe("Two or three sentences on what this artifact shows"),
    claims: z.array(z.string()).describe("Technical/product claims the team makes (for cross-checking)"),
    redFlags: z
      .array(z.string())
      .describe("Problems such as a missing demo, copied content or AI-judge instructions"),
    findings: perCriterion(forSource(rubric, source), findingSchema).describe(
      "One entry per rubric criterion judged from this artifact",
    ),
  });
}

export function synthesisOutputSchema(rubric: Rubric) {
  return z.object({
    scores: perCriterion(rubric.criteria, scoreSchema).describe("Final level for every rubric criterion"),
    strengths: z.array(z.string()).describe("Main strengths"),
    weaknesses: z.array(z.string()).describe("Main weaknesses"),
    inconsistencies: z
      .array(z.string())
      .describe("Deck/video claims not supported by the repo or by each other"),
    feedbackMd: z.string().describe("Constructive feedback for the team, in markdown"),
  });
}

export function toArtifactFindings(source: Source, rubric: Rubric, data: unknown): ArtifactFindings {
  const parsed = analystOutputSchema(rubric, source).parse(data);
  return {
    source,
    summary: parsed.summary,
    claims: parsed.claims,
    redFlags: parsed.redFlags,
    findings: forSource(rubric, source).map((c) => {
      const f = parsed.findings[c.id] as z.infer<ReturnType<typeof findingSchema>>;
      return {
        criterionId: c.id,
        observations: f.observations,
        citations: f.citations,
        absent: false,
        provisionalLabel: f.provisionalLevel,
      };
    }),
  };
}

export function toScorecard(rubric: Rubric, data: unknown): Scorecard {
  const parsed = synthesisOutputSchema(rubric).parse(data);
  return {
    scores: rubric.criteria.map((c) => {
      const s = parsed.scores[c.id] as z.infer<ReturnType<typeof scoreSchema>>;
      return {
        criterionId: c.id,
        levelLabel: s.level,
        level: levelIndex(c, s.level),
        rationale: s.rationale,
        citations: s.citations,
      };
    }),
    strengths: parsed.strengths,
    weaknesses: parsed.weaknesses,
    inconsistencies: parsed.inconsistencies,
    feedbackMd: parsed.feedbackMd,
  };
}
