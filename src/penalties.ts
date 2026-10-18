/**
 * Point deductions for submission requirements a team did not meet. The rubric judges quality; these cut fixed
 * points for things the form asked for that are simply missing, so every deduction is explicit and explainable.
 * Pure: decided from the form answers, the media digest and the repo scan, never by a model.
 */
import type { ArmorIQEvidence, MediaDigest } from "./schemas/evidence";
import type { PenaltyRule, Rubric } from "./schemas/rubric";
import type { Submission } from "./schemas/submission";

export interface Penalty {
  id: PenaltyRule["id"];
  label: string;
  points: number;
  /** What was found, in plain words. */
  detail: string;
}

/** The brief asks for 3 to 5 minutes; a little grace either side absorbs intros and outros. */
export const VIDEO_MIN_S = 180;
export const VIDEO_MAX_S = 300;
const GRACE_S = 15;

const yes = (v: string | undefined) => /^\s*yes\b/i.test(v ?? "");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const DEFAULT_LABEL: Record<PenaltyRule["id"], string> = {
  social_post: "No X or LinkedIn post",
  hashtag: "#FlowStateHackathon not confirmed",
  video_length: "Video outside 3 to 5 minutes",
  elevenlabs_code: "ElevenLabs claimed but not in the code",
  live_demo: "No working live demo URL",
};

/** Which rule a submission breaks, with the evidence; null when the requirement is met or cannot be judged yet. */
function broken(
  id: PenaltyRule["id"],
  sub: Submission,
  media: MediaDigest | null,
  evidence: ArmorIQEvidence | null,
): string | null {
  const a = sub.answers;
  switch (id) {
    case "social_post":
      return a.xPost || a.linkedinPost ? null : "the form has no X or LinkedIn post link";
    case "hashtag":
      // Only when there is a post: a missing post is already its own deduction.
      return (a.xPost || a.linkedinPost) && !yes(a.hashtag) ? "the team did not confirm the hashtag" : null;
    case "video_length": {
      const d = media?.video?.durationS ?? 0;
      if (!(d > 0)) return null; // length unknown: no deduction on a guess
      if (d < VIDEO_MIN_S - GRACE_S) return `the video is ${mmss(d)} long (under 3 minutes)`;
      if (d > VIDEO_MAX_S + GRACE_S) return `the video is ${mmss(d)} long (over 5 minutes)`;
      return null;
    }
    case "elevenlabs_code": {
      if (sub.track !== "elevenlabs") return null;
      const found = evidence?.partners.elevenlabs;
      return found !== undefined && found.length === 0
        ? "the team entered the ElevenLabs track, but no ElevenLabs SDK or API call is in the repo"
        : null;
    }
    case "live_demo": {
      if (!sub.liveDemoUrl) return "no live demo URL was submitted";
      const demo = media?.liveDemo;
      return demo && !demo.reachable ? `the live demo did not load (${demo.error ?? "no response"})` : null;
    }
  }
}

export function assessPenalties(
  rubric: Rubric,
  sub: Submission,
  media: MediaDigest | null,
  evidence: ArmorIQEvidence | null,
): Penalty[] {
  const out: Penalty[] = [];
  for (const rule of rubric.penalties) {
    const detail = broken(rule.id, sub, media, evidence);
    if (detail) out.push({ id: rule.id, label: rule.label ?? DEFAULT_LABEL[rule.id], points: rule.points, detail });
  }
  return out;
}

/** Rubric score minus deductions, never below zero, rounded like weightedScore. */
export const applyPenalties = (rubricScore: number, penalties: { points: number }[]): number =>
  Math.max(0, Math.round(100 * (rubricScore - penalties.reduce((sum, p) => sum + p.points, 0))) / 100);
