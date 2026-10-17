import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type CliResult, runCli } from "../../src/cli";
import { policyOf } from "../../src/settings";
import { fakeDeps, type Scripted } from "../fakes";
import { tempDir } from "../helpers";
import { FIXTURE, SCRIPT } from "../scenario";

let env: Record<string, string>;
let script: Record<string, Scripted>;
const RUBRIC = "config/rubrics/example_rubric.yaml";

beforeEach(() => {
  const dir = tempDir();
  env = { HACKEVAL_DB_PATH: `${dir}/cli.db`, HACKEVAL_WORKSPACE: `${dir}/ws`, HACKEVAL_HACKATHON: "demo" };
  script = SCRIPT;
});

const cli = (...args: string[]): Promise<CliResult> =>
  runCli(args, { env, buildDeps: (settings, rubric) => fakeDeps(rubric, policyOf(settings), script) });
const ok = async (...args: string[]): Promise<string> => {
  const result = await cli(...args);
  expect(result.code, result.err + result.out).toBe(0);
  return result.out;
};
const idOf = (queue: string, team: string): string => {
  const line = queue.split("\n").find((l) => l.includes(team));
  if (!line) throw new Error(`${team} not in queue:\n${queue}`);
  return line.split(/\s+/)[0];
};

describe("hackeval CLI", () => {
  it("runs the whole organizer flow", async () => {
    await ok("init", "demo", "--name", "Demo Hack");
    expect(await ok("rubric", "validate", RUBRIC)).toContain("ok: example v1");
    await ok("rubric", "activate", RUBRIC);
    expect(JSON.parse(await ok("import", FIXTURE)).created).toBe(7);
    expect(JSON.parse(await ok("run")).processed).toBe(11); // 7 gated + 4 scored
    const status = JSON.parse(await ok("status"));
    expect(status.byStatus).toEqual({
      disqualified: 1,
      finalized: 2,
      gate_review: 1,
      needs_attention: 2,
      needs_review: 1,
    });
    // Scripted stages make no model calls; nothing used means nothing is unpriced.
    expect(status.usage).toMatchObject({ submissions: 7, estimatedCostUsd: 0, unpriced: [] });
    expect(status.usage.usage).toMatchObject({ llmCalls: 0, jevCalls: 0 });
    const queue = await ok("review", "list");
    expect(queue).toContain("confidence 0.25 is below 0.85");
    await ok("review", "resolve", idOf(queue, "Charlie"), "--decision", "reinstate", "--reviewer", "ana");
    await ok(
      "review",
      "resolve",
      idOf(queue, "Echo"),
      "--decision",
      "override",
      "--reviewer",
      "ana",
      "--override",
      "demo_quality=Partial",
    );
    await ok("run", "--phase", "score");
    const rerouted = JSON.parse(await ok("reroute"));
    expect(rerouted.changed).toEqual([]);
    expect(rerouted.skipped).toEqual([expect.stringContaining("decided by a human reviewer")]);
    const lines = (await ok("leaderboard", "--format", "csv"))
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(","));
    const teams = lines.map((l) => l[2]);
    // Each track has its own winner.
    expect(lines.filter((l) => l[0] === "1").map((l) => [l[6], l[2]])).toEqual([
      ["agents", "Alpha"],
      ["security", "Charlie"],
    ]);
    expect(teams).toEqual(expect.arrayContaining(["Echo", "Golf"]));
  });

  it("reports rubric validation errors", async () => {
    const dir = tempDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/bad.yaml`, "id: x\nversion: '1'\ncriteria: []\n");
    const result = await cli("rubric", "validate", `${dir}/bad.yaml`);
    expect(result.code).toBe(1);
    expect(result.err).toContain("invalid rubric");
  });

  it("refuses to run without an active rubric", async () => {
    await ok("init", "demo");
    const result = await cli("run");
    expect(result.code).toBe(1);
    expect(result.err).toContain("no active rubric");
  });

  it("runs the score phase in production mode now that every stage is wired", async () => {
    await ok("init", "demo");
    await ok("rubric", "activate", RUBRIC);
    const result = await runCli(["run", "--phase", "score"], { env });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
  });

  it("calibrates routing against a gold CSV without model calls", async () => {
    await ok("init", "demo");
    await ok("rubric", "activate", RUBRIC);
    await ok("import", FIXTURE);
    await ok("run");
    const header =
      "submission_id,problem_solution,demo_quality,architecture,innovation,presentation,armoriq_integration";
    const gold = join(tempDir(), "gold.csv");
    writeFileSync(
      gold,
      `${header}\nt1,Compelling,End-to-end,Deep,Breakthrough,Excellent,Core\nt7,Clear,Partial,Explained,Fresh,Good,Integrated\n`,
    );
    const report = JSON.parse(await ok("calibrate", gold, "--max-review-rate", "0.5"));
    expect(report.gold).toBe(2);
    expect(report.current.goldScored).toBe(2);
    expect(report.targets).toEqual({ targetWithin1: 0.9, maxReviewRate: 0.5 });
    expect(report.sweep).toBeUndefined(); // only with --full
    expect(report.errors).toEqual([]);
  });

  it("serve refuses to start without Google sign-in configured", async () => {
    const result = await cli("serve", "--port", "0");
    expect(result.code).toBe(1);
    expect(result.err).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });

  it("local-only mode will not bind to a public interface", async () => {
    const result = await runCli(["serve", "--host", "0.0.0.0", "--port", "0"], {
      env: { ...env, HACKEVAL_LOCAL_ONLY: "true" },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("only binds to 127.0.0.1");
  });

  it("rejects naive deadlines and bad repo URLs", async () => {
    const naive = await cli("init", "demo", "--deadline", "2026-10-20T23:59:00");
    expect(naive.code).toBe(1);
    expect(naive.err).toContain("timezone offset");
    await ok("init", "demo", "--deadline", "2026-10-20T23:59:00-07:00");
    const bad = await cli("add", "--team", "X", "--repo", "N/A");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("repo_url must be a repository URL");
    expect((await ok("add", "--team", "X", "--repo", "github.com/o/x.git")).trim()).toBe("created");
  });

  it("retries errors and requeues attention items", async () => {
    script = { ...SCRIPT, "https://github.com/example/alpha": { crashIn: "synthesize" } };
    await ok("init", "demo");
    await ok("rubric", "activate", RUBRIC);
    await ok("import", FIXTURE);
    await ok("run");
    expect(JSON.parse(await ok("status")).byStatus.error).toBe(1);
    script = SCRIPT;
    await ok("run", "--retry");
    expect(JSON.parse(await ok("status")).byStatus.error).toBeUndefined();
    const delta = idOf(await ok("review", "list"), "Delta");
    expect(await ok("review", "resolve", delta, "--decision", "requeue", "--reviewer", "ana")).toContain(
      "needs_attention -> queued",
    );
    const bad = await cli(
      "review",
      "resolve",
      delta,
      "--decision",
      "override",
      "--reviewer",
      "a",
      "--override",
      "no-equals-sign",
    );
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("criterion_id=Level");
  });
});

describe("attach and models", () => {
  it("attaches a file to unreachable media and requeues it", async () => {
    await ok("init", "demo");
    await ok("rubric", "activate", RUBRIC);
    await ok("import", FIXTURE);
    await ok("run");
    const queue = await ok("review", "list");
    const foxtrot = idOf(queue, "Foxtrot");
    expect(queue.split("\n").find((l) => l.includes("Foxtrot"))).toContain("login page");
    const dir = tempDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/foxtrot.mp4`, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const missing = await cli("attach", foxtrot, "--video", `${dir}/missing.mp4`);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not found");
    expect(await ok("attach", foxtrot, "--video", `${dir}/foxtrot.mp4`)).toContain(
      "needs_attention -> scoring",
    );
    script = Object.fromEntries(Object.entries(SCRIPT).filter(([url]) => !url.includes("foxtrot")));
    await ok("run", "--phase", "score");
    expect(JSON.parse(await ok("status")).byStatus.finalized).toBe(3);
  });

  it("prints the active models", async () => {
    const out = JSON.parse(await ok("models"));
    expect(out).toMatchObject({
      provider: "gemini",
      deck: "gemini-3.5-flash",
      transcribe: "gemini-3.5-flash",
    });
  });
});
