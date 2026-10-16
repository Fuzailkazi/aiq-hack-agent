/** Stage 1b: Jev prescreen flags. They never disqualify; they feed routing. */
import type { JevClient } from "../jev/client";
import { prescreenQuestions, prescreenState, TRACK_FIT } from "../jev/prescreenQuestions";
import { type PrescreenResult, PrescreenResultSchema } from "../schemas/evaluation";
import type { MediaDigest } from "../schemas/evidence";
import type { Rubric } from "../schemas/rubric";
import type { Submission } from "../schemas/submission";

export async function prescreen(
  sub: Submission,
  media: MediaDigest,
  /** null when no second opinion is configured: no flags are raised. */
  jev: JevClient | null,
  rubric: Rubric,
): Promise<PrescreenResult> {
  const questions = prescreenQuestions(media, rubric.tracks);
  if (!jev || !Object.keys(questions).length) return PrescreenResultSchema.parse({});
  const decisions = await jev.decide(prescreenState(sub, media), questions);
  const flags = Object.fromEntries(
    Object.entries(decisions)
      .filter(([, d]) => d.type === "noul")
      .map(([id, d]) => [id, Number(d.value)]),
  );
  const track = decisions[TRACK_FIT];
  return { flags, trackFit: track ? String(track.value) : null, jev: Object.values(decisions) };
}
