/** Organizer operations shared by the CLI and the HTTP API (one implementation, two front ends). */
import { REVIEW_KIND, resolveReview } from "./review";
import type { HumanReview, Status } from "./schemas/evaluation";
import type { DB } from "./store/db";
import * as q from "./store/queries";

export const REVIEWABLE: Status[] = ["gate_review", "needs_review", "needs_attention", "error"];

export interface QueueItem {
  id: string;
  teamName: string;
  status: Status;
  reasons: string[];
}

/** Submissions waiting for a human, each with the reasons it is waiting. */
export function reviewQueue(db: DB, hackathonId: string): QueueItem[] {
  return q.currentSubmissions(db, hackathonId, REVIEWABLE).map(({ submission, status }) => {
    const ev = q.getEvaluation(db, submission.id);
    let reasons: string[] = [];
    if (ev?.gate && (status === "gate_review" || status === "needs_attention")) reasons = ev.gate.reasons;
    if (ev && Object.keys(ev.mediaUnreachable).length)
      reasons = Object.entries(ev.mediaUnreachable).map(([k, v]) => `${k}: ${v}`);
    if (ev?.calibration && status === "needs_review") reasons = ev.calibration.reasons;
    if (ev?.error) reasons = [ev.error];
    return { id: submission.id, teamName: submission.teamName, status, reasons };
  });
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
