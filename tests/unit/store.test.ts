import { beforeEach, describe, expect, it } from "vitest";
import { EvaluationSchema, GateResultSchema } from "../../src/schemas/evaluation";
import { type Submission, SubmissionSchema } from "../../src/schemas/submission";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { exampleRubric, testDb } from "../helpers";

const T0 = "2026-10-01T10:00:00.000Z";
const sub = (id: string, over: Partial<Submission> = {}): Submission =>
  SubmissionSchema.parse({
    id,
    hackathonId: "h",
    externalId: "t1",
    teamName: "Alpha",
    repoUrl: "https://github.com/o/r",
    submittedAt: T0,
    ...over,
  });

let db: DB;
beforeEach(() => {
  db = testDb();
  q.createHackathon(db, "h", "Hack", "2026-10-02T00:00:00Z");
});

describe("store", () => {
  it("hackathons round trip and duplicates are refused", () => {
    expect(q.getHackathon(db, "h").deadline).toBe("2026-10-02T00:00:00Z");
    expect(() => q.createHackathon(db, "h", "Again", null)).toThrow(/already exists/);
    expect(() => q.getHackathon(db, "missing")).toThrow(/unknown hackathon/);
  });

  it("rubric versions are immutable", () => {
    const rubric = exampleRubric();
    q.activateRubric(db, "h", rubric);
    expect(q.activeRubric(db, "h")).toEqual(rubric);
    q.storeRubric(db, "h", rubric); // same content: no-op
    expect(() => q.storeRubric(db, "h", { ...rubric, tracks: ["new"] })).toThrow(/bump `version`/);
    q.activateRubric(db, "h", { ...rubric, tracks: ["new"], version: "2" });
    expect(q.activeRubric(db, "h").version).toBe("2");
  });

  it("refuses scoring without an active rubric", () => {
    expect(() => q.activeRubric(db, "h")).toThrow(/no active rubric/);
  });

  it("upsert outcomes and supersede", () => {
    const deadline = q.getHackathon(db, "h").deadline;
    expect(q.upsertSubmission(db, sub("a"), deadline)).toBe("created");
    expect(q.upsertSubmission(db, sub("b"), deadline)).toBe("unchanged");
    expect(
      q.upsertSubmission(
        db,
        sub("c", { repoUrl: "https://github.com/o/r2", submittedAt: "2026-10-01T12:00:00Z" }),
        deadline,
      ),
    ).toBe("updated");
    expect(
      q.upsertSubmission(
        db,
        sub("d", { repoUrl: "https://github.com/o/r3", submittedAt: "2026-10-01T09:00:00Z" }),
        deadline,
      ),
    ).toBe("ignored_older");
    expect(
      q.upsertSubmission(db, sub("e", { externalId: "t2", submittedAt: "2026-10-03T00:00:00Z" }), deadline),
    ).toBe("ignored_late");
    const current = q.currentSubmissions(db, "h");
    expect(current.map((r) => [r.submission.id, r.submission.revision, r.status])).toEqual([
      ["c", 2, "queued"],
    ]);
    expect(q.getSubmission(db, "a").status).toBe("superseded");
  });

  it("status counts, evaluations and reviews", () => {
    q.upsertSubmission(db, sub("a"), null);
    q.upsertSubmission(db, sub("b", { externalId: "t2" }), null);
    const gate = GateResultSchema.parse({ status: "review", reasons: ["?"] });
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "a", status: "gate_review", gate }));
    q.addReview(db, "a", {
      reviewer: "judge",
      kind: "gate",
      decision: "reinstate",
      overrides: {},
      notes: "",
      at: T0,
    });
    expect(q.statusCounts(db, "h")).toEqual({ gate_review: 1, queued: 1 });
    const loaded = q.getEvaluation(db, "a");
    expect(loaded?.status).toBe("gate_review");
    expect(loaded?.gate).toEqual(gate);
    expect(loaded?.reviews.map((r) => r.decision)).toEqual(["reinstate"]);
    expect(q.getEvaluation(db, "b")).toBeNull();
  });

  it("compare-and-set refuses a stale status", () => {
    q.upsertSubmission(db, sub("a"), null);
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "a", status: "scoring" }), "queued");
    expect(() =>
      q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "a", status: "finalized" }), "queued"),
    ).toThrow(q.StatusConflict);
    expect(q.getSubmission(db, "a").status).toBe("scoring");
  });

  it("updates an artifact on the current revision", () => {
    q.upsertSubmission(db, sub("a"), null);
    const ref = {
      kind: "video" as const,
      origin: "upload" as const,
      uri: "/data/demo.mp4",
      sha256: null,
      unreachableReason: null,
    };
    q.updateArtifact(db, "a", ref);
    expect(q.getSubmission(db, "a").submission.video).toEqual(ref);
  });

  it("rejects timestamps without an offset", () => {
    expect(() => q.createHackathon(db, "x", "X", "2026-10-02T00:00:00")).toThrow(/timezone offset/);
  });
});
