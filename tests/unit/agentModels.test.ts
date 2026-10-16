import { zodObjectToSchema } from "@google/adk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildModel } from "../../src/agents/models";
import { OpenAILlm, toStrictJsonSchema } from "../../src/agents/openaiLlm";
import { loadModels } from "../../src/config";

const MODELS = loadModels("config/models.yaml");

describe("model factory", () => {
  it("uses plain model ids for Gemini", () => {
    expect(buildModel("gemini", "deck", MODELS)).toBe("gemini-3.5-flash");
  });

  it("uses the OpenAI adapter for OpenAI (no key needed to construct)", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const model = buildModel("openai", "synthesis", MODELS);
    expect(model).toBeInstanceOf(OpenAILlm);
    expect((model as OpenAILlm).model).toBe("gpt-5");
    if (saved) process.env.OPENAI_API_KEY = saved;
  });

  it("rejects unknown providers and roles", () => {
    expect(() => buildModel("anthropic" as never, "deck", MODELS)).toThrow();
    expect(() => buildModel("gemini", "poetry" as never, MODELS)).toThrow();
  });
});

describe("OpenAILlm", () => {
  it("converts ADK's schema to strict JSON Schema", () => {
    const schema = z.object({
      label: z.enum(["Weak", "Strong"]),
      items: z.array(z.object({ ref: z.string(), n: z.number().int() })),
      ok: z.boolean(),
    });
    const strict = toStrictJsonSchema(zodObjectToSchema(schema));
    expect(strict).toEqual({
      type: "object",
      properties: {
        label: { type: "string", enum: ["Weak", "Strong"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { ref: { type: "string" }, n: { type: "integer" } },
            required: ["n", "ref"],
            additionalProperties: false,
          },
        },
        ok: { type: "boolean" },
      },
      required: ["items", "label", "ok"],
      additionalProperties: false,
    });
  });

  it("sends system text, images and a strict json_schema; maps usage", async () => {
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
              message: { role: "assistant", content: '{"label":"Strong"}' },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const llm = new OpenAILlm("gpt-5-mini", new OpenAI({ apiKey: "test", fetch: fakeFetch }));
    const responses = [];
    for await (const r of llm.generateContentAsync({
      model: "gpt-5-mini",
      contents: [
        {
          role: "user",
          parts: [{ text: "SLIDES" }, { inlineData: { data: "cG5n", mimeType: "image/png" } }],
        },
      ],
      config: {
        systemInstruction: "Judge the deck.",
        responseSchema: zodObjectToSchema(z.object({ label: z.enum(["Weak", "Strong"]) })),
      },
      liveConnectConfig: {},
      toolsDict: {},
    } as never)) {
      responses.push(r);
    }
    expect(body.model).toBe("gpt-5-mini");
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: "system", content: "Judge the deck." });
    expect(messages[1].role).toBe("user");
    expect(JSON.stringify(messages[1].content)).toContain('"type":"image_url"');
    expect(JSON.stringify(messages[1].content)).toContain("data:image/png;base64,cG5n");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(responses[0].content?.parts?.[0].text).toBe('{"label":"Strong"}');
    expect(responses[0].usageMetadata).toMatchObject({ promptTokenCount: 100, candidatesTokenCount: 50 });
  });
});
