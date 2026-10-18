import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { beforeEach, describe, expect, it } from "vitest";
import { IntakeMappingSchema } from "../../src/config";
import { importCsv } from "../../src/intake";
import { BatchRunner } from "../../src/pipeline/batch";
import { notReady, StageNotReady } from "../../src/pipeline/deps";
import { resolveReview } from "../../src/review";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { fakeDeps, type Scripted } from "../fakes";
import { exampleRubric, shippedPolicy, testDb } from "../helpers";
import { FIXTURE, SCRIPT } from "../scenario";

const rubric = exampleRubric();
const policy = shippedPolicy();
let db: DB;

const expected = (): Record<string, string> =>
  Object.fromEntries(
    (parse(readFileSync(FIXTURE, "utf8"), { columns: true }) as Record<string, string>[]).map((r) => [
      r.team_name,
      r.expected_status,
    ]),
  );
const statuses = (): Record<string, string> =>
  Object.fromEntries(q.currentSubmissions(db, "h").map((r) => [r.submission.teamName, r.status]));
const idOf = (team: string): string =>
  q.currentSubmissions(db, "h").find((r) => r.submission.teamName === team)?.submission.id ?? "";
const reinstate = {
  reviewer: "ana",
  kind: "gate" as const,
  decision: "reinstate" as const,
  at: "2026-10-02T00:00:00Z",
};
const runner = (script = SCRIPT) => new BatchRunner(db, fakeDeps(rubric, policy, script), 3);

beforeEach(() => {
  db = testDb();
  q.createHackathon(db, "h", "Hack", null);
  q.activateRubric(db, "h", rubric);
  importCsv(db, "h", FIXTURE, IntakeMappingSchema.parse({}), "2026-10-01T00:00:00Z");
});

describe("batch runner (walking skeleton)", () => {
  it("reaches every fixture row's expected status", async () => {
    const report = await runner().run("h", { phase: "all" });
    expect(statuses()).toEqual(expected());
    expect(report.errors).toEqual([]);
    const golf = q.currentSubmissions(db, "h").find((r) => r.submission.teamName === "Golf");
    const ev = q.getEvaluation(db, golf?.submission.id ?? "");
    expect(ev?.finalScore).toBe(33.33);
    expect(ev?.rubricVersion).toBe("1");
    // The digest is kept so the UI can show the evidence (slides, transcript) behind each citation.
    expect(ev?.media?.deck?.slides[0].text).toBe("Our pitch");
  });

  it("re-running does nothing", async () => {
    await runner().run("h", { phase: "all" });
    const second = await runner().run("h", { phase: "all" });
    expect(second.processed).toBe(0);
    expect(statuses()).toEqual(expected());
  });

  it("runs the gate phase alone", async () => {
    const report = await runner().run("h", { phase: "gate" });
    expect(report.byStatus).toEqual({ scoring: 4, disqualified: 1, gate_review: 1, needs_attention: 1 });
  });

  it("carries gate flags into scoring: late commits send an otherwise accepted result to review", async () => {
    await runner({
      ...SCRIPT,
      "https://github.com/example/golf": { level: 1, gateFlags: ["2 commit(s) after the deadline"] },
    }).run("h", { phase: "all" });
    expect(statuses().Golf).toBe("needs_review");
    const golf = q.currentSubmissions(db, "h").find((r) => r.submission.teamName === "Golf");
    expect(q.getEvaluation(db, golf?.submission.id ?? "")?.calibration?.reasons).toEqual([
      "gate: 2 commit(s) after the deadline",
    ]);
  });

  it("a judge's reinstate survives an error and --retry (no re-gate, no second disqualification)", async () => {
    const script: Record<string, Scripted> = { ...SCRIPT };
    await runner(script).run("h", { phase: "all" });
    const bravo = idOf("Bravo");
    expect(statuses().Bravo).toBe("disqualified");
    resolveReview(db, bravo, reinstate, rubric);
    script["https://github.com/example/bravo"] = { gate: "fail", crashIn: "synthesize" };
    await runner(script).run("h", { phase: "score" });
    expect(statuses().Bravo).toBe("error");
    script["https://github.com/example/bravo"] = { gate: "fail" };
    await runner(script).run("h", { phase: "all", retry: true });
    expect(statuses().Bravo).toBe("finalized");
  });

  it("scoring one team at a time: a retry limited to one team leaves the other failures alone", async () => {
    const alpha = "https://github.com/example/alpha";
    const golf = "https://github.com/example/golf";
    const script: Record<string, Scripted> = {
      ...SCRIPT,
      [alpha]: { ...SCRIPT[alpha], crashIn: "synthesize" },
      [golf]: { ...SCRIPT[golf], crashIn: "synthesize" },
    };
    await runner(script).run("h", { phase: "all" });
    expect([statuses().Alpha, statuses().Golf]).toEqual(["error", "error"]);
    script[alpha] = SCRIPT[alpha];
    script[golf] = SCRIPT[golf];
    const report = await runner(script).run("h", {
      phase: "score",
      only: new Set([idOf("Alpha")]),
      retry: true,
    });
    expect(report.processed).toBe(1);
    expect(statuses().Alpha).not.toBe("error");
    expect(statuses().Golf).toBe("error");
  });

  it("a judge's reinstate survives unreachable media and an attach", async () => {
    const script: Record<string, Scripted> = { ...SCRIPT };
    await runner(script).run("h", { phase: "all" });
    const bravo = idOf("Bravo");
    resolveReview(db, bravo, reinstate, rubric);
    script["https://github.com/example/bravo"] = { gate: "fail", mediaUnreachable: true };
    await runner(script).run("h", { phase: "score" });
    expect(statuses().Bravo).toBe("needs_attention");
    const attach = { ...reinstate, kind: "attention" as const, decision: "attach" as const };
    expect(resolveReview(db, bravo, attach, rubric)).toBe("scoring");
  });

  it("two concurrent runs never process the same submission twice", async () => {
    const acquired: string[] = [];
    const slow = () => {
      const deps = fakeDeps(rubric, policy, SCRIPT);
      return new BatchRunner(
        db,
        {
          ...deps,
          acquireRepo: async (sub) => {
            acquired.push(sub.repoUrl);
            await new Promise((r) => setTimeout(r, 20));
            return deps.acquireRepo(sub);
          },
        },
        3,
      );
    };
    const [a, b] = await Promise.all([slow().run("h", { phase: "all" }), slow().run("h", { phase: "all" })]);
    expect(acquired.length).toBe(new Set(acquired).size);
    expect(statuses()).toEqual(expected());
    expect([...a.skipped, ...b.skipped].join("\n")).toContain("another run");
    expect(db.prepare("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 0 });
  });

  it("an expired claim from a crashed run is taken over", async () => {
    const alpha = idOf("Alpha");
    db.prepare("INSERT INTO claims (submission_id, owner, expires_at) VALUES (?, 'dead', ?)").run(
      alpha,
      Date.now() - 1,
    );
    await runner().run("h", { phase: "all" });
    expect(statuses().Alpha).toBe("finalized");
  });

  it("isolates a crashing submission", async () => {
    const report = await runner({
      ...SCRIPT,
      "https://github.com/example/alpha": { crashIn: "synthesize" },
    }).run("h", {
      phase: "all",
    });
    expect(statuses().Alpha).toBe("error");
    expect(statuses().Golf).toBe("finalized");
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/scripted crash in synthesize/);
  });

  it("aborts before touching submissions when a stage is not ready", async () => {
    const deps = { ...fakeDeps(rubric, policy, SCRIPT), ingestMedia: notReady("ingestMedia", "M3") };
    await expect(new BatchRunner(db, deps, 3).run("h", { phase: "all" })).rejects.toThrow(StageNotReady);
    expect(new Set(Object.values(statuses()))).toEqual(new Set(["queued"]));
  });

  it("retry requeues errors", async () => {
    await runner({ ...SCRIPT, "https://github.com/example/alpha": { crashIn: "synthesize" } }).run("h", {
      phase: "all",
    });
    expect(statuses().Alpha).toBe("error");
    const report = await runner().run("h", { phase: "all", retry: true });
    expect(statuses()).toEqual(expected());
    expect(report.errors).toEqual([]);
  });

  it("does not resurrect a submission superseded mid-run", async () => {
    const deps = fakeDeps(rubric, policy, SCRIPT);
    const original = deps.decideGate;
    deps.decideGate = async (evidence, snapshot) => {
      if (snapshot.url === "https://github.com/example/alpha") {
        const alpha = q.currentSubmissions(db, "h").find((r) => r.submission.teamName === "Alpha");
        if (alpha) q.setStatus(db, alpha.submission.id, "superseded");
      }
      return original(evidence, snapshot);
    };
    const report = await new BatchRunner(db, deps, 1).run("h", { phase: "gate" });
    expect("Alpha" in statuses()).toBe(false);
    expect(report.skipped).toHaveLength(1);
    expect(report.errors).toEqual([]);
  });
});
