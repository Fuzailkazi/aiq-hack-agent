/** Phased batch execution: gate every queued submission, then score the ones that passed. */
import { randomUUID } from "node:crypto";

import { overridesToRecheck } from "../review";
import { CalibrationResultSchema } from "../schemas/calibration";
import {
  type Evaluation,
  EvaluationSchema,
  GateResultSchema,
  type GateStatus,
  PrescreenResultSchema,
  type Status,
} from "../schemas/evaluation";
import { ArmorIQEvidenceSchema, MediaDigestSchema, RepoSnapshotSchema } from "../schemas/evidence";
import { ArtifactFindingsSchema, ScorecardSchema } from "../schemas/findings";
import type { Submission } from "../schemas/submission";
import type { DB } from "../store/db";
import * as q from "../store/queries";
import { addUsage, emptyUsage } from "../usage";
import { submissionScope } from "../util/context";
import { Limiter } from "../util/limiter";
import { missingStages, type PipelineDeps, StageNotReady } from "./deps";
import { buildGateWorkflow } from "./gateWorkflow";
import { WorkflowRunner } from "./runner";
import { buildScoringWorkflow } from "./scoringWorkflow";

export const GATE_TO_STATUS: Record<GateStatus, Status> = {
  pass: "scoring",
  fail: "disqualified",
  review: "gate_review",
  needs_attention: "needs_attention",
};

export interface BatchReport {
  byStatus: Record<string, number>;
  errors: string[];
  /** Submissions whose status changed underneath the run (superseded, resolved by a judge). */
  skipped: string[];
  processed: number;
}

export interface RunOptions {
  phase?: "gate" | "score" | "all";
  only?: Set<string>;
  limit?: number;
  /** Requeue submissions in `error` before running. */
  retry?: boolean;
}

type Worker = (sub: Submission, expected: Status) => Promise<Status>;

const CLAIM_TTL_MS = 3 * 60_000;

export class BatchRunner {
  private readonly owner = randomUUID();
  private readonly limiter: Limiter;
  private readonly gate: WorkflowRunner;
  private readonly score: WorkflowRunner;

  constructor(
    private readonly db: DB,
    private readonly deps: PipelineDeps,
    concurrency: number,
  ) {
    this.limiter = new Limiter(concurrency);
    this.gate = new WorkflowRunner(buildGateWorkflow(deps));
    this.score = new WorkflowRunner(buildScoringWorkflow(deps));
  }

  async run(hackathonId: string, opts: RunOptions = {}): Promise<BatchReport> {
    const phases = opts.phase === "gate" ? ["gate"] : opts.phase === "score" ? ["score"] : ["gate", "score"];
    for (const phase of phases as ("gate" | "score")[]) {
      const missing = missingStages(this.deps, phase);
      if (missing.length) {
        throw new StageNotReady(
          `cannot run the ${phase} phase; stages not implemented yet: ${missing.join(", ")}`,
        );
      }
    }
    if (opts.retry) this.requeueErrors(hackathonId);
    const report: BatchReport = { byStatus: {}, errors: [], skipped: [], processed: 0 };
    for (const phase of phases) {
      if (phase === "gate") await this.runPhase(hackathonId, ["queued"], this.gateOne, opts, report);
      else await this.runPhase(hackathonId, ["scoring", "stale"], this.scoreOne, opts, report);
    }
    return report;
  }

  private async runPhase(
    hackathonId: string,
    statuses: Status[],
    worker: Worker,
    opts: RunOptions,
    report: BatchReport,
  ) {
    const records = q
      .currentSubmissions(this.db, hackathonId, statuses)
      .filter((r) => !opts.only || opts.only.has(r.submission.id))
      .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
    // Keep this run's leases alive while it works; a crashed run's leases lapse within CLAIM_TTL_MS.
    const heartbeat = setInterval(() => q.renewClaims(this.db, this.owner, CLAIM_TTL_MS), CLAIM_TTL_MS / 3);
    heartbeat.unref();
    try {
      await Promise.all(
        records.map((r) => this.limiter.run(() => this.claimed(r.submission, r.status, worker, report))),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Only one run at a time works on a submission (two would share clone and download folders). */
  private async claimed(sub: Submission, expected: Status, worker: Worker, report: BatchReport) {
    const label = `${sub.id} (${sub.teamName})`;
    if (!q.claimSubmission(this.db, sub.id, this.owner, CLAIM_TTL_MS)) {
      report.skipped.push(`${label}: being processed by another run`);
      return;
    }
    try {
      if (q.getSubmission(this.db, sub.id).status !== expected) {
        report.skipped.push(`${label}: already handled by another run`);
        return;
      }
      await this.guarded(sub, expected, worker, report);
    } finally {
      q.releaseClaim(this.db, sub.id, this.owner);
    }
  }

  /** One bad submission must never stop the batch. */
  private async guarded(
    sub: Submission,
    expected: Status,
    worker: Worker,
    report: BatchReport,
  ): Promise<void> {
    const label = `${sub.id} (${sub.teamName})`;
    let status: Status;
    try {
      status = await submissionScope.run(sub.id, () => worker.call(this, sub, expected));
    } catch (e) {
      if (e instanceof q.StatusConflict) {
        report.skipped.push(`${label}: status changed during the run`);
        return;
      }
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      report.errors.push(`${label}: ${message}`);
      const current =
        q.getEvaluation(this.db, sub.id) ?? EvaluationSchema.parse({ submissionId: sub.id, status: "error" });
      try {
        const usage = addUsage(current.usage, this.deps.usage?.pop(sub.id) ?? emptyUsage());
        q.saveEvaluation(this.db, { ...current, status: "error", error: message, usage }, expected);
      } catch (conflict) {
        if (!(conflict instanceof q.StatusConflict)) throw conflict;
        report.skipped.push(`${label}: status changed during the run`);
        return;
      }
      status = "error";
    }
    report.byStatus[status] = (report.byStatus[status] ?? 0) + 1;
    report.processed += 1;
  }

  private requeueErrors(hackathonId: string): void {
    for (const record of q.currentSubmissions(this.db, hackathonId, ["error"])) {
      const evaluation = q.getEvaluation(this.db, record.submission.id);
      q.setStatus(this.db, record.submission.id, evaluation?.gate?.status === "pass" ? "scoring" : "queued");
    }
  }

  private async gateOne(sub: Submission, expected: Status): Promise<Status> {
    const state = await this.gate.run({ submission: sub });
    const gate = GateResultSchema.parse(state.gate);
    const evaluation = EvaluationSchema.parse({
      submissionId: sub.id,
      status: GATE_TO_STATUS[gate.status],
      repo: state.repo ? RepoSnapshotSchema.parse(state.repo) : null,
      evidence: state.evidence ? ArmorIQEvidenceSchema.parse(state.evidence) : null,
      gate,
      usage: this.deps.usage?.pop(sub.id) ?? emptyUsage(),
    });
    q.saveEvaluation(this.db, evaluation, expected);
    return evaluation.status;
  }

  private async scoreOne(sub: Submission, expected: Status): Promise<Status> {
    const previous =
      q.getEvaluation(this.db, sub.id) ?? EvaluationSchema.parse({ submissionId: sub.id, status: "scoring" });
    const state = await this.score.run({
      submission: sub,
      evidence: previous.evidence,
      gateFlags: previous.gate?.flags ?? [],
    });
    const media = MediaDigestSchema.parse(state.media);
    let evaluation: Evaluation;
    if (Object.keys(media.unreachable).length) {
      evaluation = {
        ...previous,
        status: "needs_attention",
        mediaUnreachable: media.unreachable,
        media,
        usage: addUsage(previous.usage, this.deps.usage?.pop(sub.id) ?? emptyUsage()),
        error: null,
      };
    } else {
      let calibration = CalibrationResultSchema.parse(state.calibration);
      const recheck = overridesToRecheck(previous.reviews, this.deps.rubric, (version) =>
        q.getRubric(this.db, sub.hackathonId, previous.rubricId ?? this.deps.rubric.id, version),
      );
      if (recheck.length)
        calibration = { ...calibration, route: "review", reasons: [...calibration.reasons, ...recheck] };
      // A rubric activated while this submission was being scored makes the result stale (re-scored next run).
      const active = q.getHackathon(this.db, sub.hackathonId);
      const outdated =
        active.activeRubricId !== this.deps.rubric.id ||
        active.activeRubricVersion !== this.deps.rubric.version;
      const status: Status = outdated
        ? "stale"
        : calibration.route === "accept"
          ? "finalized"
          : "needs_review";
      evaluation = {
        ...previous,
        status,
        rubricId: this.deps.rubric.id,
        rubricVersion: this.deps.rubric.version,
        mediaUnreachable: {},
        media,
        prescreen: PrescreenResultSchema.parse(state.prescreen),
        findings: (state.findings as unknown[]).map((f) => ArtifactFindingsSchema.parse(f)),
        scorecard: ScorecardSchema.parse(state.scorecard),
        calibration,
        usage: addUsage(previous.usage, this.deps.usage?.pop(sub.id) ?? emptyUsage()),
        autoScore: calibration.autoScore,
        finalScore: status === "finalized" ? calibration.autoScore : null,
        error: null,
      };
    }
    q.saveEvaluation(this.db, evaluation, expected);
    return evaluation.status;
  }
}
