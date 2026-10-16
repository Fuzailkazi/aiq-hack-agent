import { describe, expect, it } from "vitest";
import { loadSignatures } from "../../src/config";
import { scanRepo } from "../../src/digest/armoriq";
import { sdkFunctionsUsed } from "../../src/schemas/evidence";
import { FAKE_KEY, GATE_REPOS } from "../gateRepos";
import { writeFiles } from "../gitRepo";
import { tempDir } from "../helpers";

const SIG = loadSignatures("config/armoriq_signatures.yaml");

describe("scanRepo", () => {
  it("collects installs and SDK functions for a Python repo", async () => {
    const evidence = await scanRepo(writeFiles(tempDir(), GATE_REPOS.py_sdk_used.files), SIG);
    expect(evidence.installs.map((i) => i.path)).toEqual(["requirements.txt"]);
    expect(sdkFunctionsUsed(evidence)).toEqual(["capture_plan", "from_config", "get_intent_token"]);
    expect(evidence.unresolved).toEqual([]);
    expect(evidence.secretExposed).toBe(false);
  });

  it("flags and redacts a committed key", async () => {
    const evidence = await scanRepo(writeFiles(tempDir(), GATE_REPOS.committed_secret.files), SIG);
    expect(evidence.secretExposed).toBe(true);
    expect(evidence.redactedKeys).toEqual(["ak_****ffee"]);
    expect(evidence.envSignals.map((s) => [s.var, s.hasRealValue])).toEqual([
      ["ARMORIQ_API_KEY", true],
      ["ARMORIQ_USER_ID", false],
    ]);
    expect(JSON.stringify(evidence)).not.toContain(FAKE_KEY);
  });

  it("records config files, env examples and HTTP calls; ignores node_modules and docs", async () => {
    const evidence = await scanRepo(
      writeFiles(tempDir(), {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env placeholder, as teams write it
        "armoriq.yaml": "api_key: ${ARMORIQ_API_KEY}\n",
        ".env.example": "ARMORIQ_API_KEY=ak_your_key_here\n",
        "src/raw.ts": "// docs: https://api.armoriq.ai\nfetch('https://api.armoriq.ai/v1/plan');\n",
        "node_modules/@armoriq/sdk/index.js": "new ArmorIQClient().invoke()",
        "docs/guide.md": "client.invoke() on api.armoriq.ai",
      }),
      SIG,
    );
    expect(evidence.configFiles).toEqual(["armoriq.yaml"]);
    expect(evidence.envSignals.map((s) => [s.path, s.var, s.hasRealValue])).toEqual([
      [".env.example", "ARMORIQ_API_KEY", false],
    ]);
    expect(evidence.usageSites.map((u) => [u.path, u.line, u.kind])).toEqual([
      ["src/raw.ts", 2, "http_call"],
    ]);
    expect(evidence.installs).toEqual([]);
  });
});
