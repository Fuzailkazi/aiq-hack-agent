/** Runtime settings from environment variables (prefix HACKEVAL_), plus the config/ directory loaders. */
import { availableParallelism } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  type IntakeMapping,
  loadIntake,
  loadModels,
  loadPolicy,
  loadSignatures,
  type ModelsConfig,
  type Policy,
  ProviderSchema,
  type Signatures,
} from "./config";

const bool = z.preprocess(
  (v) => (typeof v === "string" ? ["1", "true", "yes"].includes(v.toLowerCase()) : v),
  z.boolean(),
);
const int = (min: number) => z.coerce.number().int().min(min);

export const SettingsSchema = z.object({
  configDir: z.string().default("config"),
  /** CSV column mapping, relative to configDir unless absolute (e.g. intake.flow_state.yaml for the Google Form). */
  intakeFile: z.string().default("intake.yaml"),
  workspace: z.string().default("workspace"),
  dbPath: z.string().default("workspace/hackeval.db"),
  /** Pinned full version; never jev-latest. */
  jevModel: z.string().default("jev-1.13.0"),
  /** "none" runs without Jev (no TYPESAFE_API_KEY needed): the LLM scores and a human reviews every result. */
  secondOpinion: z.enum(["jev", "none"]).default("jev"),
  llmProvider: ProviderSchema.default("gemini"),
  /** Submissions processed in parallel. */
  concurrency: int(1).default(4),
  /** LLM calls in flight at once (provider rate limits). */
  llmConcurrency: int(1).default(4),
  /** ffmpeg / LibreOffice / pdftoppm jobs at once. */
  cpuConcurrency: int(1).default(Math.max(1, Math.floor(availableParallelism() / 2))),
  cloneTimeoutS: int(1).default(180),
  cloneMaxMb: int(0).default(200),
  /** Tests/dev only: permit local-path and file:// repo URLs. */
  allowLocalRepos: bool.default(false),
  soffice: z.string().default("soffice"),
  githubToken: z.string().nullable().default(null),
  /** Google OAuth client for "Sign in with Google" (the UI and API need a signed-in, allowlisted account). */
  googleClientId: z.string().nullable().default(null),
  googleClientSecret: z.string().nullable().default(null),
  /** Who may sign in: comma- or space-separated emails. */
  allowedEmails: z.string().default("fuzail@armoriq.io,isha@armoriq.io"),
  /** HMAC key for session cookies; without it sessions end when the server restarts. */
  sessionSecret: z.string().nullable().default(null),
  /** Where people reach the server; Google redirects back to <publicUrl>/api/auth/google/callback. */
  publicUrl: z.string().default("http://127.0.0.1:8000"),
});
export type Settings = z.infer<typeof SettingsSchema>;

const ENV: Record<string, keyof Settings> = {
  HACKEVAL_CONFIG_DIR: "configDir",
  HACKEVAL_INTAKE: "intakeFile",
  HACKEVAL_WORKSPACE: "workspace",
  HACKEVAL_DB_PATH: "dbPath",
  HACKEVAL_JEV_MODEL: "jevModel",
  HACKEVAL_SECOND_OPINION: "secondOpinion",
  HACKEVAL_LLM_PROVIDER: "llmProvider",
  HACKEVAL_CONCURRENCY: "concurrency",
  HACKEVAL_LLM_CONCURRENCY: "llmConcurrency",
  HACKEVAL_CPU_CONCURRENCY: "cpuConcurrency",
  HACKEVAL_CLONE_TIMEOUT_S: "cloneTimeoutS",
  HACKEVAL_CLONE_MAX_MB: "cloneMaxMb",
  HACKEVAL_ALLOW_LOCAL_REPOS: "allowLocalRepos",
  HACKEVAL_SOFFICE: "soffice",
  GITHUB_TOKEN: "githubToken",
  GOOGLE_OAUTH_CLIENT_ID: "googleClientId",
  GOOGLE_OAUTH_CLIENT_SECRET: "googleClientSecret",
  HACKEVAL_ALLOWED_EMAILS: "allowedEmails",
  HACKEVAL_SESSION_SECRET: "sessionSecret",
  HACKEVAL_PUBLIC_URL: "publicUrl",
};

export function loadSettings(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Settings> = {},
): Settings {
  const raw: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(ENV)) {
    if (env[name]) raw[key] = env[name];
  }
  return SettingsSchema.parse({ ...raw, ...overrides });
}

export const policyOf = (s: Settings): Policy => loadPolicy(join(s.configDir, "policy.yaml"));
export const signaturesOf = (s: Settings): Signatures =>
  loadSignatures(join(s.configDir, "armoriq_signatures.yaml"));
export const intakeOf = (s: Settings): IntakeMapping =>
  loadIntake(isAbsolute(s.intakeFile) ? s.intakeFile : join(s.configDir, s.intakeFile));
export const modelsOf = (s: Settings): ModelsConfig => loadModels(join(s.configDir, "models.yaml"));
