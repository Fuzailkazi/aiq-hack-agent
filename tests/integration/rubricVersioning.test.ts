import { beforeEach, describe, expect, it } from "vitest";
import { IntakeMappingSchema } from "../../src/config";
import { importCsv } from "../../src/intake";
import { buildLeaderboard } from "../../src/leaderboard";
import { BatchRunner } from "../../src/pipeline/batch";
import { reroute } from "../../src/reroute";
import { resolveReview } from "../../src/review";
import type { HumanReview } from "../../src/schemas/evaluation";
import { type Rubric, RubricSchema } from "../../src/schemas/rubric";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { fakeDeps } from "../fakes";
import { exampleRubric, shippedPolicy, testDb } from "../helpers";
import { FIXTURE, SCRIPT } from "../scenario";

const v1 = exampleRubric();
/** v2 rewrites demo_quality; presentation is unchanged. */
const v2: Rubric = RubricSchema.parse({
  ...v1,
  version: "2",
  criteria: v1.criteria.map((c) =>
    c.id === "demo_quality" ? { ...c, description: `${c.description} Judged on the live demo only.` } : c,
  ),
});
const policy = shippedPolicy();
let db: DB;

const idOf = (team: string): string => {
  const r = q.currentSubmissions(db, "h").find((x) => x.submission.teamName === team);
  if (!r) throw new Error(team);
  return r.submission.id;
};
const statusOf = (team: string) => q.getSubmission(db, idOf(team)).status;
const override = (overrides: Record<string, string>): HumanReview => ({
  reviewer: "ana",
  kind: "score",
  decision: "override",
  overrides,
  notes: "",
  at: "2026-10-02T00:00:00Z",
  rubricVersion: null,
});

beforeEach(async () => {
  db = testDb();
  q.createHackathon(db, "h", "Hack", null);
  q.activateRubric(db, "h", v1);
  importCsv(db, "h", FIXTURE, IntakeMappingSchema.parse({}), "2026-10-01T00:00:00Z");
  await new BatchRunner(db, fakeDeps(v1, policy, SCRIPT), 2).run("h", { phase: "all" });
});

describe("rubric versioning", () => {
  it("activating a new version marks scored results stale; gate outcomes are untouched", () => {
    const before = q.statusCounts(db, "h");
    expect(q.activateRubric(db, "h", v2)).toBe((before.finalized ?? 0) + (before.needs_review ?? 0));
    const after = q.statusCounts(db, "h");
    expect(after.finalized).toBeUndefined();
    expect(after.needs_review).toBeUndefined();
    expect(after.disqualified).toBe(before.disqualified);
    expect(after.gate_review).toBe(before.gate_review);
    expect(q.activateRubric(db, "h", v2)).toBe(0);
  });

  it("a result that finishes under the old rubric after a new one is activated is saved stale", async () => {
    const id = idOf("Golf");
    q.setStatus(db, id, "scoring");
    const deps = fakeDeps(v1, policy, SCRIPT);
    const racing = {
      ...deps,
      synthesize: async (...args: Parameters<typeof deps.synthesize>) => {
        q.activateRubric(db, "h", v2); // an organizer activates v2 while this submission is being scored
        return deps.synthesize(...args);
      },
    };
    await new BatchRunner(db, racing, 1).run("h", { phase: "score", only: new Set([id]) });
    expect(statusOf("Golf")).toBe("stale");
    expect(q.getEvaluation(db, id)?.finalScore).toBeNull();
  });

  it("the leaderboard only ranks results scored under the active rubric", () => {
    const golf = idOf("Golf");
    expect(buildLeaderboard(db, "h").map((r) => r.submissionId)).toContain(golf);
    const ev = q.getEvaluation(db, golf);
    if (!ev) throw new Error("no evaluation");
    q.saveEvaluation(db, { ...ev, rubricVersion: "0" }); // e.g. finalized by a run that started before activation
    expect(buildLeaderboard(db, "h").map((r) => r.submissionId)).not.toContain(golf);
  });

  it("re-scores stale submissions under the new version", async () => {
    q.activateRubric(db, "h", v2);
    const report = await new BatchRunner(db, fakeDeps(v2, policy, SCRIPT), 2).run("h", { phase: "score" });
    expect(report.errors).toEqual([]);
    expect(statusOf("Golf")).toBe("finalized");
    expect(q.getEvaluation(db, idOf("Golf"))?.rubricVersion).toBe("2");
  });

  it("records the rubric version on reviews, and an older override sends the re-score to a human", async () => {
    resolveReview(db, idOf("Echo"), override({ demo_quality: "Partial", presentation: "Good" }), v1);
    expect(q.getEvaluation(db, idOf("Echo"))?.reviews[0].rubricVersion).toBe("1");
    q.activateRubric(db, "h", v2);
    const script = { ...SCRIPT, "https://github.com/example/echo": { route: "accept" as const } };
    await new BatchRunner(db, fakeDeps(v2, policy, script), 2).run("h", { phase: "score" });
    expect(statusOf("Echo")).toBe("needs_review");
    const ev = q.getEvaluation(db, idOf("Echo"));
    expect(ev?.finalScore).toBeNull();
    expect(ev?.calibration?.reasons).toEqual([
      "human override of demo_quality (rubric 1) no longer applies: the criterion changed",
      "human override of presentation (rubric 1): re-confirm under rubric 2",
    ]);
    // The pending re-check is a human matter: reroute leaves it alone.
    expect(reroute(db, "h", v2, policy).skipped).toContain(
      `${idOf("Echo")} (Echo): decided by a human reviewer`,
    );
  });

  it("an accept under an older version does not block rerouting the re-score", async () => {
    resolveReview(db, idOf("Echo"), { ...override({}), decision: "accept" }, v1);
    q.activateRubric(db, "h", v2);
    await new BatchRunner(db, fakeDeps(v2, policy, SCRIPT), 2).run("h", { phase: "score" });
    expect(reroute(db, "h", v2, policy).skipped).toEqual([]);
  });
});
