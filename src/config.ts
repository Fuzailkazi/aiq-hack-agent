/** Typed loaders for the YAML files in config/. YAML keys are snake_case; code sees camelCase. */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        camelizeKeys(v),
      ]),
    );
  }
  return value;
}

function loadYaml(path: string): unknown {
  const data = parseYaml(readFileSync(path, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`${path} must contain a YAML mapping`);
  return camelizeKeys(data);
}

export const GatePolicySchema = z.object({
  requireInstall: z.boolean().default(true),
  testOnlyUsageCounts: z.boolean().default(false),
  envRequired: z.boolean().default(false),
  jevPass: z.number().min(0).max(1).default(0.8),
  pinToDeadline: z.boolean().default(true),
});
export type GatePolicy = z.infer<typeof GatePolicySchema>;

export const FlagRuleSchema = z.object({ flag: z.string(), op: z.enum(["ge", "le"]), threshold: z.number() });
export type FlagRule = z.infer<typeof FlagRuleSchema>;

export const DEFAULT_FLAG_RULES: FlagRule[] = [
  { flag: "evaluator_injection_attempt", op: "ge", threshold: 0.5 },
  { flag: "claims_unsupported", op: "ge", threshold: 0.7 },
  { flag: "artifacts_describe_same_project", op: "le", threshold: 0.3 },
  { flag: "video_shows_this_project", op: "le", threshold: 0.3 },
  { flag: "deck_is_real_pitch", op: "le", threshold: 0.3 },
];

/** Design §3.5. autoAcceptConfidence is the user-fixed 0.85 bar; the rest are tuned against gold data. */
export const RoutingPolicySchema = z.object({
  autoAcceptConfidence: z.number().min(0).max(1).default(0.85),
  minCriterionAgreement: z.number().min(0).max(1).default(0.5),
  minSufficiency: z.number().min(0).max(1).default(0.6),
  maxLevelGap: z.number().min(0).default(1),
  levelTolerance: z.number().int().min(0).default(0),
  flagRules: z.array(FlagRuleSchema).default(DEFAULT_FLAG_RULES),
  reviewOnCommitsAfterDeadline: z.boolean().default(true),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const PolicySchema = z.object({
  gate: GatePolicySchema.default(GatePolicySchema.parse({})),
  routing: RoutingPolicySchema.default(RoutingPolicySchema.parse({})),
  missingArtifact: z.enum(["review", "disqualify"]).default("review"),
});
export type Policy = z.infer<typeof PolicySchema>;

export const SignaturesSchema = z.object({
  pypiPackages: z.array(z.string()),
  npmPackages: z.array(z.string()),
  pythonModules: z.array(z.string()),
  jsModules: z.array(z.string()),
  knownMethods: z.record(z.string(), z.array(z.string())).default({}),
  envVars: z.array(z.string()),
  configFiles: z.array(z.string()),
  hosts: z.array(z.string()),
  excludeDirs: z.array(z.string()),
  testPathMarkers: z.array(z.string()),
  realKeyPattern: z.string(),
  otherSecretPatterns: z.array(z.string()).default([]),
  placeholderMarkers: z.array(z.string()).default([]),
});
export type Signatures = z.infer<typeof SignaturesSchema>;

/** Our submission field -> CSV column header. */
export const IntakeMappingSchema = z.object({
  teamName: z.string().default("team_name"),
  repoUrl: z.string().default("repo_url"),
  deck: z.string().default("deck"),
  video: z.string().default("video"),
  track: z.string().nullable().default("track"),
  externalId: z.string().nullable().default("external_id"),
  submittedAt: z.string().nullable().default("submitted_at"),
});
export type IntakeMapping = z.infer<typeof IntakeMappingSchema>;

export const ProviderSchema = z.enum(["gemini", "openai"]);
export type Provider = z.infer<typeof ProviderSchema>;
export type Role = "deck" | "video" | "integration" | "synthesis" | "transcribe";

const ModelPriceSchema = z.object({
  inputPerMtok: z.number().default(0),
  outputPerMtok: z.number().default(0),
});

export const ModelsConfigSchema = z.object({
  gemini: z.record(z.string(), z.string()),
  openai: z.record(z.string(), z.string()),
  prices: z.record(z.string(), ModelPriceSchema).default({}),
  /** Optional USD per Jev call, for cost estimates. */
  jevPricePerCall: z.number().nullable().default(null),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export function modelFor(models: ModelsConfig, provider: Provider, role: Role): string {
  const table = provider === "gemini" ? models.gemini : provider === "openai" ? models.openai : undefined;
  if (!table) throw new Error(`unknown LLM provider '${provider}' (expected 'gemini' or 'openai')`);
  const model = table[role];
  if (!model) throw new Error(`models.yaml has no '${role}' model for provider '${provider}'`);
  return model;
}

export const loadPolicy = (path: string): Policy => PolicySchema.parse(loadYaml(path));
export const loadSignatures = (path: string): Signatures => SignaturesSchema.parse(loadYaml(path));
export const loadIntake = (path: string): IntakeMapping => IntakeMappingSchema.parse(loadYaml(path));
export const loadModels = (path: string): ModelsConfig => ModelsConfigSchema.parse(loadYaml(path));
