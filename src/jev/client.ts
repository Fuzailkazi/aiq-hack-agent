/** Thin wrapper over the TypeSafe SDK: pinned model, bounded concurrency, answers normalized to JevDecision. */
import { type Question, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevDecision } from "../schemas/jev";
import { Limiter } from "../util/limiter";

export type JevQuestion = Question;

export interface JevClient {
  decide(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevDecision>>;
}

type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export function toDecision(
  questionId: string,
  answer: Answer,
  model: string,
  requestId: string | null,
): JevDecision {
  const base = { questionId, model, requestId };
  switch (answer.type) {
    case "noul": {
      const p = answer.noul;
      return {
        ...base,
        type: "noul",
        value: p,
        probabilities: { yes: p, no: 1 - p },
        confidence: Math.max(p, 1 - p),
      };
    }
    case "choice":
      return {
        ...base,
        type: "choice",
        value: answer.choice,
        probabilities: { ...answer.probabilities },
        confidence: answer.confidence,
      };
    case "score": {
      const sorted = Object.entries(answer.probabilities).sort(([a], [b]) => Number(a) - Number(b));
      return {
        ...base,
        type: "score",
        value: answer.score,
        probabilities: Object.fromEntries(sorted),
        confidence: answer.confidence,
      };
    }
  }
}

/** Creates the SDK client lazily, so commands that never reach Jev do not need TYPESAFE_API_KEY. */
export class TypeSafeJevClient implements JevClient {
  calls = 0;
  private readonly limiter: Limiter;

  constructor(
    private readonly model: string,
    maxConcurrency = 8,
    private client?: TypeSafeClient,
  ) {
    this.limiter = new Limiter(maxConcurrency);
  }

  async decide(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevDecision>> {
    this.client ??= new TypeSafeClient({ defaultModel: this.model });
    const sdk = this.client;
    const { data, requestId } = await this.limiter.run(() =>
      sdk.systemOne({ state: state as never, questions, model: this.model }).withResponse(),
    );
    this.calls += 1;
    const answers = data.answers as Record<string, Answer>;
    return Object.fromEntries(
      Object.entries(answers).map(([id, answer]) => [
        id,
        toDecision(id, answer, data.model, requestId ?? null),
      ]),
    );
  }
}
