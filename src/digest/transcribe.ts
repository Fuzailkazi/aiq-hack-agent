/**
 * Timestamped transcription behind one interface, with OpenAI and Gemini implementations.
 * Clients are created lazily, so building a transcriber never needs an API key; the first call does.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import { z } from "zod";
import type { Provider } from "../config";
import type { TranscriptSegment } from "../schemas/evidence";

export interface Transcriber {
  transcribe(audioPath: string): Promise<TranscriptSegment[]>;
}

const GEMINI_PROMPT =
  "Transcribe this audio exactly. Return a JSON array of segments, each with start_s and end_s (seconds from the " +
  "start of this audio) and text. Split at sentence boundaries and keep each segment under 15 seconds. " +
  "Return [] if there is no speech.";
const SegmentsSchema = z.array(z.object({ start_s: z.number(), end_s: z.number(), text: z.string() }));

export class OpenAITranscriber implements Transcriber {
  constructor(
    readonly model = "whisper-1",
    private client?: OpenAI,
  ) {}

  async transcribe(audioPath: string): Promise<TranscriptSegment[]> {
    this.client ??= new OpenAI();
    const result = await this.client.audio.transcriptions.create({
      model: this.model,
      file: await toFile(await readFile(audioPath), basename(audioPath)),
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
    return (result.segments ?? []).map((s) => ({ startS: s.start, endS: s.end, text: s.text.trim() }));
  }
}

/** The subset of @google/genai we use (so tests can pass a stub). */
interface GenerateContent {
  models: { generateContent(request: Record<string, unknown>): Promise<{ text?: string }> };
}

export class GeminiTranscriber implements Transcriber {
  constructor(
    readonly model: string,
    private client?: GenerateContent,
  ) {}

  async transcribe(audioPath: string): Promise<TranscriptSegment[]> {
    this.client ??= new GoogleGenAI({}) as unknown as GenerateContent;
    const data = (await readFile(audioPath)).toString("base64");
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        { role: "user", parts: [{ inlineData: { data, mimeType: "audio/mpeg" } }, { text: GEMINI_PROMPT }] },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(SegmentsSchema),
        temperature: 0,
      },
    });
    let segments: z.infer<typeof SegmentsSchema>;
    try {
      segments = SegmentsSchema.parse(JSON.parse(response.text ?? ""));
    } catch {
      throw new Error("transcription response was not valid JSON segments");
    }
    return segments.map((s) => ({ startS: s.start_s, endS: s.end_s, text: s.text.trim() }));
  }
}

/** Transcribe audio chunks in order, shift timestamps by each chunk's offset, drop empty segments. */
export async function transcribeChunks(
  transcriber: Transcriber,
  chunks: [number, string][],
): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = [];
  for (const [offset, path] of chunks) {
    for (const seg of await transcriber.transcribe(path)) {
      const text = seg.text.trim();
      if (text) out.push({ startS: seg.startS + offset, endS: seg.endS + offset, text });
    }
  }
  return out;
}

export function buildTranscriber(provider: Provider, model: string): Transcriber {
  if (provider === "openai") return new OpenAITranscriber(model);
  if (provider === "gemini") return new GeminiTranscriber(model);
  throw new Error(`unknown LLM provider '${provider}' (expected 'gemini' or 'openai')`);
}
