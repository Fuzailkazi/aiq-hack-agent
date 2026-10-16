import { describe, expect, it } from "vitest";
import { camelizeKeys, loadIntake, loadModels, loadPolicy, loadSignatures, modelFor } from "../../src/config";
import { loadSettings } from "../../src/settings";

describe("config files", () => {
  it("policy matches the user's rule and the fixed 0.85 bar", () => {
    const policy = loadPolicy("config/policy.yaml");
    expect(policy.gate.requireInstall).toBe(true);
    expect(policy.gate.envRequired).toBe(false);
    expect(policy.gate.jevPass).toBe(0.8);
    expect(policy.missingArtifact).toBe("review");
    expect(policy.routing.autoAcceptConfidence).toBe(0.85);
    expect(policy.routing.flagRules.map((r) => r.flag)).toContain("evaluator_injection_attempt");
  });

  it("signatures cover both SDKs and the real key format", () => {
    const sig = loadSignatures("config/armoriq_signatures.yaml");
    expect(sig.pypiPackages).toContain("armoriq-sdk");
    expect(sig.npmPackages).toContain("@armoriq/sdk");
    expect(sig.excludeDirs).toContain("node_modules");
    expect(sig.realKeyPattern).toContain("live|test|claw");
  });

  it("intake mapping and models", () => {
    expect(loadIntake("config/intake.yaml").teamName).toBe("team_name");
    const models = loadModels("config/models.yaml");
    for (const provider of ["gemini", "openai"] as const) {
      for (const role of ["deck", "video", "integration", "synthesis", "transcribe"] as const) {
        expect(modelFor(models, provider, role)).toBeTruthy();
      }
    }
    expect(modelFor(models, "openai", "transcribe")).toBe("whisper-1");
    expect(() => modelFor(models, "anthropic" as never, "deck")).toThrow(/unknown LLM provider/);
  });

  it("camelizes nested keys but keeps list values", () => {
    expect(camelizeKeys({ a_b: { c_d: [{ e_f: 1 }] }, x: "y_z" })).toEqual({
      aB: { cD: [{ eF: 1 }] },
      x: "y_z",
    });
  });
});

describe("settings", () => {
  it("reads HACKEVAL_* environment overrides", () => {
    const settings = loadSettings({
      HACKEVAL_DB_PATH: "/tmp/x.db",
      HACKEVAL_LLM_PROVIDER: "openai",
      HACKEVAL_CONCURRENCY: "8",
      HACKEVAL_ALLOW_LOCAL_REPOS: "true",
      GITHUB_TOKEN: "ghp_test",
    });
    expect(settings.dbPath).toBe("/tmp/x.db");
    expect(settings.llmProvider).toBe("openai");
    expect(settings.concurrency).toBe(8);
    expect(settings.allowLocalRepos).toBe(true);
    expect(settings.githubToken).toBe("ghp_test");
    expect(settings.jevModel).toBe("jev-1.13.0");
  });

  it("defaults", () => {
    const settings = loadSettings({});
    expect(settings.configDir).toBe("config");
    expect(settings.llmProvider).toBe("gemini");
    expect(settings.allowLocalRepos).toBe(false);
  });

  it("second opinion defaults to jev and can be turned off", () => {
    expect(loadSettings({}).secondOpinion).toBe("jev");
    expect(loadSettings({ HACKEVAL_SECOND_OPINION: "none" }).secondOpinion).toBe("none");
    expect(() => loadSettings({ HACKEVAL_SECOND_OPINION: "llm" })).toThrow();
  });

  it("rejects an unknown provider", () => {
    expect(() => loadSettings({ HACKEVAL_LLM_PROVIDER: "other" })).toThrow();
  });
});

describe("production wiring", () => {
  it("wires every gate and scoring stage", async () => {
    const { buildProductionDeps } = await import("../../src/pipeline/production");
    const { missingStages } = await import("../../src/pipeline/deps");
    const { loadRubric } = await import("../../src/schemas/rubric");
    const deps = buildProductionDeps(
      loadSettings({ HACKEVAL_LLM_PROVIDER: "openai" }),
      loadRubric("config/rubrics/example_rubric.yaml"),
      null,
    );
    expect(missingStages(deps, "gate")).toEqual([]);
    expect(missingStages(deps, "score")).toEqual([]);
  });
});
