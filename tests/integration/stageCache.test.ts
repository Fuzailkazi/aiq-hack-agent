import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { noul } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BatchRunner } from "../../src/pipeline/batch";
import { buildProductionDeps } from "../../src/pipeline/production";
import { CachingJevClient, StageCache } from "../../src/pipeline/stageCache";
import { EvaluationSchema, GateResultSchema } from "../../src/schemas/evaluation";
import { ArmorIQEvidenceSchema, MediaDigestSchema } from "../../src/schemas/evidence";
import { RubricSchema } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";
import { loadSettings } from "../../src/settings";
import { NO_SECOND_OPINION } from "../../src/stages/calibrate";
import * as q from "../../src/store/queries";
import { FakeJevClient, ScriptedLlm, schemaReply } from "../fakes";
import { exampleRubric, tempDir, testDb } from "../helpers";

const rubric = exampleRubric();

describe("StageCache", () => {
  it("memoizes by content: same inputs hit, different inputs miss", async () => {
    const cache = new StageCache(tempDir());
    let calls = 0;
    const fn = async () => ({ n: ++calls });
    const schema = z.object({ n: z.number() });
    expect(await cache.memo("s", { a: 1, b: [2] }, schema, fn)).toEqual({ n: 1 });
    expect(await cache.memo("s", { b: [2], a: 1 }, schema, fn)).toEqual({ n: 1 }); // key order does not matter
    expect(await cache.memo("s", { a: 2, b: [2] }, schema, fn)).toEqual({ n: 2 });
    expect(await cache.memo("other", { a: 1, b: [2] }, schema, fn)).toEqual({ n: 3 });
    expect(calls).toBe(3);
  });

  it("treats a corrupt or schema-invalid entry as a miss", async () => {
    const dir = tempDir();
    const cache = new StageCache(dir);
    const schema = z.object({ n: z.number() });
    await cache.memo("s", { a: 1 }, schema, async () => ({ n: 1 }));
    const [file] = readdirSync(join(dir, "s"));
    writeFileSync(join(dir, "s", file), "{not json");
    expect(await cache.memo("s", { a: 1 }, schema, async () => ({ n: 2 }))).toEqual({ n: 2 });
  });

  it("caches Jev answers per (model, state, questions)", async () => {
    const inner = new FakeJevClient({ q: 0.7 });
    const jev = new CachingJevClient(inner, new StageCache(tempDir()), "jev-1.13.0");
    const questions = { q: noul("Is it?") };
    await jev.decide({ x: 1 }, questions);
    const again = await jev.decide({ x: 1 }, questions);
    await jev.decide({ x: 2 }, questions);
    expect(inner.calls).toHaveLength(2);
    expect(again.q.value).toBe(0.7);
  });
});

describe("cache keys", () => {
  it("a different rubric under the same id and version is a cache miss (key on content, not name)", async () => {
    const workspace = join(tempDir(), "ws");
    const settings = loadSettings({ HACKEVAL_WORKSPACE: workspace });
    const edited = RubricSchema.parse({
      ...rubric,
      criteria: rubric.criteria.map((c) => ({ ...c, description: `${c.description} (edited)` })),
    });
    const media = MediaDigestSchema.parse({
      deck: { sourceFormat: "pdf", slideCount: 1, slides: [{ index: 1, text: "pitch" }] },
    });
    const sub = SubmissionSchema.parse({
      id: "s",
      hackathonId: "h",
      teamName: "T",
      repoUrl: "https://github.com/o/r",
      submittedAt: "2026-10-01T00:00:00Z",
    });
    const llm = new ScriptedLlm([], schemaReply(rubric));
    const jev = new FakeJevClient();
    await buildProductionDeps(settings, rubric, null, { jev, model: () => llm }).analyze(
      "deck",
      sub,
      media,
      null,
    );
    await buildProductionDeps(settings, rubric, null, { jev, model: () => llm }).analyze(
      "deck",
      sub,
      media,
      null,
    );
    expect(llm.requests).toHaveLength(1); // same rubric: cached
    await buildProductionDeps(settings, edited, null, { jev, model: () => llm }).analyze(
      "deck",
      sub,
      media,
      null,
    );
    expect(llm.requests).toHaveLength(2);
  });
});

describe("production rerun", () => {
  it("re-scoring an unchanged submission makes zero LLM and zero Jev calls", async () => {
    const dir = tempDir();
    const settings = loadSettings({ HACKEVAL_WORKSPACE: join(dir, "ws"), HACKEVAL_LLM_PROVIDER: "openai" });
    const llm = new ScriptedLlm([], schemaReply(rubric));
    const jev = new FakeJevClient({ sufficient: 0.9 });
    const deps = buildProductionDeps(settings, rubric, null, { jev, model: () => llm });
    const db = testDb();
    q.createHackathon(db, "h", "Hack", null);
    q.activateRubric(db, "h", rubric);
    const sub = SubmissionSchema.parse({
      id: "s1",
      hackathonId: "h",
      teamName: "Guard",
      repoUrl: "https://github.com/o/r",
      deck: { kind: "deck", origin: "upload", uri: resolve("tests/fixtures/decks/deck3.pdf") },
      submittedAt: "2026-10-01T00:00:00Z",
    });
    q.upsertSubmission(db, sub, null);
    const evidence = ArmorIQEvidenceSchema.parse({});
    const gate = GateResultSchema.parse({ status: "pass" });
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "s1", status: "scoring", evidence, gate }));

    const first = await new BatchRunner(db, deps, 1).run("h", { phase: "score" });
    expect(first.errors).toEqual([]);
    const llmCalls = llm.requests.length;
    const jevCalls = jev.calls.length;
    expect(llmCalls).toBe(3); // deck analyst, integration analyst, synthesis (no video: no call)
    expect(jevCalls).toBe(rubric.criteria.length + 2); // prescreen + per-criterion + claims
    const before = q.getEvaluation(db, "s1");
    expect(before?.usage).toMatchObject({ llmCalls: 3, jevCalls: rubric.criteria.length + 2 });
    expect(before?.usage.byModel.scripted.calls).toBe(3);

    q.setStatus(db, "s1", "scoring");
    const second = await new BatchRunner(db, deps, 1).run("h", { phase: "score" });
    expect(second.errors).toEqual([]);
    expect(llm.requests.length).toBe(llmCalls);
    expect(jev.calls.length).toBe(jevCalls);
    const after = q.getEvaluation(db, "s1");
    expect(after?.status).toBe(before?.status);
    expect(after?.calibration).toEqual(before?.calibration);
    expect(after?.usage).toEqual(before?.usage); // cache hits cost nothing
  });

  it("with HACKEVAL_SECOND_OPINION=none, scoring makes zero Jev calls and every result waits for a judge", async () => {
    const dir = tempDir();
    const settings = loadSettings({ HACKEVAL_WORKSPACE: join(dir, "ws"), HACKEVAL_SECOND_OPINION: "none" });
    const llm = new ScriptedLlm([], schemaReply(rubric));
    const jev = new FakeJevClient({ sufficient: 0.9 });
    const deps = buildProductionDeps(settings, rubric, null, { jev, model: () => llm });
    const db = testDb();
    q.createHackathon(db, "h", "Hack", null);
    q.activateRubric(db, "h", rubric);
    q.upsertSubmission(
      db,
      SubmissionSchema.parse({
        id: "s1",
        hackathonId: "h",
        teamName: "Guard",
        repoUrl: "https://github.com/o/r",
        deck: { kind: "deck", origin: "upload", uri: resolve("tests/fixtures/decks/deck3.pdf") },
        submittedAt: "2026-10-01T00:00:00Z",
      }),
      null,
    );
    const evidence = ArmorIQEvidenceSchema.parse({});
    const gate = GateResultSchema.parse({ status: "pass" });
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: "s1", status: "scoring", evidence, gate }));

    const run = await new BatchRunner(db, deps, 1).run("h", { phase: "score" });
    expect(run.errors).toEqual([]);
    expect(jev.calls).toHaveLength(0);
    const evaluation = q.getEvaluation(db, "s1");
    expect(evaluation?.status).toBe("needs_review");
    expect(evaluation?.calibration?.reasons[0]).toBe(NO_SECOND_OPINION);
    expect(evaluation?.calibration?.autoScore).toBeGreaterThan(0);
    expect(evaluation?.usage.jevCalls).toBe(0);
  });
});
