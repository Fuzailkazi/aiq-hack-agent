/**
 * OpenAI models for ADK JS, which ships only Gemini/Apigee adapters. Converts the ADK request (system instruction,
 * text + inline images, response schema) to Chat Completions with a strict json_schema, and maps the reply and
 * token usage back.
 */
import { BaseLlm, type LlmRequest, type LlmResponse } from "@google/adk";
import OpenAI from "openai";

type JsonSchema = Record<string, unknown>;
const TYPES: Record<string, string> = {
  OBJECT: "object",
  ARRAY: "array",
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
};

/** ADK/Gemini `Schema` (type "OBJECT", ...) -> OpenAI strict JSON Schema (all fields required, closed objects). */
export function toStrictJsonSchema(schema: unknown): JsonSchema {
  const s = (schema ?? {}) as Record<string, unknown>;
  const type = TYPES[String(s.type ?? "").toUpperCase()] ?? String(s.type ?? "string").toLowerCase();
  const out: JsonSchema = { type };
  if (s.description) out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (type === "array") out.items = toStrictJsonSchema(s.items);
  if (type === "object") {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toStrictJsonSchema(v)]));
    out.required = Object.keys(props).sort();
    out.additionalProperties = false;
  }
  return out;
}

type Part = { text?: string; inlineData?: { data?: string; mimeType?: string } };
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

function systemText(instruction: unknown): string | null {
  if (!instruction) return null;
  if (typeof instruction === "string") return instruction;
  const parts = ((instruction as { parts?: Part[] }).parts ?? []) as Part[];
  return parts.map((p) => p.text ?? "").join("\n") || null;
}

function toParts(parts: Part[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const p of parts) {
    if (p.text) out.push({ type: "text", text: p.text });
    else if (p.inlineData?.data && p.inlineData.mimeType?.startsWith("image/")) {
      out.push({
        type: "image_url",
        image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
      });
    }
  }
  return out;
}

export class OpenAILlm extends BaseLlm {
  constructor(
    model: string,
    private client?: OpenAI,
  ) {
    super({ model });
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.client ??= new OpenAI();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    const system = systemText(request.config?.systemInstruction);
    if (system) messages.push({ role: "system", content: system });
    for (const content of request.contents ?? []) {
      const parts = toParts((content.parts ?? []) as Part[]);
      if (!parts.length) continue;
      if (content.role === "model") {
        messages.push({
          role: "assistant",
          content: parts.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
        });
      } else messages.push({ role: "user", content: parts });
    }
    const schema = request.config?.responseSchema;
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(schema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "output", strict: true, schema: toStrictJsonSchema(schema) },
            },
          }
        : {}),
    });
    yield {
      content: { role: "model", parts: [{ text: completion.choices[0]?.message?.content ?? "" }] },
      usageMetadata: {
        promptTokenCount: completion.usage?.prompt_tokens,
        candidatesTokenCount: completion.usage?.completion_tokens,
        totalTokenCount: completion.usage?.total_tokens,
      },
    } as LlmResponse;
  }

  override async connect(): Promise<never> {
    throw new Error("OpenAILlm does not support live connections");
  }
}
