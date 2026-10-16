import { writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { AdkAnalyze, AdkSynthesize } from "../../src/agents/analysts";
import { OpenAILlm } from "../../src/agents/openaiLlm";
import { ArmorIQEvidenceSchema, type MediaDigest, MediaDigestSchema } from "../../src/schemas/evidence";
import { ArtifactFindingsSchema } from "../../src/schemas/findings";
import { forSource } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";
import { UsageMeter } from "../../src/usage";
import { ScriptedLlm } from "../fakes";
import { FAKE_KEY } from "../gateRepos";
import { exampleRubric, tempDir } from "../helpers";

const rubric = exampleRubric();
const SUB = SubmissionSchema.parse({
  id: "s1",
  hackathonId: "h",
  teamName: "Guard",
  repoUrl: "https://github.com/o/r",
  submittedAt: "2026-10-01T00:00:00Z",
});

function deckMedia(): MediaDigest {
  const img = join(tempDir(), "slide-001.png");
  writeFileSync(img, "\x89PNG fake");
  return MediaDigestSchema.parse({
    deck: {
      sourceFormat: "pdf",
      slideCount: 1,
      slides: [{ index: 1, text: "GuardRail verifies every agent action", imagePath: img }],
    },
  });
}

const analystJson = (source: "deck" | "video" | "repo", level = 2) =>
  JSON.stringify({
    summary: "A guard for agents",
    claims: ["every tool call is intent-verified"],
    redFlags: [],
    findings: Object.fromEntries(
      forSource(rubric, source).map((c) => [
        c.id,
        {
          observations: [`${c.name} looks solid`],
          citations: [{ source, ref: "slide 1" }],
          provisionalLevel: c.levels[level].label,
        },
      ]),
    ),
  });

const synthesisJson = () =>
  JSON.stringify({
    scores: Object.fromEntries(
      rubric.criteria.map((c) => [
        c.id,
        { level: c.levels.at(-1)?.label, rationale: "evidence", citations: [] },
      ]),
    ),
    strengths: ["clear"],
    weaknesses: [],
    inconsistencies: [],
    feedbackMd: "Nice work",
  });

describe("LLM output redaction", () => {
  it("findings and scorecards never carry a key the model echoed back", async () => {
    const leak = (json: string) =>
      json.replace("looks solid", `looks solid, key ${FAKE_KEY}`).replace('"evidence"', `"saw ${FAKE_KEY}"`);
    const analyst = new ScriptedLlm([leak(analystJson("deck"))]);
    const findings = await new AdkAnalyze(rubric, () => analyst, new UsageMeter()).analyze(
      "deck",
      SUB,
      deckMedia(),
      null,
    );
    const synth = new ScriptedLlm([leak(synthesisJson())]);
    const card = await new AdkSynthesize(rubric, synth, new UsageMeter()).synthesize(SUB, [findings], null);
    expect(JSON.stringify(findings)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(card)).not.toContain(FAKE_KEY);
  });
});

describe("ADK analyst agents", () => {
  it("deck analyst round trip with images and usage", async () => {
    const llm = new ScriptedLlm([analystJson("deck")]);
    const meter = new UsageMeter();
    const findings = await new AdkAnalyze(rubric, () => llm, meter).analyze("deck", SUB, deckMedia(), null);
    expect(findings.claims).toEqual(["every tool call is intent-verified"]);
    expect(findings.findings.map((f) => f.criterionId).sort()).toEqual(
      forSource(rubric, "deck")
        .map((c) => c.id)
        .sort(),
    );
    expect(findings.findings.every((f) => f.provisionalLabel === "Clear" || f.provisionalLabel)).toBe(true);
    const request = llm.requests[0];
    const system = JSON.stringify(request.config?.systemInstruction);
    expect(system).toContain("pitch deck");
    expect(system).not.toContain("demo_quality"); // video-only criterion is not in the deck analyst's rubric
    const parts = request.contents.flatMap((c) => c.parts ?? []);
    expect(parts.some((p) => p.inlineData?.mimeType === "image/png")).toBe(true);
    expect(meter.pop("s1")).toMatchObject({ llmCalls: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("an absent artifact makes no LLM call", async () => {
    const llm = new ScriptedLlm();
    const findings = await new AdkAnalyze(rubric, () => llm).analyze(
      "video",
      SUB,
      MediaDigestSchema.parse({}),
      null,
    );
    expect(llm.requests).toEqual([]);
    expect(findings.findings.every((f) => f.absent)).toBe(true);
    expect(findings.summary).toBe("No video was submitted.");
  });

  it("an invalid level label from the LLM fails loudly", async () => {
    const bad = JSON.parse(analystJson("deck"));
    bad.findings.problem_solution.provisionalLevel = "Superb";
    const llm = new ScriptedLlm([JSON.stringify(bad)]);
    await expect(new AdkAnalyze(rubric, () => llm).analyze("deck", SUB, deckMedia(), null)).rejects.toThrow();
  });

  it("synthesis builds an indexed scorecard and sees the repo evidence", async () => {
    const llm = new ScriptedLlm([synthesisJson()]);
    const card = await new AdkSynthesize(rubric, llm).synthesize(
      SUB,
      [ArtifactFindingsSchema.parse({ source: "deck", summary: "ok" })],
      ArmorIQEvidenceSchema.parse({}),
    );
    expect(new Set(card.scores.map((s) => s.level))).toEqual(new Set([3]));
    expect(card.feedbackMd).toBe("Nice work");
    const text = llm.requests[0].contents
      .flatMap((c) => c.parts ?? [])
      .map((p) => p.text ?? "")
      .join("\n");
    expect(text).toContain("Install declarations");
  });

  it("works end to end through the OpenAI adapter (offline)", async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "gpt-5-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: analystJson("deck", 3) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const model = new OpenAILlm("gpt-5-mini", new OpenAI({ apiKey: "test", fetch: fakeFetch }));
    const meter = new UsageMeter();
    const findings = await new AdkAnalyze(rubric, () => model, meter).analyze("deck", SUB, deckMedia(), null);
    expect(findings.findings[0].provisionalLabel).toBe("Compelling");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(JSON.stringify(body.messages)).toContain('"type":"image_url"');
    expect(meter.pop("s1")).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });
});
