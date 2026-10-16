/** Model usage per submission (LLM tokens per model, Jev calls) and cost estimates for `hackeval status`. */
import type { ModelsConfig } from "./config";
import type { JevClient } from "./jev/client";
import type { Usage } from "./schemas/evaluation";
import type { DB } from "./store/db";
import * as q from "./store/queries";
import { submissionScope } from "./util/context";

export const emptyUsage = (): Usage => ({
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  jevCalls: 0,
  byModel: {},
});

export function addUsage(a: Usage, b: Usage): Usage {
  const byModel = { ...a.byModel };
  for (const [model, m] of Object.entries(b.byModel)) {
    const prev = byModel[model] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    byModel[model] = {
      calls: prev.calls + m.calls,
      inputTokens: prev.inputTokens + m.inputTokens,
      outputTokens: prev.outputTokens + m.outputTokens,
    };
  }
  return {
    llmCalls: a.llmCalls + b.llmCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    jevCalls: a.jevCalls + b.jevCalls,
    byModel,
  };
}

/** USD from configured prices; null (with what is unpriced) unless every model used, and Jev, has a price. */
export function estimateCost(usage: Usage, models: ModelsConfig): { usd: number | null; unpriced: string[] } {
  let usd = 0;
  const unpriced: string[] = [];
  for (const [model, m] of Object.entries(usage.byModel)) {
    const price = models.prices[model];
    if (!price) unpriced.push(model);
    else usd += (m.inputTokens * price.inputPerMtok + m.outputTokens * price.outputPerMtok) / 1_000_000;
  }
  if (usage.jevCalls) {
    if (models.jevPricePerCall === null) unpriced.push("jev");
    else usd += usage.jevCalls * models.jevPricePerCall;
  }
  return { usd: unpriced.length ? null : Math.round(usd * 10_000) / 10_000, unpriced };
}

/** Per-submission usage collected while a submission runs; the batch runner pops it into the evaluation. */
export class UsageMeter {
  private readonly bySubmission = new Map<string, Usage>();

  add(submissionId: string, usage: Usage): void {
    this.bySubmission.set(submissionId, addUsage(this.bySubmission.get(submissionId) ?? emptyUsage(), usage));
  }

  pop(submissionId: string): Usage {
    const usage = this.bySubmission.get(submissionId) ?? emptyUsage();
    this.bySubmission.delete(submissionId);
    return usage;
  }

  /** Count real Jev calls against the submission in scope (wrap inside any cache, so hits are free). */
  jev(inner: JevClient): JevClient {
    return {
      decide: async (state, questions) => {
        const answers = await inner.decide(state, questions);
        const id = submissionScope.getStore();
        if (id) this.add(id, { ...emptyUsage(), jevCalls: 1 });
        return answers;
      },
    };
  }
}

export interface UsageReport {
  submissions: number;
  usage: Usage;
  estimatedCostUsd: number | null;
  costPerSubmissionUsd: number | null;
  unpriced: string[];
}

export function usageReport(db: DB, hackathonId: string, models: ModelsConfig): UsageReport {
  let usage = emptyUsage();
  let submissions = 0;
  for (const { submission } of q.currentSubmissions(db, hackathonId)) {
    const ev = q.getEvaluation(db, submission.id);
    if (!ev) continue;
    usage = addUsage(usage, ev.usage);
    submissions += 1;
  }
  const { usd, unpriced } = estimateCost(usage, models);
  const perSubmission =
    usd !== null && submissions ? Math.round((usd / submissions) * 10_000) / 10_000 : null;
  return { submissions, usage, estimatedCostUsd: usd, costPerSubmissionUsd: perSubmission, unpriced };
}
