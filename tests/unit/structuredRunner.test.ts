import { LlmAgent, type LlmRequest, type LlmResponse } from "@google/adk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OUTPUT_KEY, retryAfterS, StructuredRunner } from "../../src/agents/run";
import { ScriptedLlm } from "../fakes";

/** Answers with the queued error codes first (as ADK error events), then valid JSON. */
class FlakyLlm extends ScriptedLlm {
  calls = 0;
  constructor(
    private readonly errors: string[],
    private readonly message = (code: string) => `simulated ${code}`,
  ) {
    super([], () => JSON.stringify({ ok: true }));
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.calls += 1;
    const code = this.errors.shift();
    if (code) {
      yield { errorCode: code, errorMessage: this.message(code) } as LlmResponse;
      return;
    }
    yield* super.generateContentAsync(request);
  }
}

const agent = (model: FlakyLlm) =>
  new LlmAgent({
    name: "probe",
    model,
    instruction: () => "Return JSON.",
    outputSchema: z.object({ ok: z.boolean() }),
    outputKey: OUTPUT_KEY,
  });

describe("StructuredRunner retries", () => {
  it("retries rate limits and overload, then returns the output and counts every call", async () => {
    const llm = new FlakyLlm(["429", "503"]);
    const { data, usage } = await new StructuredRunner(agent(llm), { retries: 3, baseDelayMs: 1 }).run([
      { text: "go" },
    ]);
    expect(data).toEqual({ ok: true });
    expect(llm.calls).toBe(3);
    expect(usage.llmCalls).toBe(3);
  });

  it("retries a dropped connection (ADK reports it as UNKNOWN_ERROR: fetch failed)", async () => {
    const llm = new FlakyLlm(["UNKNOWN_ERROR"], () => "fetch failed");
    const { data } = await new StructuredRunner(agent(llm), { retries: 2, baseDelayMs: 1 }).run([
      { text: "go" },
    ]);
    expect(data).toEqual({ ok: true });
    expect(llm.calls).toBe(2);
  });

  it("gives up after the retry budget and names the error", async () => {
    const llm = new FlakyLlm(["429", "429", "429"]);
    await expect(
      new StructuredRunner(agent(llm), { retries: 1, baseDelayMs: 1 }).run([{ text: "go" }]),
    ).rejects.toThrow(/no structured output \(error=429 message=simulated 429\)/);
    expect(llm.calls).toBe(2);
  });

  it("fails at once on a daily quota (Google says retry in hours) and says when it resets", async () => {
    const llm = new FlakyLlm(
      ["429", "429"],
      () => "You exceeded your current quota, limit: 20. Please retry in 22h9m18.28s.",
    );
    await expect(
      new StructuredRunner(agent(llm), { retries: 5, baseDelayMs: 1 }).run([{ text: "go" }]),
    ).rejects.toThrow(/Google says retry in 22h/);
    expect(llm.calls).toBe(1);
  });

  it("reads Google's retry hint", () => {
    expect(retryAfterS("Please retry in 22h9m18.28s.")).toBeCloseTo(79758.28);
    expect(retryAfterS("Please retry in 41.2s")).toBeCloseTo(41.2);
    expect(retryAfterS("Please retry in 2m")).toBe(120);
    expect(retryAfterS("no hint here")).toBeNull();
  });

  it("does not retry errors that will not clear up", async () => {
    const llm = new FlakyLlm(["400"]);
    await expect(
      new StructuredRunner(agent(llm), { retries: 3, baseDelayMs: 1 }).run([{ text: "go" }]),
    ).rejects.toThrow(/error=400/);
    expect(llm.calls).toBe(1);
  });
});
