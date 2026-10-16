import { writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  buildTranscriber,
  GeminiTranscriber,
  OpenAITranscriber,
  transcribeChunks,
} from "../../src/digest/transcribe";
import type { TranscriptSegment } from "../../src/schemas/evidence";
import { tempDir } from "../helpers";

const audio = (): string => {
  const path = join(tempDir(), "audio-000.mp3");
  writeFileSync(path, "ID3fake-mp3-bytes");
  return path;
};

describe("OpenAI transcription", () => {
  it("asks for verbose_json segments", async () => {
    const seen: { url?: string; body?: string } = {};
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.url = String(input);
      seen.body = await new Response(init?.body as ConstructorParameters<typeof Response>[0]).text();
      return new Response(
        JSON.stringify({
          task: "transcribe",
          language: "english",
          duration: 6,
          text: "Hello judges. This is our demo.",
          segments: [
            { id: 0, start: 0, end: 2.5, text: " Hello judges." },
            { id: 1, start: 2.5, end: 6, text: " This is our demo." },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new OpenAI({ apiKey: "test", fetch: fakeFetch });
    const segments = await new OpenAITranscriber("whisper-1", client).transcribe(audio());
    expect(seen.url).toContain("/audio/transcriptions");
    expect(seen.body).toMatch(/name="response_format"\r\n\r\nverbose_json/);
    expect(seen.body).toMatch(/name="model"\r\n\r\nwhisper-1/);
    expect(segments).toEqual([
      { startS: 0, endS: 2.5, text: "Hello judges." },
      { startS: 2.5, endS: 6, text: "This is our demo." },
    ]);
  });
});

const geminiClient = (reply: string, calls: unknown[] = []) => ({
  models: {
    generateContent: async (request: unknown) => {
      calls.push(request);
      return { text: reply };
    },
  },
});

describe("Gemini transcription", () => {
  it("asks for JSON segments with the audio inline", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = geminiClient(
      JSON.stringify([{ start_s: 0, end_s: 3.2, text: "We built a guard." }]),
      calls,
    );
    const segments = await new GeminiTranscriber("gemini-3.5-flash", client).transcribe(audio());
    const call = calls[0] as {
      model: string;
      config: { responseMimeType: string };
      contents: { parts: { inlineData?: { mimeType: string } }[] }[];
    };
    expect(call.model).toBe("gemini-3.5-flash");
    expect(call.config.responseMimeType).toBe("application/json");
    expect(call.contents[0].parts[0].inlineData?.mimeType).toBe("audio/mpeg");
    expect(segments).toEqual([{ startS: 0, endS: 3.2, text: "We built a guard." }]);
  });

  it("rejects a non-JSON reply", async () => {
    await expect(
      new GeminiTranscriber("m", geminiClient("Sorry, I can't")).transcribe(audio()),
    ).rejects.toThrow(/not valid JSON segments/);
  });
});

describe("chunk merging", () => {
  it("offsets timestamps by chunk start and drops empty text", async () => {
    const calls: string[] = [];
    const fake = {
      async transcribe(path: string): Promise<TranscriptSegment[]> {
        calls.push(path);
        return [
          { startS: 1, endS: 2, text: `  part of ${path} ` },
          { startS: 2, endS: 3, text: "   " },
        ];
      },
    };
    const out = await transcribeChunks(fake, [
      [0, "a.mp3"],
      [600, "b.mp3"],
    ]);
    expect(out).toEqual([
      { startS: 1, endS: 2, text: "part of a.mp3" },
      { startS: 601, endS: 602, text: "part of b.mp3" },
    ]);
  });

  it("builds transcribers lazily per provider", () => {
    expect(buildTranscriber("openai", "whisper-1")).toBeInstanceOf(OpenAITranscriber);
    expect(buildTranscriber("gemini", "gemini-3.5-flash")).toBeInstanceOf(GeminiTranscriber);
    expect(() => buildTranscriber("other" as never, "x")).toThrow(/unknown LLM provider/);
  });
});
