/** A Jev answer normalized away from the SDK's response shapes. */
import { z } from "zod";

export const JevDecisionSchema = z.object({
  questionId: z.string(),
  type: z.enum(["noul", "choice", "score"]),
  /** noul: P(yes); choice: option key; score: fractional 0-based level index. */
  value: z.union([z.number(), z.string()]),
  /** noul: yes/no; choice: per option; score: per level ("0", "1", ...). */
  probabilities: z.record(z.string(), z.number()).nullable().default(null),
  /** SDK confidence for choice/score; max(p, 1 - p) for noul. */
  confidence: z.number(),
  model: z.string(),
  requestId: z.string().nullable().default(null),
});
export type JevDecision = z.infer<typeof JevDecisionSchema>;
