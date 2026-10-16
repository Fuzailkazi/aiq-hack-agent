/** Production pipeline wiring: the real stage implementations behind PipelineDeps. */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { acquireRepo } from "../acquire/repo";
import { AdkAnalyze, AdkSynthesize } from "../agents/analysts";
import { buildModel, type Model } from "../agents/models";
import { PROMPT_VERSION } from "../agents/prompts";
import { modelFor, type Role } from "../config";
import { scanRepo } from "../digest/armoriq";
import { DEFAULT_LIMITS, ingestMedia } from "../digest/media";
import { buildTranscriber } from "../digest/transcribe";
import { type JevClient, TypeSafeJevClient } from "../jev/client";
import type { Rubric } from "../schemas/rubric";
import { modelsOf, policyOf, type Settings, signaturesOf } from "../settings";
import { calibrate } from "../stages/calibrate";
import { decideGate } from "../stages/gate";
import { prescreen } from "../stages/prescreen";
import { UsageMeter } from "../usage";
import { Limiter } from "../util/limiter";
import type { PipelineDeps } from "./deps";
import { CachingJevClient, StageCache, stableJson, withStageCache } from "./stageCache";

export interface ProductionOptions {
  /** Inject a Jev client (tests); production creates a lazy TypeSafe client. */
  jev?: JevClient;
  /** Inject the agents' model (tests); production builds it from config/models.yaml. */
  model?: (role: Role) => Model;
}

const ROLES: Role[] = ["deck", "video", "integration", "synthesis", "transcribe"];

export function buildProductionDeps(
  settings: Settings,
  rubric: Rubric,
  deadline: string | null,
  opts: ProductionOptions = {},
): PipelineDeps {
  const policy = policyOf(settings);
  const signatures = signaturesOf(settings);
  const models = modelsOf(settings);
  const provider = settings.llmProvider;
  const cache = new StageCache(join(settings.workspace, "cache", "stages"));
  const meter = new UsageMeter();
  // The cache wraps the meter, so only real Jev calls are counted.
  const jev =
    settings.secondOpinion === "none"
      ? null
      : new CachingJevClient(
          meter.jev(opts.jev ?? new TypeSafeJevClient(settings.jevModel)),
          cache,
          settings.jevModel,
        );
  const llm = new Limiter(settings.llmConcurrency);
  const cpu = new Limiter(settings.cpuConcurrency);
  const model = opts.model ?? ((role: Role) => buildModel(provider, role, models));
  const transcriber = buildTranscriber(provider, modelFor(models, provider, "transcribe"));
  const limits = { ...DEFAULT_LIMITS, soffice: settings.soffice };
  const analyzer = new AdkAnalyze(rubric, model, meter);
  const synthesizer = new AdkSynthesize(rubric, model("synthesis"), meter);
  const versions = {
    // Content hash, not id@version: versions are only unique per hackathon, and the cache is workspace-wide.
    rubric: createHash("sha256").update(stableJson(rubric)).digest("hex"),
    prompts: PROMPT_VERSION,
    provider,
    models: Object.fromEntries(ROLES.map((role) => [role, modelFor(models, provider, role)])),
  };
  const deps: PipelineDeps = {
    rubric,
    policy,
    acquireRepo: (sub) =>
      acquireRepo(sub, {
        workspace: settings.workspace,
        deadline,
        pinToDeadline: policy.gate.pinToDeadline,
        timeoutS: settings.cloneTimeoutS,
        maxMb: settings.cloneMaxMb,
        githubToken: settings.githubToken,
        allowLocal: settings.allowLocalRepos,
      }),
    scanArmoriq: (repoPath) => scanRepo(repoPath, signatures),
    decideGate: (evidence, snapshot) => decideGate(evidence, snapshot, policy.gate, jev),
    ingestMedia: (sub) => ingestMedia(sub, { workspace: settings.workspace, transcriber, limits, cpu }),
    prescreen: (sub, media) => prescreen(sub, media, jev, rubric),
    analyze: (source, sub, media, evidence) => llm.run(() => analyzer.analyze(source, sub, media, evidence)),
    synthesize: (sub, findings, evidence) => llm.run(() => synthesizer.synthesize(sub, findings, evidence)),
    usage: meter,
    calibrate: (sub, card, media, pre, evidence, gateFlags) =>
      calibrate(sub, card, media, pre, evidence, gateFlags, { rubric, policy: policy.routing, jev }),
  };
  return withStageCache(deps, cache, versions);
}
