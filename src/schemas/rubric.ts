/** Judging rubric. The organizer's rubric file must validate against these schemas. */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Artifacts a criterion can be judged from. "form" is the team's written answers plus the live demo check. */
export const SourceSchema = z.enum(["deck", "video", "repo", "form"]);
export type Source = z.infer<typeof SourceSchema>;

const slug = z.string().regex(/^[a-z][a-z0-9_]*$/, "must be a lowercase slug (a-z, 0-9, _)");

export const RubricLevelSchema = z.object({
  label: z.string().min(1),
  /** Observable description; used verbatim in the LLM rubric and as Jev Score criteria. */
  description: z.string().min(1),
});

export const CriterionSchema = z
  .object({
    id: slug,
    name: z.string(),
    description: z.string(),
    weight: z.number().positive(),
    /** Which artifacts this criterion is judged from (and therefore which analysts see it). */
    sources: z.array(SourceSchema).min(1),
    /** Ordered lowest to highest; Jev Score supports 2-10 levels. */
    levels: z.array(RubricLevelSchema).min(2).max(10),
  })
  .superRefine((c, ctx) => {
    const labels = c.levels.map((l) => l.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate level labels: ${labels.join(", ")}`,
        path: ["levels"],
      });
    }
  });
export type Criterion = z.infer<typeof CriterionSchema>;

/** A fixed deduction for a missing submission requirement (see src/penalties.ts for what each id checks). */
export const PenaltyRuleSchema = z.object({
  id: z.enum(["social_post", "hashtag", "video_length", "elevenlabs_code", "live_demo"]),
  points: z.number().positive().max(100),
  label: z.string().optional(),
});
export type PenaltyRule = z.infer<typeof PenaltyRuleSchema>;

export const RubricSchema = z
  .object({
    id: slug,
    version: z.string().min(1),
    criteria: z.array(CriterionSchema).min(1),
    tracks: z.array(z.string()).default([]),
    /** Points cut from the 0-100 score for requirements the team did not meet. */
    penalties: z.array(PenaltyRuleSchema).default([]),
  })
  .superRefine((r, ctx) => {
    const ids = r.criteria.map((c) => c.id);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
    if (dupes.length)
      ctx.addIssue({ code: "custom", message: `duplicate criterion ids: ${dupes.join(", ")}` });
  });
export type Rubric = z.infer<typeof RubricSchema>;

export const maxIndex = (c: Criterion): number => c.levels.length - 1;

export function levelIndex(c: Criterion, label: string): number {
  const i = c.levels.findIndex((l) => l.label === label);
  if (i < 0) throw new Error(`criterion '${c.id}' has no level '${label}'`);
  return i;
}

export function criterion(rubric: Rubric, id: string): Criterion {
  const c = rubric.criteria.find((x) => x.id === id);
  if (!c) throw new Error(`rubric has no criterion '${id}'`);
  return c;
}

export const forSource = (rubric: Rubric, source: Source): Criterion[] =>
  rubric.criteria.filter((c) => c.sources.includes(source));

export const hasRepoCriteria = (rubric: Rubric): boolean => forSource(rubric, "repo").length > 0;

/** 0-100 score from level indices (0 = lowest), rounded to 2 decimals. Every criterion must be present. */
export function weightedScore(rubric: Rubric, levels: Record<string, number>): number {
  const missing = rubric.criteria.filter((c) => !(c.id in levels)).map((c) => c.id);
  if (missing.length) throw new Error(`missing levels for ${missing.join(", ")}`);
  let total = 0;
  for (const c of rubric.criteria) {
    const level = levels[c.id];
    if (level < 0 || level > maxIndex(c))
      throw new Error(`level ${level} out of range for '${c.id}' (0..${maxIndex(c)})`);
    total += (c.weight * level) / maxIndex(c);
  }
  const weights = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  return Math.round((10000 * total) / weights) / 100;
}

/**
 * 0-100 score over only the criteria in `include` (the ones that could be judged), renormalized by their weights.
 * Throws when nothing could be judged.
 */
export function partialWeightedScore(
  rubric: Rubric,
  levels: Record<string, number>,
  include: Set<string>,
): number {
  const judged = rubric.criteria.filter((c) => include.has(c.id));
  if (!judged.length) throw new Error("no criterion could be judged");
  let total = 0;
  for (const c of judged) total += (c.weight * levels[c.id]) / maxIndex(c);
  const weights = judged.reduce((sum, c) => sum + c.weight, 0);
  return Math.round((10000 * total) / weights) / 100;
}

export function loadRubric(path: string): Rubric {
  return RubricSchema.parse(parseYaml(readFileSync(path, "utf8")));
}
