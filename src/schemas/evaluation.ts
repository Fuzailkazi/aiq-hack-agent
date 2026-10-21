/** Per-submission evaluation record and stage results. */
import { z } from "zod";
import { CalibrationResultSchema } from "./calibration";
import { ArmorIQEvidenceSchema, MediaDigestSchema, RepoSnapshotSchema } from "./evidence";
import { ArtifactFindingsSchema, ScorecardSchema } from "./findings";
import { JevDecisionSchema } from "./jev";
import { Timestamp } from "./submission";

export const StatusSchema = z.enum([
  "queued",
  "needs_attention",
  "disqualified",
  "gate_review",
  "scoring",
  "needs_review",
  "finalized",
  "stale",
  "superseded",
  "error",
]);
export type Status = z.infer<typeof StatusSchema>;

export const GateStatusSchema = z.enum(["pass", "fail", "review", "needs_attention"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GateResultSchema = z.object({
  status: GateStatusSchema,
  checks: z.record(z.string(), z.boolean()).default({}),
  reasons: z.array(z.string()).default([]),
  /** Carried to scoring-phase routing, e.g. commits after the deadline. */
  flags: z.array(z.string()).default([]),
  jev: z.array(JevDecisionSchema).default([]),
  feedbackMd: z.string().nullable().default(null),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const PrescreenResultSchema = z.object({
  flags: z.record(z.string(), z.number()).default({}),
  trackFit: z.string().nullable().default(null),
  jev: z.array(JevDecisionSchema).default([]),
});
export type PrescreenResult = z.infer<typeof PrescreenResultSchema>;

export const HumanReviewSchema = z.object({
  reviewer: z.string(),
  kind: z.enum(["gate", "score", "attention"]),
  decision: z.enum(["accept", "override", "disqualify", "reinstate", "attach", "requeue"]),
  /** criterionId -> level label */
  overrides: z.record(z.string(), z.string()).default({}),
  notes: z.string().default(""),
  at: Timestamp,
  /** The rubric version the reviewed evaluation was scored under (set when the review is recorded). */
  rubricVersion: z.string().nullable().default(null),
});
export type HumanReview = z.infer<typeof HumanReviewSchema>;
/** What callers pass in: defaults (overrides, notes, rubricVersion) are filled when the review is recorded. */
export type HumanReviewInput = z.input<typeof HumanReviewSchema>;

export const UsageSchema = z.object({
  llmCalls: z.number().int().default(0),
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  jevCalls: z.number().int().default(0),
  /** LLM calls and tokens per model id (for pricing). */
  byModel: z
    .record(
      z.string(),
      z.object({ calls: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int() }),
    )
    .default({}),
});
export type Usage = z.infer<typeof UsageSchema>;

export const EvaluationSchema = z.object({
  submissionId: z.string(),
  status: StatusSchema,
  rubricId: z.string().nullable().default(null),
  rubricVersion: z.string().nullable().default(null),
  repo: RepoSnapshotSchema.nullable().default(null),
  evidence: ArmorIQEvidenceSchema.nullable().default(null),
  gate: GateResultSchema.nullable().default(null),
  mediaUnreachable: z.record(z.string(), z.string()).default({}),
  /** What the score could not take into account (a video that could not be watched, a step that failed). */
  warnings: z.array(z.string()).default([]),
  /** The deck/video digest the agents saw (slide text, image paths, transcript); the UI's evidence viewer. */
  media: MediaDigestSchema.nullable().default(null),
  prescreen: PrescreenResultSchema.nullable().default(null),
  findings: z.array(ArtifactFindingsSchema).default([]),
  scorecard: ScorecardSchema.nullable().default(null),
  calibration: CalibrationResultSchema.nullable().default(null),
  reviews: z.array(HumanReviewSchema).default([]),
  usage: UsageSchema.default({ llmCalls: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, byModel: {} }),
  autoScore: z.number().nullable().default(null),
  finalScore: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;
