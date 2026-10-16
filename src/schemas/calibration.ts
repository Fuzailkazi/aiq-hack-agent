/** Stage 3 output: Jev second opinion, confidence and route. */
import { z } from "zod";

export const CriterionCalibrationSchema = z.object({
  criterionId: z.string(),
  llmLevel: z.number().int(),
  jevScore: z.number().nullable().default(null),
  jevProbs: z.array(z.number()).nullable().default(null),
  agreement: z.number().nullable().default(null),
  sufficiency: z.number().nullable().default(null),
  levelGap: z.number().nullable().default(null),
});
export type CriterionCalibration = z.infer<typeof CriterionCalibrationSchema>;

export const RouteSchema = z.enum(["accept", "review"]);

export const CalibrationResultSchema = z.object({
  criteria: z.array(CriterionCalibrationSchema).default([]),
  autoScore: z.number(),
  confidence: z.number(),
  route: RouteSchema,
  reasons: z.array(z.string()).default([]),
  discrepancyNotes: z.array(z.string()).default([]),
  /** Prescreen + calibration Noul flags, kept so `reroute` needs no model calls. */
  flags: z.record(z.string(), z.number()).default({}),
});
export type CalibrationResult = z.infer<typeof CalibrationResultSchema>;
