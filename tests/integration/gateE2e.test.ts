/** Real git repos -> real acquire + scanner + gate (FakeJev) through the batch runner. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SDK_CALLED_IN_APP_CODE } from "../../src/jev/gateQuestions";
import { BatchRunner } from "../../src/pipeline/batch";
import { buildProductionDeps } from "../../src/pipeline/production";
import { SubmissionSchema } from "../../src/schemas/submission";
import { loadSettings } from "../../src/settings";
import * as q from "../../src/store/queries";
import { FakeJevClient } from "../fakes";
import { FAKE_KEY, GATE_REPOS } from "../gateRepos";
import { makeGitRepo } from "../gitRepo";
import { exampleRubric, tempDir, testDb } from "../helpers";

const SEP30 = "2026-09-30T00:00:00Z";
const DEADLINE = "2026-10-01T00:00:00Z";

describe("gate phase end to end", () => {
  it("clones, scans and decides real repositories", async () => {
    const dir = tempDir();
    const db = testDb();
    const expected: Record<string, string> = {
      py_sdk_used: "scoring",
      no_sdk: "disqualified",
      dynamic_import: "scoring", // UNRESOLVED -> Jev 0.95 -> pass
      committed_secret: "scoring",
      ghost: "needs_attention",
    };
    q.createHackathon(db, "h", "Hack", DEADLINE);
    for (const name of Object.keys(expected)) {
      const url =
        name === "ghost"
          ? join(dir, "missing")
          : makeGitRepo(join(dir, "origins", name), [[GATE_REPOS[name].files, SEP30]]);
      q.upsertSubmission(
        db,
        SubmissionSchema.parse({
          id: name,
          hackathonId: "h",
          externalId: name,
          teamName: name,
          repoUrl: url,
          submittedAt: SEP30,
        }),
        DEADLINE,
      );
    }
    const settings = loadSettings({}, { workspace: join(dir, "ws"), allowLocalRepos: true });
    const jev = new FakeJevClient({ [SDK_CALLED_IN_APP_CODE]: 0.95 });
    const deps = buildProductionDeps(settings, exampleRubric(), DEADLINE, { jev });
    const report = await new BatchRunner(db, deps, 2).run("h", { phase: "gate" });

    expect(report.errors).toEqual([]);
    expect(Object.fromEntries(q.currentSubmissions(db, "h").map((r) => [r.submission.id, r.status]))).toEqual(
      expected,
    );
    expect(jev.calls).toHaveLength(1); // only the unresolved repo reached Jev
    const secret = q.getEvaluation(db, "committed_secret");
    expect(secret?.evidence?.secretExposed).toBe(true);
    expect(JSON.stringify(secret)).not.toContain(FAKE_KEY);
    expect(q.getEvaluation(db, "no_sdk")?.gate?.feedbackMd).toBeTruthy();
    expect(q.getEvaluation(db, "ghost")?.gate?.reasons).toEqual([
      "repository unreachable: repository not found or private",
    ]);
  });
});
