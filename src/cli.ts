/** `hackeval` command line. `runCli` is the testable core; the bottom of the file is the executable entry. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LogLevel, setLogLevel } from "@google/adk";
import { Command, CommanderError, Option } from "commander";
import { ZodError } from "zod";
import { buildApp } from "./api/app";
import { calibrationReport } from "./calibrateGold";
import { modelFor } from "./config";
import { addSubmission, importCsv, parseTimestamp } from "./intake";
import { buildLeaderboard, leaderboardCsv } from "./leaderboard";
import { BatchRunner } from "./pipeline/batch";
import { type BuildDeps, StageNotReady } from "./pipeline/deps";
import { buildProductionDeps } from "./pipeline/production";
import { reroute } from "./reroute";
import type { HumanReview } from "./schemas/evaluation";
import { loadRubric, type Rubric } from "./schemas/rubric";
import { attachFiles, decide, reviewQueue } from "./service";
import { intakeOf, loadSettings, modelsOf, policyOf } from "./settings";
import { type DB, openDb } from "./store/db";
import * as q from "./store/queries";
import { usageReport } from "./usage";

export type { BuildDeps };
export interface CliOptions {
  env?: Record<string, string | undefined>;
  buildDeps?: BuildDeps;
}
export interface CliResult {
  code: number;
  out: string;
  err: string;
}

/** The built React UI (web/dist), relative to this file in both src/ (tsx) and dist/ (tsup). */
const WEB_DIST = fileURLToPath(new URL("../web/dist", import.meta.url));

/** A user-facing error: printed without a stack trace, exit code 1. */
class CliError extends Error {}

const nowIso = (): string => new Date().toISOString();

export async function runCli(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const env = opts.env ?? process.env;
  const buildDeps = opts.buildDeps ?? buildProductionDeps;
  let out = "";
  let err = "";
  const print = (text: string) => {
    out += `${text}\n`;
  };
  let db: DB | undefined;
  const settings = () => loadSettings(env);
  const database = (): DB => {
    db ??= openDb(settings().dbPath);
    return db;
  };
  const hackathonOption = () =>
    new Option("-H, --hackathon <id>", "hackathon id (or HACKEVAL_HACKATHON)").default(
      env.HACKEVAL_HACKATHON,
    );
  const hackathonOf = (o: { hackathon?: string }): string => {
    if (!o.hackathon) throw new CliError("pass --hackathon <id> or set HACKEVAL_HACKATHON");
    return o.hackathon;
  };
  const rubricFrom = (path: string): Rubric => {
    try {
      return loadRubric(path);
    } catch (e) {
      throw new CliError(
        `invalid rubric ${path}:\n${e instanceof ZodError ? e.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n") : String(e)}`,
      );
    }
  };
  const collect = (value: string, previous: string[]) => [...previous, value];

  const program = new Command("hackeval").description("Automated ArmorIQ hackathon judging.");
  program.exitOverride().configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (err += s) });

  program
    .command("init <hackathonId>")
    .description("Create a hackathon.")
    .option("--name <name>", "display name")
    .option("--deadline <iso>", "ISO-8601 with offset, e.g. 2026-10-20T23:59:00Z")
    .action((id: string, o: { name?: string; deadline?: string }) => {
      const deadline = o.deadline ? parseTimestamp(o.deadline, "", "deadline") : null;
      q.createHackathon(database(), id, o.name ?? id, deadline);
      print(`created hackathon ${id}`);
    });

  const rubric = program.command("rubric").description("Validate and activate rubrics.");
  rubric
    .command("validate <path>")
    .description("Check a rubric file against the schema.")
    .action((path: string) => {
      const r = rubricFrom(path);
      print(`ok: ${r.id} v${r.version} (${r.criteria.length} criteria)`);
    });
  rubric
    .command("activate <path>")
    .description("Store a rubric version and make it the one used for scoring.")
    .addOption(hackathonOption())
    .action((path: string, o: { hackathon?: string }) => {
      const r = rubricFrom(path);
      const staled = q.activateRubric(database(), hackathonOf(o), r);
      print(`active rubric for ${hackathonOf(o)}: ${r.id} v${r.version}`);
      if (staled)
        print(`${staled} scored submission(s) marked stale; re-score with \`hackeval run --phase score\``);
    });

  program
    .command("import <csv>")
    .description("Import submissions from a CSV (column mapping in config/intake.yaml).")
    .addOption(hackathonOption())
    .action((csv: string, o: { hackathon?: string }) => {
      const report = importCsv(database(), hackathonOf(o), csv, intakeOf(settings()), nowIso());
      const { errors, late, ...counts } = report;
      print(JSON.stringify(counts));
      for (const line of [...errors, ...late]) err += `${line}\n`;
    });

  program
    .command("add")
    .description("Add one submission.")
    .addOption(hackathonOption())
    .requiredOption("--team <name>", "team name")
    .requiredOption("--repo <url>", "repository URL")
    .option("--deck <pathOrUrl>", "deck file or URL")
    .option("--video <pathOrUrl>", "video file or URL")
    .option("--track <track>", "hackathon track")
    .option("--external-id <id>", "organizer's submission id")
    .action(
      (o: {
        hackathon?: string;
        team: string;
        repo: string;
        deck?: string;
        video?: string;
        track?: string;
        externalId?: string;
      }) => {
        const outcome = addSubmission(
          database(),
          hackathonOf(o),
          {
            teamName: o.team,
            repoUrl: o.repo,
            deck: o.deck,
            video: o.video,
            track: o.track,
            externalId: o.externalId,
          },
          nowIso(),
        );
        print(outcome);
      },
    );

  program
    .command("run")
    .description("Run the pipeline: gate queued submissions, then score gate-passed ones.")
    .addOption(hackathonOption())
    .addOption(new Option("--phase <phase>", "which phase").choices(["gate", "score", "all"]).default("all"))
    .option("--only <id>", "submission id (repeatable)", collect, [])
    .option("--limit <n>", "at most n submissions per phase", (v) => Number.parseInt(v, 10))
    .option("--retry", "requeue submissions in error first", false)
    .action(
      async (o: {
        hackathon?: string;
        phase: "gate" | "score" | "all";
        only: string[];
        limit?: number;
        retry: boolean;
      }) => {
        const id = hackathonOf(o);
        const s = settings();
        const deps = buildDeps(s, q.activeRubric(database(), id), q.getHackathon(database(), id).deadline);
        const report = await new BatchRunner(database(), deps, s.concurrency).run(id, {
          phase: o.phase,
          only: o.only.length ? new Set(o.only) : undefined,
          limit: o.limit,
          retry: o.retry,
        });
        print(JSON.stringify({ processed: report.processed, byStatus: report.byStatus }));
        for (const line of [...report.errors, ...report.skipped]) err += `${line}\n`;
      },
    );

  program
    .command("status")
    .description(
      "Submission counts by status, model usage and estimated cost (prices in config/models.yaml).",
    )
    .addOption(hackathonOption())
    .action((o: { hackathon?: string }) => {
      const id = hackathonOf(o);
      const counts = q.statusCounts(database(), id);
      const byStatus = Object.fromEntries(Object.entries(counts).sort());
      print(JSON.stringify({ byStatus, usage: usageReport(database(), id, modelsOf(settings())) }, null, 2));
    });

  program
    .command("reroute")
    .description("Re-apply config/policy.yaml to stored calibrations (no model calls).")
    .addOption(hackathonOption())
    .action((o: { hackathon?: string }) => {
      const id = hackathonOf(o);
      const report = reroute(database(), id, q.activeRubric(database(), id), policyOf(settings()));
      print(JSON.stringify(report, null, 2));
    });

  const review = program.command("review").description("Work the human review queue.");
  review
    .command("list")
    .description("Submissions waiting for a human.")
    .addOption(hackathonOption())
    .action((o: { hackathon?: string }) => {
      for (const item of reviewQueue(database(), hackathonOf(o)))
        print(`${item.id}  ${item.status.padEnd(15)} ${item.teamName}  ${item.reasons.join("; ")}`);
    });
  review
    .command("show <submissionId>")
    .description("Full evaluation record as JSON.")
    .action((id: string) => {
      const ev = q.getEvaluation(database(), id);
      if (!ev) throw new CliError(`no evaluation for ${id}`);
      print(JSON.stringify(ev, null, 2));
    });
  review
    .command("resolve <submissionId>")
    .description("Record a judge's decision.")
    .addOption(hackathonOption())
    .addOption(
      new Option("--decision <decision>", "decision")
        .choices(["accept", "override", "disqualify", "reinstate", "requeue"])
        .makeOptionMandatory(),
    )
    .requiredOption("--reviewer <name>", "who decided")
    .option("--notes <text>", "notes", "")
    .option("--override <criterion=Label>", "criterion_id=Level label (repeatable)", collect, [])
    .action(
      (
        id: string,
        o: {
          hackathon?: string;
          decision: HumanReview["decision"];
          reviewer: string;
          notes: string;
          override: string[];
        },
      ) => {
        if (o.override.some((pair) => !pair.includes("=")))
          throw new CliError("--override must look like criterion_id=Level label");
        const overrides = Object.fromEntries(
          o.override.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
        );
        const { from, to } = decide(
          database(),
          id,
          { decision: o.decision, reviewer: o.reviewer, notes: o.notes, overrides },
          nowIso(),
        );
        print(`${id}: ${from} -> ${to}`);
      },
    );

  program
    .command("leaderboard")
    .description("Ranked finalized submissions.")
    .addOption(hackathonOption())
    .addOption(
      new Option("--format <format>", "output format").choices(["table", "csv", "json"]).default("table"),
    )
    .action((o: { hackathon?: string; format: string }) => {
      const rows = buildLeaderboard(database(), hackathonOf(o));
      if (o.format === "csv") out += leaderboardCsv(rows);
      else if (o.format === "json") print(JSON.stringify(rows, null, 2));
      else
        for (const r of rows)
          print(
            `${String(r.rank).padStart(3)}. ${r.finalScore.toFixed(2).padStart(6)}  ${r.teamName}${r.overridden ? "  (override)" : ""}`,
          );
    });

  program
    .command("attach <submissionId>")
    .description("Attach a deck/video file to a submission (e.g. when its link was private) and requeue it.")
    .option("--deck <file>", "deck file (PDF or PPTX)")
    .option("--video <file>", "video file")
    .option("--reviewer <name>", "who attached it", "organizer")
    .action((id: string, o: { deck?: string; video?: string; reviewer: string }) => {
      if (!o.deck && !o.video) throw new CliError("pass --deck and/or --video");
      for (const path of [o.deck, o.video])
        if (path && !existsSync(path)) throw new CliError(`file not found: ${path}`);
      const files = { deck: o.deck && resolve(o.deck), video: o.video && resolve(o.video) };
      const { from, to } = attachFiles(database(), id, files, o.reviewer, nowIso());
      if (from === to) {
        print(`${id}: artifact updated (status ${from})`);
        return;
      }
      print(`${id}: ${from} -> ${to}`);
    });

  program
    .command("calibrate <goldCsv>")
    .description("Replay stored results against human gold scores: agreement, review rate, threshold sweep.")
    .addOption(hackathonOption())
    .option(
      "--target-agreement <x>",
      "share of auto-accepted criteria within ±1 level of humans",
      Number,
      0.9,
    )
    .option("--max-review-rate <x>", "highest acceptable share routed to humans", Number, 0.3)
    .option("--full", "include every sweep row", false)
    .action(
      (
        csv: string,
        o: { hackathon?: string; targetAgreement: number; maxReviewRate: number; full: boolean },
      ) => {
        if (!existsSync(csv)) throw new CliError(`file not found: ${csv}`);
        const id = hackathonOf(o);
        const { sweep, ...summary } = calibrationReport(
          database(),
          id,
          csv,
          q.activeRubric(database(), id),
          policyOf(settings()),
          { targetWithin1: o.targetAgreement, maxReviewRate: o.maxReviewRate },
        );
        print(JSON.stringify(o.full ? { ...summary, sweep } : summary, null, 2));
      },
    );

  program
    .command("serve")
    .description("Serve the HTTP API and the web UI (requires HACKEVAL_ADMIN_TOKEN).")
    .option("--host <host>", "interface to bind", "127.0.0.1")
    .option("--port <port>", "port", (v) => Number.parseInt(v, 10), 8000)
    .action(async (o: { host: string; port: number }) => {
      const s = settings();
      if (!s.adminToken)
        throw new CliError("set HACKEVAL_ADMIN_TOKEN before serving (the UI and API always require auth)");
      const app = await buildApp({ settings: s, db: database(), buildDeps, webDist: WEB_DIST, logger: true });
      await app.listen({ host: o.host, port: o.port });
      await new Promise<void>((done) => {
        const stop = () => void app.close().then(() => done());
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  program
    .command("models")
    .description("Show the active LLM provider and model per role.")
    .action(() => {
      const s = settings();
      const models = modelsOf(s);
      const roles = ["deck", "video", "integration", "synthesis", "transcribe"] as const;
      print(
        JSON.stringify({
          provider: s.llmProvider,
          ...Object.fromEntries(roles.map((r) => [r, modelFor(models, s.llmProvider, r)])),
        }),
      );
    });

  try {
    await program.parseAsync(args, { from: "user" });
    return { code: 0, out, err };
  } catch (e) {
    if (e instanceof CommanderError) return { code: e.exitCode, out, err };
    const known = e instanceof CliError || e instanceof StageNotReady || e instanceof q.NotFoundError;
    const message = e instanceof Error ? e.message : String(e);
    return { code: 1, out, err: `${err}${known ? message : `error: ${message}`}\n` };
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  // ADK warns that Workflow is experimental on every run; keep the CLI output clean (errors still show).
  setLogLevel(LogLevel.ERROR);
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
