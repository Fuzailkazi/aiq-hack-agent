/** Organizer operations shared by the CLI and the HTTP API (one implementation, two front ends). */
import { REVIEW_KIND, resolveReview } from "./review";
import type { Evaluation, HumanReview, Status } from "./schemas/evaluation";
import type { Submission } from "./schemas/submission";
import { NO_SECOND_OPINION } from "./stages/calibrate";
import type { DB } from "./store/db";
import * as q from "./store/queries";

export const REVIEWABLE: Status[] = ["gate_review", "needs_review", "needs_attention", "error"];

export interface QueueItem {
  id: string;
  teamName: string;
  status: Status;
  reasons: string[];
}

/** A run failure in plain words; scoring infrastructure problems are not the team's fault and say so. */
export function describeError(error: string | null): string {
  const raw = (error ?? "").replace(/^Error:\s*/, "");
  if (!raw) return "Scoring failed for an unknown reason. Run scoring again.";
  if (/exceeded your current quota|billing|Google says retry in \d+h/i.test(raw)) {
    const resets = /Google says retry in (\d+h)/.exec(raw)?.[1];
    return `Not scored yet: the Gemini key's quota is used up (the free tier allows only 20 requests per model per day${resets ? `; it resets in about ${resets}` : ""}). Enable billing on the Google Cloud project, or run scoring again after the reset; finished steps are kept.`;
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(raw))
    return "Not scored yet: the Gemini rate limit was reached. Run scoring again; finished steps are kept.";
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(raw))
    return "Not scored yet: the connection to Gemini dropped. Run scoring again; finished steps are kept.";
  if (/\b50[234]\b|UNAVAILABLE|high demand|overloaded/i.test(raw))
    return "Not scored yet: Gemini was overloaded. Run scoring again; finished steps are kept.";
  if (/API key/i.test(raw))
    return "Not scored yet: no Gemini API key is configured (GOOGLE_API_KEY in .env).";
  return `Scoring failed: ${raw}`;
}

/**
 * Why a submission is in its status, in plain words: why it was disqualified, why it needs attention or review,
 * or what failed. Empty for statuses that need no explanation (queued, scoring, finalized, ...).
 */
export function statusReasons(status: Status, ev: Evaluation | null): string[] {
  if (!ev) return [];
  if (status === "error") return [describeError(ev.error)];
  if (status === "disqualified") {
    const human = ev.reviews.findLast((r) => r.decision === "disqualify");
    if (human) return [`disqualified by ${human.reviewer}${human.notes ? `: ${human.notes}` : ""}`];
    return ev.gate?.reasons.length ? ev.gate.reasons : ["failed the ArmorIQ SDK gate"];
  }
  if (status === "needs_attention") {
    const unreachable = Object.entries(ev.mediaUnreachable).map(([k, v]) => `${k}: ${v}`);
    if (unreachable.length) return unreachable;
    return ev.gate?.reasons ?? [];
  }
  if (status === "gate_review") return ev.gate?.reasons ?? [];
  if (status === "needs_review") return reviewReasons(ev.calibration?.reasons ?? []);
  return [];
}

/**
 * Review reasons without the noise of a run that has no second opinion: every criterion then "has no Jev
 * opinion" and confidence is 0, which says nothing about this team. Real reasons (flags, late commits) stay.
 */
function reviewReasons(reasons: string[]): string[] {
  if (!reasons.includes(NO_SECOND_OPINION)) return reasons;
  const real = reasons.filter(
    (r) =>
      r !== NO_SECOND_OPINION && !/no Jev second opinion$/.test(r) && !/^confidence [\d.]+ is below/.test(r),
  );
  return ["Ready for a judge: confirm or adjust the AI scores.", ...real];
}

export type CheckState = "pass" | "fail" | "warn" | "pending";
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

const yes = (v: string | undefined) => /^\s*yes\b/i.test(v ?? "");

/**
 * The hackathon's submission requirements, checked from the form answers, the repo scan and the media checks.
 * Pending means the pipeline has not reached that step yet.
 */
export function checklist(sub: Submission, ev: Evaluation | null): Check[] {
  const a = sub.answers;
  const checks: Check[] = [];
  const gate = ev?.gate?.status;
  checks.push({
    id: "sdk",
    label: "ArmorIQ SDK",
    state: gate === "pass" ? "pass" : gate === "fail" ? "fail" : gate ? "warn" : "pending",
    detail:
      gate === "pass"
        ? "Installed and called in application code"
        : gate === "fail"
          ? "Not installed and called (disqualified)"
          : gate
            ? (ev?.gate?.reasons[0] ?? "Needs a person to check")
            : "Not checked yet",
  });
  if (sub.track === "elevenlabs") {
    // Undefined (not []) means the repo was scanned before partner detection existed: unknown, not missing.
    const found = ev?.evidence?.partners.elevenlabs;
    checks.push({
      id: "elevenlabs",
      label: "ElevenLabs in the product",
      state: found === undefined ? "pending" : found.length ? "pass" : "warn",
      detail:
        found === undefined
          ? "Not checked yet"
          : found.length
            ? `Found in ${found.slice(0, 2).join(", ")}${found.length > 2 ? ` (+${found.length - 2})` : ""}`
            : "Claimed in the form, but no ElevenLabs SDK or API call was found in the repo",
    });
  }
  const skipped = gate === "fail";
  const videoError = ev?.mediaUnreachable.video;
  const video = ev?.media?.video;
  checks.push({
    id: "video",
    label: "Demo video",
    state: !sub.video ? "fail" : videoError ? "fail" : video ? "pass" : skipped ? "warn" : "pending",
    detail: !sub.video
      ? "No video link submitted"
      : videoError
        ? videoError
        : video
          ? video.remoteUri
            ? "Watched by the AI judge"
            : "Downloaded and transcribed"
          : skipped
            ? "Skipped: the team did not pass the SDK gate"
            : "Not checked yet",
  });
  const demo = ev?.media?.liveDemo;
  checks.push({
    id: "live_demo",
    label: "Live demo",
    state: !sub.liveDemoUrl
      ? "fail"
      : !demo
        ? "pending"
        : !demo.reachable
          ? "fail"
          : demo.error
            ? "warn"
            : "pass",
    detail: !sub.liveDemoUrl
      ? "No live demo URL submitted"
      : !demo
        ? skipped
          ? "Skipped: the team did not pass the SDK gate"
          : "Not checked yet"
        : !demo.reachable
          ? `Unreachable: ${demo.error ?? "no response"}`
          : demo.error
            ? "Online, but not a browsable page (API or login)"
            : `Online${demo.title ? `: ${demo.title}` : ""}`,
  });
  const post = a.xPost || a.linkedinPost;
  checks.push({
    id: "social",
    label: "Social post",
    state: !post ? "fail" : yes(a.hashtag) ? "pass" : "warn",
    detail: !post
      ? "No X or LinkedIn post linked"
      : `${a.xPost ? "X" : "LinkedIn"} post linked${yes(a.hashtag) ? " with #FlowStateHackathon" : "; hashtag not confirmed"}`,
  });
  checks.push({
    id: "pro",
    label: "ArmorTools Pro",
    state: yes(a.armortoolsPro) ? "pass" : "warn",
    detail: yes(a.armortoolsPro) ? "Subscribed (self-reported)" : "Not subscribed (loses the 5 Pro points)",
  });
  return checks;
}

/** Submissions waiting for a human, each with the reasons it is waiting. */
export function reviewQueue(db: DB, hackathonId: string): QueueItem[] {
  return q.currentSubmissions(db, hackathonId, REVIEWABLE).map(({ submission, status }) => ({
    id: submission.id,
    teamName: submission.teamName,
    status,
    reasons: statusReasons(status, q.getEvaluation(db, submission.id)),
  }));
}

export interface Decision {
  decision: HumanReview["decision"];
  reviewer: string;
  notes?: string;
  overrides?: Record<string, string>;
}

/** Apply a judge's decision under the hackathon's active rubric. */
export function decide(db: DB, id: string, d: Decision, now: string): { from: Status; to: Status } {
  const { submission, status } = q.getSubmission(db, id);
  const to = resolveReview(
    db,
    id,
    {
      reviewer: d.reviewer,
      kind: REVIEW_KIND[status] ?? "score",
      decision: d.decision,
      overrides: d.overrides ?? {},
      notes: d.notes ?? "",
      at: now,
    },
    q.activeRubric(db, submission.hackathonId),
  );
  return { from: status, to };
}

/** Point a submission's deck/video at local files; a submission waiting on unreachable media is requeued. */
export function attachFiles(
  db: DB,
  id: string,
  files: { deck?: string; video?: string },
  reviewer: string,
  now: string,
): { from: Status; to: Status } {
  const { submission, status } = q.getSubmission(db, id);
  for (const kind of ["deck", "video"] as const) {
    const path = files[kind];
    if (path)
      q.updateArtifact(db, id, { kind, origin: "upload", uri: path, sha256: null, unreachableReason: null });
  }
  if (status !== "needs_attention") return { from: status, to: status };
  const to = resolveReview(
    db,
    id,
    { reviewer, kind: "attention", decision: "attach", overrides: {}, notes: "", at: now },
    q.activeRubric(db, submission.hackathonId),
  );
  return { from: status, to };
}
