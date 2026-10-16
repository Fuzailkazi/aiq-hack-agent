import { beforeAll, describe, expect, it } from "vitest";
import { scanJs, scanSfc } from "../../src/digest/armoriq/jsUsage";
import { SecretRedactor } from "../../src/digest/armoriq/secrets";
import { initTreeSitter } from "../../src/digest/armoriq/treeSitter";

const REDACTOR = new SecretRedactor();
const MODULES = ["@armoriq/sdk"];
const scan = (source: string, suffix = ".ts") => {
  const { sites, unresolved } = scanJs(`x${suffix}`, source, suffix, MODULES, false, REDACTOR);
  return { got: sites.map((s) => [s.kind, s.symbol, s.line]), unresolved, sites };
};

beforeAll(async () => {
  await initTreeSitter();
});

describe("JS/TS usage", () => {
  it("ESM named import, new and method calls", () => {
    const { got, unresolved } = scan(
      "import { ArmorIQClient } from '@armoriq/sdk';\n" +
        "const client = new ArmorIQClient({ apiKey: process.env.ARMORIQ_API_KEY });\n" +
        "export async function run() {\n" +
        "  const plan = await client.capturePlan({ llm: 'gpt-4' });\n" +
        "  return client.invoke({ intentToken: plan.token });\n}\n",
    );
    expect(got).toEqual([
      ["import", "@armoriq/sdk", 1],
      ["client_init", "ArmorIQClient", 2],
      ["call", "capturePlan", 4],
      ["call", "invoke", 5],
    ]);
    expect(unresolved).toEqual([]);
  });

  it("default + aliased subpath imports, optional chaining, comments and re-exports", () => {
    const { got, unresolved } = scan(
      "import AQ, { ArmorIQSession as S } from '@armoriq/sdk/dist/integrations/google_adk';\n" +
        "// new AQ() in a comment\n" +
        "const s = 'AQ.invoke()';\n" +
        "class X { constructor() { this.c = new AQ(); } run() { return this.c?.invoke(); } }\n" +
        "const sess = await S.start();\n" +
        "export { ArmorIQClient } from '@armoriq/sdk';\n",
    );
    expect(got).toEqual([
      ["import", "@armoriq/sdk/dist/integrations/google_adk", 1],
      ["client_init", "AQ", 4],
      ["call", "invoke", 4],
      ["call", "start", 5],
    ]);
    expect(unresolved).toEqual(["re-export of @armoriq/sdk in x.ts:6"]);
  });

  it("CommonJS require, destructuring, member access and chained calls", () => {
    const { got } = scan(
      "const sdk = require('@armoriq/sdk');\n" +
        "const { ArmorIQClient: Client, loadArmorIQConfig } = require('@armoriq/sdk');\n" +
        "const a = new sdk.ArmorIQClient();\n" +
        "new Client().listMcps();\n" +
        "loadArmorIQConfig('armoriq.yaml');\n" +
        "const Direct = require('@armoriq/sdk').ArmorIQClient;\n" +
        "new Direct().invoke();\n",
      ".cjs",
    );
    expect(got).toContainEqual(["client_init", "ArmorIQClient", 3]);
    expect(got).toContainEqual(["client_init", "ArmorIQClient", 4]);
    expect(got).toContainEqual(["call", "listMcps", 4]);
    expect(got).toContainEqual(["call", "loadArmorIQConfig", 5]);
    expect(got).toContainEqual(["client_init", "ArmorIQClient", 7]);
    expect(got).toContainEqual(["call", "invoke", 7]);
  });

  it("dynamic import, type-only import, TS import-require and TSX", () => {
    const dyn = scan("export async function f() { const m = await import('@armoriq/sdk'); return m; }\n");
    expect(dyn.got).toEqual([]);
    expect(dyn.unresolved).toEqual(["dynamic import of @armoriq/sdk in x.ts:1"]);
    const typeOnly = scan("import type { ArmorIQClient } from '@armoriq/sdk';\nlet c: ArmorIQClient;\n");
    expect(typeOnly.got).toEqual([["import", "@armoriq/sdk", 1]]);
    expect(typeOnly.sites[0].typeOnly).toBe(true);
    expect(
      scan("import sdk = require('@armoriq/sdk');\nconst c = new sdk.ArmorIQClient();\nc.invoke();\n").got,
    ).toContainEqual(["call", "invoke", 3]);
    const tsx = scan(
      "import { ArmorIQClient } from '@armoriq/sdk';\nexport const App = () => <button onClick={() => new ArmorIQClient().invoke()}>Go</button>;\n",
      ".tsx",
    );
    expect(tsx.got).toContainEqual(["call", "invoke", 2]);
  });

  it("still scans files with syntax errors", () => {
    expect(
      scan("import { ArmorIQClient } from '@armoriq/sdk';\nconst c = new ArmorIQClient(;\nc.invoke()\n").got,
    ).toContainEqual(["import", "@armoriq/sdk", 1]);
  });

  it("scans Vue/Svelte script blocks with correct line numbers", () => {
    const vue =
      "<template><button @click='go'>Go</button></template>\n" +
      '<script setup lang="ts">\n' +
      "import { ArmorIQClient } from '@armoriq/sdk';\n" +
      "const client = new ArmorIQClient();\n" +
      "function go() { client.invoke(); }\n</script>\n";
    const { sites } = scanSfc("App.vue", vue, ".vue", MODULES, false, REDACTOR);
    expect(sites.map((s) => [s.kind, s.symbol, s.line])).toContainEqual(["call", "invoke", 5]);
  });
});
