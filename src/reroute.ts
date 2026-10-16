/** Re-apply the routing policy to stored calibrations. Pure database work: zero LLM or Jev calls. */
import type { Policy } from "./config";
import { humanOwnsRoute } from "./review";
import type { Status } from "./schemas/evaluation";
import type { Rubric } from "./schemas/rubric";
import { decideRoute, recompute } from "./stages/route";
import type { DB } from "./store/db";
import * as q from "./store/queries";

export interface RerouteReport {
  changed: string[];
  unchanged: number;
  skipped: string[];
}

const ROUTED: Status[] = ["finalized", "needs_review"];

export function reroute(db: DB, hackathonId: string, rubric: Rubric, policy: Policy): RerouteReport {
  const report: RerouteReport = { changed: [], unchanged: 0, skipped: [] };
  for (const { submission: sub, status } of q.currentSubmissions(db, hackathonId, ROUTED)) {
    const label = `${sub.id} (${sub.teamName})`;
    const ev = q.getEvaluation(db, sub.id);
    if (!ev?.calibration) {
      report.skipped.push(`${label}: no stored calibration`);
      continue;
    }
    if (humanOwnsRoute(ev)) {
      report.skipped.push(`${label}: decided by a human reviewer`);
      continue;
    }
    if (ev.rubricId !== rubric.id || ev.rubricVersion !== rubric.version) {
      report.skipped.push(`${label}: scored under rubric version ${ev.rubricVersion}`);
      continue;
    }
    const criteria = recompute(ev.calibration.criteria, policy.routing);
    const decision = decideRoute(
      criteria,
      rubric,
      policy.routing,
      ev.calibration.flags,
      ev.gate?.flags ?? [],
    );
    const next: Status = decision.route === "accept" ? "finalized" : "needs_review";
    try {
      q.saveEvaluation(
        db,
        {
          ...ev,
          status: next,
          calibration: {
            ...ev.calibration,
            criteria,
            confidence: decision.confidence,
            route: decision.route,
            reasons: decision.reasons,
            discrepancyNotes: decision.notes,
          },
          finalScore: next === "finalized" ? ev.autoScore : null,
        },
        status,
      );
    } catch (e) {
      if (!(e instanceof q.StatusConflict)) throw e;
      report.skipped.push(`${label}: status changed during reroute`);
      continue;
    }
    if (next === status) report.unchanged += 1;
    else report.changed.push(`${label}: ${status} → ${next}`);
  }
  return report;
}
