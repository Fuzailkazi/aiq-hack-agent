/**
 * Content-addressed cache for model-calling stages, so a rerun (retry, requeue, attach of one artifact)
 * repeats no LLM or Jev call whose inputs are unchanged. Keys hash the stage name, every input the model sees,
 * and the versions that shape its answer (rubric, prompts, model ids, Jev model).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { JevClient, JevQuestion } from "../jev/client";
import { ArtifactFindingsSchema, ScorecardSchema } from "../schemas/findings";
import { JevDecisionSchema } from "../schemas/jev";
import type { PipelineDeps } from "./deps";

/** JSON with object keys sorted, so logically equal inputs hash equally. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export class StageCache {
  constructor(private readonly dir: string) {}

  key(stage: string, inputs: unknown): string {
    return createHash("sha256").update(stableJson({ stage, inputs })).digest("hex");
  }

  async memo<T>(stage: string, inputs: unknown, schema: z.ZodType<T>, compute: () => Promise<T>): Promise<T> {
    const dir = join(this.dir, stage);
    const path = join(dir, `${this.key(stage, inputs)}.json`);
    try {
      return schema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Missing, corrupt or from an older schema: recompute.
    }
    const value = await compute();
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
    return value;
  }
}

const DecisionsSchema = z.record(z.string(), JevDecisionSchema);

/** Wraps any Jev client; answers are cached per (model, state, questions). */
export class CachingJevClient implements JevClient {
  constructor(
    private readonly inner: JevClient,
    private readonly cache: StageCache,
    private readonly model: string,
  ) {}

  decide(state: unknown, questions: Record<string, JevQuestion>) {
    return this.cache.memo("jev", { model: this.model, state, questions }, DecisionsSchema, () =>
      this.inner.decide(state, questions),
    );
  }
}

export interface CacheVersions {
  rubric: string;
  prompts: string;
  provider: string;
  models: Record<string, string>;
}

/** Cache the LLM stages. Each analyst keys only on its own artifact, so attaching a new video keeps the deck's. */
export function withStageCache(deps: PipelineDeps, cache: StageCache, versions: CacheVersions): PipelineDeps {
  return {
    ...deps,
    analyze: (source, sub, media, evidence) => {
      const input =
        source === "deck"
          ? media.deck
          : source === "video"
            ? media.video
            : source === "form"
              ? {
                  answers: sub.answers,
                  liveDemoUrl: sub.liveDemoUrl,
                  liveDemo: media.liveDemo,
                  partners: evidence?.partners ?? {},
                }
              : evidence;
      const team = { teamName: sub.teamName, repoUrl: sub.repoUrl };
      return cache.memo(`analyze-${source}`, { versions, team, input }, ArtifactFindingsSchema, () =>
        deps.analyze(source, sub, media, evidence),
      );
    },
    synthesize: (sub, findings, evidence) => {
      const team = { teamName: sub.teamName, repoUrl: sub.repoUrl };
      return cache.memo("synthesize", { versions, team, findings, evidence }, ScorecardSchema, () =>
        deps.synthesize(sub, findings, evidence),
      );
    },
  };
}
