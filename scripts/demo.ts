/**
 * Seed a demo hackathon you can click through in the UI without any API keys: the fixture submissions run through
 * the real pipeline (gate, routing, review queue, leaderboard) with offline stand-ins for the LLM and Jev stages,
 * real rendered slides and a generated demo video. Then: `HACKEVAL_ADMIN_TOKEN=… npm run demo:serve`.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { IntakeMappingSchema } from "../src/config";
import { digestDeck } from "../src/digest/deck";
import { importCsv } from "../src/intake";
import { BatchRunner } from "../src/pipeline/batch";
import { ArmorIQEvidenceSchema, MediaDigestSchema } from "../src/schemas/evidence";
import { ScorecardSchema } from "../src/schemas/findings";
import { loadRubric } from "../src/schemas/rubric";
import { loadSettings, policyOf } from "../src/settings";
import { openDb } from "../src/store/db";
import * as q from "../src/store/queries";
import { fakeDeps } from "../tests/fakes";
import { FIXTURE, SCRIPT } from "../tests/scenario";
import { hasFfmpeg, makeVideo } from "../tests/videoFixtures";

const WORKSPACE = resolve("workspace/demo");
rmSync(WORKSPACE, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });
const settings = loadSettings({
  ...process.env,
  HACKEVAL_WORKSPACE: WORKSPACE,
  HACKEVAL_DB_PATH: join(WORKSPACE, "hackeval.db"),
});
const db = openDb(settings.dbPath);
const rubric = loadRubric("config/rubrics/example_rubric.yaml");

q.createHackathon(db, "demo", "ArmorIQ Hackathon (demo)", "2026-10-20T23:59:00Z");
q.activateRubric(db, "demo", rubric);
importCsv(db, "demo", FIXTURE, IntakeMappingSchema.parse({}), "2026-10-01T12:00:00Z");

const deck = await digestDeck(
  "tests/fixtures/decks/deck3.pdf",
  join(WORKSPACE, "cache", "media", "demo-deck"),
  {
    maxImages: 10,
  },
);
const video = hasFfmpeg() ? makeVideo(join(WORKSPACE, "demo-video.mp4"), 45) : null;
for (const { submission } of q.currentSubmissions(db, "demo")) {
  if (!video) break;
  mkdirSync(join(WORKSPACE, "media", submission.id), { recursive: true });
  copyFileSync(video, join(WORKSPACE, "media", submission.id, "video.mp4"));
}

const TRANSCRIPT = [
  {
    startS: 0,
    endS: 9,
    text: "Hi judges, we built GuardRail: every tool call our agent makes is intent-checked.",
  },
  {
    startS: 9,
    endS: 21,
    text: "Here is the live demo: the agent tries to email the customer list and ArmorIQ blocks it.",
  },
  {
    startS: 21,
    endS: 33,
    text: "Architecture: the planner captures a plan, we get an intent token, and invoke verifies it.",
  },
  {
    startS: 33,
    endS: 45,
    text: "Next we want policy templates per team and a dashboard for blocked actions.",
  },
];
const LEVELS: Record<string, number[]> = {
  "https://github.com/example/alpha": [3, 3, 2, 2, 3, 2],
  "https://github.com/example/echo": [2, 1, 2, 1, 2, 1],
  "https://github.com/example/golf": [1, 1, 1, 1, 1, 1],
};
const base = fakeDeps(rubric, policyOf(settings), SCRIPT);
const deps = {
  ...base,
  async scanArmoriq() {
    return ArmorIQEvidenceSchema.parse({
      installs: [{ path: "requirements.txt", kind: "manifest", ecosystem: "pypi", package: "armoriq-sdk" }],
      usageSites: [
        {
          path: "agent/guard.py",
          line: 12,
          symbol: "ArmorIQClient",
          kind: "client_init",
          snippet: "client = ArmorIQClient.from_config()",
        },
        {
          path: "agent/guard.py",
          line: 27,
          symbol: "invoke",
          kind: "call",
          snippet: "result = client.invoke(plan, intent_token=token)",
        },
      ],
    });
  },
  async ingestMedia(sub: Parameters<typeof base.ingestMedia>[0]) {
    const media = await base.ingestMedia(sub);
    if (Object.keys(media.unreachable).length) return media;
    return MediaDigestSchema.parse({
      deck,
      video: { durationS: 45, hasSpeech: true, transcript: TRANSCRIPT, keyframes: [] },
    });
  },
  async synthesize(sub: Parameters<typeof base.synthesize>[0]) {
    const levels = LEVELS[sub.repoUrl] ?? [2, 2, 2, 2, 2, 2];
    return ScorecardSchema.parse({
      scores: rubric.criteria.map((c, i) => {
        const level = Math.min(levels[i] ?? 2, c.levels.length - 1);
        const cite =
          c.sources[0] === "repo"
            ? { source: "repo", ref: "agent/guard.py:27" }
            : c.sources.includes("video") && i % 2 === 1
              ? { source: "video", ref: "00:09-00:21" }
              : { source: "deck", ref: `slide ${(i % 3) + 1}` };
        return {
          criterionId: c.id,
          levelLabel: c.levels[level].label,
          level,
          rationale: `${c.levels[level].description} (demo rationale for ${sub.teamName}).`,
          citations: [cite],
        };
      }),
      strengths: ["Clear live demo of a blocked action"],
      weaknesses: ["Architecture slide is light on trade-offs"],
      feedbackMd: `Thanks, ${sub.teamName}! Strong demo; show more of how intent tokens flow between services.`,
    });
  },
};

const report = await new BatchRunner(db, deps, 2).run("demo", { phase: "all" });
console.log(JSON.stringify(report.byStatus));
console.log(`Demo data in ${WORKSPACE}`);
db.close();
