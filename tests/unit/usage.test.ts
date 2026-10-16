import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AdkAnalyze } from "../../src/agents/analysts";
import { ModelsConfigSchema } from "../../src/config";
import { ingestMedia } from "../../src/digest/media";
import type { Transcriber } from "../../src/digest/transcribe";
import { buildProductionDeps } from "../../src/pipeline/production";
import { MediaDigestSchema } from "../../src/schemas/evidence";
import { SubmissionSchema } from "../../src/schemas/submission";
import { loadSettings } from "../../src/settings";
import { addUsage, emptyUsage, estimateCost, UsageMeter } from "../../src/usage";
import { submissionScope } from "../../src/util/context";
import { Limiter } from "../../src/util/limiter";
import { FakeJevClient, ScriptedLlm, SlowLlm, schemaReply } from "../fakes";
import { exampleRubric, tempDir } from "../helpers";

const rubric = exampleRubric();
const SUB = SubmissionSchema.parse({
  id: "s1",
  hackathonId: "h",
  teamName: "Guard",
  repoUrl: "https://github.com/o/r",
  submittedAt: "2026-10-01T00:00:00Z",
});
const models = (prices: object = {}, jevPricePerCall: number | null = null) =>
  ModelsConfigSchema.parse({ gemini: {}, openai: {}, prices, jevPricePerCall });

describe("usage accounting", () => {
  it("adds totals and per-model counts", () => {
    const a = {
      ...emptyUsage(),
      llmCalls: 1,
      inputTokens: 100,
      outputTokens: 10,
      byModel: { m: { calls: 1, inputTokens: 100, outputTokens: 10 } },
    };
    const b = {
      ...emptyUsage(),
      llmCalls: 2,
      inputTokens: 50,
      outputTokens: 5,
      jevCalls: 3,
      byModel: {
        m: { calls: 2, inputTokens: 50, outputTokens: 5 },
        n: { calls: 0, inputTokens: 0, outputTokens: 0 },
      },
    };
    const sum = addUsage(a, b);
    expect(sum).toMatchObject({ llmCalls: 3, inputTokens: 150, outputTokens: 15, jevCalls: 3 });
    expect(sum.byModel.m).toEqual({ calls: 3, inputTokens: 150, outputTokens: 15 });
    expect(Object.keys(sum.byModel).sort()).toEqual(["m", "n"]);
  });

  it("estimates cost only when every model used has a price", () => {
    const usage = {
      ...emptyUsage(),
      jevCalls: 10,
      byModel: { m: { calls: 1, inputTokens: 2_000_000, outputTokens: 1_000_000 } },
    };
    expect(estimateCost(usage, models({ m: { inputPerMtok: 0.5, outputPerMtok: 2 } }, 0.001))).toEqual({
      usd: 3.01,
      unpriced: [],
    });
    expect(estimateCost(usage, models({}, 0.001))).toEqual({ usd: null, unpriced: ["m"] });
    expect(estimateCost(usage, models({ m: { inputPerMtok: 0.5, outputPerMtok: 2 } }))).toEqual({
      usd: null,
      unpriced: ["jev"],
    });
  });

  it("attributes Jev calls to the submission in scope, including concurrent ones", async () => {
    const meter = new UsageMeter();
    const jev = meter.jev(new FakeJevClient());
    await Promise.all([
      submissionScope.run("a", () => jev.decide({}, {})),
      submissionScope.run("b", async () => {
        await jev.decide({}, {});
        await jev.decide({}, {});
      }),
    ]);
    await jev.decide({}, {}); // outside any submission: not attributed
    expect(meter.pop("a").jevCalls).toBe(1);
    expect(meter.pop("b").jevCalls).toBe(2);
  });

  it("records LLM usage per model id", async () => {
    const meter = new UsageMeter();
    const llm = new ScriptedLlm([JSON.stringify({ summary: "s", claims: [], redFlags: [], findings: {} })]);
    const media = MediaDigestSchema.parse({
      deck: { sourceFormat: "pdf", slideCount: 1, slides: [{ index: 1, text: "x" }] },
    });
    await new AdkAnalyze(rubric, () => llm, meter).analyze("deck", SUB, media, null).catch(() => undefined);
    expect(meter.pop("s1").byModel.scripted).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5 });
  });
});

describe("concurrency limits", () => {
  it("caps concurrent LLM calls at HACKEVAL_LLM_CONCURRENCY", async () => {
    const media = MediaDigestSchema.parse({
      deck: { sourceFormat: "pdf", slideCount: 1, slides: [{ index: 1, text: "x" }] },
      video: {
        durationS: 5,
        hasSpeech: true,
        transcript: [{ startS: 0, endS: 5, text: "hi" }],
        keyframes: [],
      },
    });
    for (const [limit, peak] of [
      ["1", 1],
      ["4", 2], // deck + video; the repo analyst makes no call without evidence
    ] as const) {
      const llm = new SlowLlm(schemaReply(rubric));
      const settings = loadSettings({ HACKEVAL_WORKSPACE: tempDir(), HACKEVAL_LLM_CONCURRENCY: limit });
      const deps = buildProductionDeps(settings, rubric, null, {
        jev: new FakeJevClient(),
        model: () => llm,
      });
      await Promise.all((["deck", "video", "repo"] as const).map((s) => deps.analyze(s, SUB, media, null)));
      expect(llm.peak).toBe(peak);
    }
  });

  it("media digests run their CPU-heavy steps through the CPU limiter", async () => {
    class Spy extends Limiter {
      runs = 0;
      override run<T>(task: () => Promise<T>): Promise<T> {
        this.runs += 1;
        return super.run(task);
      }
    }
    const cpu = new Spy(1);
    const sub = {
      ...SUB,
      deck: {
        kind: "deck" as const,
        origin: "upload" as const,
        uri: resolve("tests/fixtures/decks/deck3.pdf"),
        sha256: null,
        unreachableReason: null,
      },
    };
    const transcriber: Transcriber = { transcribe: async () => [] };
    const media = await ingestMedia(sub, { workspace: tempDir(), transcriber, cpu });
    expect(media.deck?.slideCount).toBe(3);
    expect(cpu.runs).toBe(1);
  });
});
