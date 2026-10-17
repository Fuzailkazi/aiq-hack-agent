/** Request/response contracts for the HTTP API (also the source of the OpenAPI document and the UI's types). */
import { z } from "zod";
import { CalibrationResultSchema } from "../schemas/calibration";
import { EvaluationSchema, StatusSchema, UsageSchema } from "../schemas/evaluation";
import { RubricSchema } from "../schemas/rubric";
import { SubmissionSchema } from "../schemas/submission";

export const ErrorSchema = z.object({ error: z.string(), issues: z.array(z.unknown()).optional() });

export const HackathonSchema = z.object({
  id: z.string(),
  name: z.string(),
  deadline: z.string().nullable(),
  activeRubricId: z.string().nullable(),
  activeRubricVersion: z.string().nullable(),
});

export const CreateHackathonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][\w-]{0,63}$/, "letters, digits, '-' and '_' (max 64)"),
  name: z.string().min(1).max(200).optional(),
  deadline: z.string().nullable().optional(),
});

export const UsageReportSchema = z.object({
  submissions: z.number(),
  usage: UsageSchema,
  estimatedCostUsd: z.number().nullable(),
  costPerSubmissionUsd: z.number().nullable(),
  unpriced: z.array(z.string()),
});

export const HackathonDetailSchema = z.object({
  hackathon: HackathonSchema,
  rubric: RubricSchema.nullable(),
  byStatus: z.record(z.string(), z.number()),
  usage: UsageReportSchema,
});

export const RubricUploadSchema = z.object({ yaml: z.string().min(1).max(200_000) });
export const RubricActivatedSchema = z.object({ id: z.string(), version: z.string(), staled: z.number() });

export const ImportReportSchema = z.object({
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  ignoredLate: z.number(),
  ignoredOlder: z.number(),
  errors: z.array(z.string()),
  late: z.array(z.string()),
});

export const AddOutcomeSchema = z.object({ outcome: z.string() });

export const CheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["pass", "fail", "warn", "pending"]),
  detail: z.string(),
});

export const SubmissionRowSchema = z.object({
  id: z.string(),
  teamName: z.string(),
  /** The project's name from the form, when the intake maps one. */
  projectName: z.string().nullable(),
  repoUrl: z.string(),
  track: z.string().nullable(),
  status: StatusSchema,
  /** Why the submission is in this status (disqualified, needs attention, error, ...); empty otherwise. */
  reasons: z.array(z.string()),
  checks: z.array(CheckSchema),
  autoScore: z.number().nullable(),
  finalScore: z.number().nullable(),
  confidence: z.number().nullable(),
});

export const SubmissionDetailSchema = z.object({
  submission: SubmissionSchema,
  status: StatusSchema,
  reasons: z.array(z.string()),
  checks: z.array(CheckSchema),
  evaluation: EvaluationSchema.nullable(),
  /** Echoed for convenience: the calibration's per-criterion view drives the scorecard table. */
  calibration: CalibrationResultSchema.nullable(),
});

export const QueueItemSchema = z.object({
  id: z.string(),
  teamName: z.string(),
  status: StatusSchema,
  reasons: z.array(z.string()),
});

export const DecisionSchema = z.object({
  decision: z.enum(["accept", "override", "disqualify", "reinstate", "requeue"]),
  reviewer: z.string().min(1).max(100),
  notes: z.string().max(5000).optional(),
  overrides: z.record(z.string(), z.string()).optional(),
});

export const TransitionSchema = z.object({ from: StatusSchema, to: StatusSchema });

export const StartRunSchema = z.object({
  phase: z.enum(["gate", "score", "all"]).optional(),
  only: z.array(z.string()).optional(),
  limit: z.number().int().min(1).optional(),
  retry: z.boolean().optional(),
});

export const RunJobSchema = z.object({
  id: z.string(),
  hackathonId: z.string(),
  state: z.enum(["running", "done", "failed"]),
  report: z
    .object({
      byStatus: z.record(z.string(), z.number()),
      errors: z.array(z.string()),
      skipped: z.array(z.string()),
      processed: z.number(),
    })
    .nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const LeaderboardRowSchema = z.object({
  rank: z.number(),
  track: z.string().nullable(),
  submissionId: z.string(),
  teamName: z.string(),
  finalScore: z.number(),
  autoScore: z.number().nullable(),
  overridden: z.boolean(),
});

export const HidParams = z.object({ hid: z.string() });
export const IdParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export const MediaParams = IdParams.extend({ index: z.coerce.number().int().min(0) });
