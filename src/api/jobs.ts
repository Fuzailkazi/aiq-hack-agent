/** Pipeline runs started from the API execute in-process in the background; clients poll their state. */
import { randomUUID } from "node:crypto";
import { type BatchReport, BatchRunner } from "../pipeline/batch";
import type { BuildDeps } from "../pipeline/deps";
import type { Settings } from "../settings";
import type { DB } from "../store/db";
import * as q from "../store/queries";

/** As the CLI's `run` options (submission ids as a list, since they arrive as JSON). */
export interface RunOptions {
  phase?: "gate" | "score" | "all";
  only?: string[];
  limit?: number;
  retry?: boolean;
}

export interface RunJob {
  id: string;
  hackathonId: string;
  state: "running" | "done" | "failed";
  options: RunOptions;
  report: BatchReport | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class RunJobs {
  private readonly jobs = new Map<string, RunJob>();

  constructor(
    private readonly db: DB,
    private readonly settings: Settings,
    private readonly buildDeps: BuildDeps,
  ) {}

  get(id: string): RunJob | undefined {
    return this.jobs.get(id);
  }

  active(hackathonId: string): RunJob | undefined {
    return [...this.jobs.values()].find((j) => j.hackathonId === hackathonId && j.state === "running");
  }

  /** Validates synchronously (rubric, one run per hackathon), then runs in the background. */
  start(hackathonId: string, options: RunOptions): RunJob {
    if (this.active(hackathonId))
      throw new q.StatusConflict(`a run is already in progress for '${hackathonId}'`);
    const rubric = q.activeRubric(this.db, hackathonId);
    const deps = this.buildDeps(this.settings, rubric, q.getHackathon(this.db, hackathonId).deadline);
    const job: RunJob = {
      id: randomUUID(),
      hackathonId,
      state: "running",
      options,
      report: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    new BatchRunner(this.db, deps, this.settings.concurrency)
      .run(hackathonId, {
        phase: options.phase ?? "all",
        only: options.only?.length ? new Set(options.only) : undefined,
        limit: options.limit,
        retry: options.retry,
      })
      .then((report) => Object.assign(job, { state: "done", report }))
      .catch((e: unknown) =>
        Object.assign(job, { state: "failed", error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return job;
  }

  /** Resolves when every running job has finished (used on shutdown). */
  async drain(): Promise<void> {
    while ([...this.jobs.values()].some((j) => j.state === "running"))
      await new Promise((r) => setTimeout(r, 25));
  }
}
