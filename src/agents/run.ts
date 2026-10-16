/** Run one ADK LlmAgent with a structured output on a single multimodal message. */
import { InMemoryRunner, type LlmAgent } from "@google/adk";
import type { Part } from "@google/genai";
import type { Usage } from "../schemas/evaluation";

export const OUTPUT_KEY = "result";
const APP_NAME = "hackeval-agents";
const USER_ID = "judge";

export class StructuredRunner {
  private readonly runner: InMemoryRunner;

  constructor(readonly agent: LlmAgent) {
    this.runner = new InMemoryRunner({ agent, appName: APP_NAME });
  }

  async run(parts: Part[]): Promise<{ data: unknown; usage: Usage }> {
    const sessions = this.runner.sessionService;
    const session = await sessions.createSession({ appName: APP_NAME, userId: USER_ID });
    const usage: Usage = { llmCalls: 1, inputTokens: 0, outputTokens: 0, jevCalls: 0, byModel: {} };
    let result: unknown;
    try {
      for await (const event of this.runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: { role: "user", parts },
      })) {
        usage.inputTokens += event.usageMetadata?.promptTokenCount ?? 0;
        usage.outputTokens += event.usageMetadata?.candidatesTokenCount ?? 0;
      }
      const final = await sessions.getSession({ appName: APP_NAME, userId: USER_ID, sessionId: session.id });
      result = final?.state[OUTPUT_KEY];
      const model = this.agent.model;
      const id = typeof model === "string" ? model : (model?.model ?? "unknown");
      usage.byModel[id] = { calls: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    } finally {
      await sessions.deleteSession({ appName: APP_NAME, userId: USER_ID, sessionId: session.id });
    }
    if (!result || typeof result !== "object")
      throw new Error(`agent ${this.agent.name} returned no structured output`);
    return { data: result, usage };
  }
}
