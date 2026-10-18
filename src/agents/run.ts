/** Run one ADK LlmAgent with a structured output on a single multimodal message. */
import { InMemoryRunner, type LlmAgent } from "@google/adk";
import type { Part } from "@google/genai";
import type { Usage } from "../schemas/evaluation";

export const OUTPUT_KEY = "result";
const APP_NAME = "hackeval-agents";
const USER_ID = "judge";

/**
 * Rate limits, overload ("high demand") and dropped connections clear up on their own, so they are retried.
 * Network failures arrive from ADK as UNKNOWN_ERROR with the fetch error as the message.
 */
export const TRANSIENT =
  /\b(429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)\b|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/i;

export interface RetryPolicy {
  /** Extra attempts after the first. */
  retries: number;
  /** Wait before retry n is baseDelayMs * 2^n (plus up to 20% jitter). */
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 5, baseDelayMs: 15_000 };

/** Longer than this and waiting is pointless (a daily quota): fail at once and say when it resets. */
export const MAX_RETRY_WAIT_S = 300;

/** Google's "Please retry in 22h9m18.28s" (or "retry in 41s") as seconds, or null when absent. */
export function retryAfterS(message: string): number | null {
  const m = /retry in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i.exec(message);
  if (!m?.[1]) return null;
  const part = (unit: string) => Number(new RegExp(`([\\d.]+)${unit}`).exec(m[1])?.[1] ?? 0);
  const seconds = part("h") * 3600 + part("m") * 60 + part("s");
  return seconds > 0 ? seconds : null;
}

const human = (s: number) =>
  s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.ceil(s)}s`;

class AttemptFailed extends Error {
  readonly transient: boolean;
  readonly retryAfterS: number | null;
  constructor(message: string, details: string) {
    const wait = retryAfterS(details);
    const tooLong = wait !== null && wait > MAX_RETRY_WAIT_S;
    super(tooLong ? `${message}; Google says retry in ${human(wait)}` : message);
    this.transient = TRANSIENT.test(details) && !tooLong;
    this.retryAfterS = wait;
  }
}

export class StructuredRunner {
  private readonly runner: InMemoryRunner;

  constructor(
    readonly agent: LlmAgent,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.runner = new InMemoryRunner({ agent, appName: APP_NAME });
  }

  async run(parts: Part[]): Promise<{ data: unknown; usage: Usage }> {
    const usage: Usage = { llmCalls: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, byModel: {} };
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await this.attempt(parts, usage);
        return { data, usage };
      } catch (e) {
        if (!(e instanceof AttemptFailed) || !e.transient || attempt >= this.retry.retries) throw e;
        // Wait as long as Google asks when it says; otherwise back off exponentially.
        const delay =
          e.retryAfterS !== null ? e.retryAfterS * 1000 + 500 : this.retry.baseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * delay * 0.2));
      }
    }
  }

  private async attempt(parts: Part[], usage: Usage): Promise<unknown> {
    const sessions = this.runner.sessionService;
    const session = await sessions.createSession({ appName: APP_NAME, userId: USER_ID });
    const model = this.agent.model;
    const id = typeof model === "string" ? model : (model?.model ?? "unknown");
    usage.byModel[id] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
    const byModel = usage.byModel[id];
    usage.llmCalls += 1;
    byModel.calls += 1;
    let result: unknown;
    /** Why the final event carried no output, for the error message (finish reason, error, start of the text). */
    let lastEvent = "";
    let errorCode = "";
    try {
      for await (const event of this.runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: { role: "user", parts },
      })) {
        const input = event.usageMetadata?.promptTokenCount ?? 0;
        const output = event.usageMetadata?.candidatesTokenCount ?? 0;
        usage.inputTokens += input;
        usage.outputTokens += output;
        byModel.inputTokens += input;
        byModel.outputTokens += output;
        const text = (event.content?.parts ?? []).map((p) => p.text ?? "").join("");
        const e = event as { errorCode?: string; errorMessage?: string; finishReason?: string };
        errorCode = e.errorCode ? `${e.errorCode} ${e.errorMessage ?? ""}` : "";
        lastEvent = [
          e.finishReason && `finish=${e.finishReason}`,
          e.errorCode && `error=${e.errorCode}`,
          e.errorMessage && `message=${e.errorMessage.slice(0, 200)}`,
          text &&
            `text=${JSON.stringify(text.slice(0, 200))}${text.length > 200 ? `...(${text.length} chars)` : ""}`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      const final = await sessions.getSession({ appName: APP_NAME, userId: USER_ID, sessionId: session.id });
      result = final?.state[OUTPUT_KEY];
    } catch (e) {
      // Some transport errors are thrown instead of arriving as an error event.
      const message = e instanceof Error ? e.message : String(e);
      throw new AttemptFailed(`agent ${this.agent.name} failed: ${message.slice(0, 300)}`, message);
    } finally {
      await sessions.deleteSession({ appName: APP_NAME, userId: USER_ID, sessionId: session.id });
    }
    if (!result || typeof result !== "object")
      throw new AttemptFailed(
        `agent ${this.agent.name} returned no structured output${lastEvent ? ` (${lastEvent})` : ""}`,
        errorCode,
      );
    return result;
  }
}
