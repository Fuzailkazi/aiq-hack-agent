/** Scanner + gate rule over the synthetic repo tables (no git, no Jev). */
import { describe, expect, it } from "vitest";
import { GatePolicySchema, loadSignatures } from "../../src/config";
import { scanRepo } from "../../src/digest/armoriq";
import { classify } from "../../src/stages/gate";
import { FAKE_KEY, GATE_REPOS } from "../gateRepos";
import { writeFiles } from "../gitRepo";
import { tempDir } from "../helpers";

const SIG = loadSignatures("config/armoriq_signatures.yaml");
const POLICY = GatePolicySchema.parse({});
const REQ = { "requirements.txt": "armoriq-sdk==0.6.10\n" };
const PKG = { "package.json": JSON.stringify({ dependencies: { "@armoriq/sdk": "^0.6.10" } }) };
const CALL = "from armoriq_sdk import ArmorIQClient\nArmorIQClient().invoke()\n";

const outcomeOf = async (files: Record<string, string>) => {
  const evidence = await scanRepo(writeFiles(tempDir(), files), SIG);
  return { evidence, ...classify(evidence, POLICY) };
};

describe("gate fixture table", () => {
  it.each(Object.keys(GATE_REPOS).sort())("%s", async (name) => {
    const { outcome, reasons, evidence } = await outcomeOf(GATE_REPOS[name].files);
    expect(outcome, reasons.join("; ")).toBe(GATE_REPOS[name].expected);
    expect(JSON.stringify(evidence)).not.toContain(FAKE_KEY);
  });
});

/** Real-world ways teams integrate the SDK must never end in FAIL (auto-disqualification). */
const PATTERNS: Record<string, Record<string, string>> = {
  py_subclass: {
    ...REQ,
    "app/guard.py": "from armoriq_sdk import ArmorIQClient\n\nclass Guard(ArmorIQClient):\n    pass\n",
  },
  py_package_reexport: {
    ...REQ,
    "app/__init__.py": "from armoriq_sdk import ArmorIQClient as Client\n",
    "app/main.py": "from app import Client\nClient()\n",
  },
  py_star_import: { ...REQ, "app.py": "from armoriq_sdk import *\nclient = ArmorIQClient()\n" },
  py_alias_assignment: {
    ...REQ,
    "app.py":
      "from armoriq_sdk import ArmorIQClient\nFACTORY = ArmorIQClient\nclient = FACTORY()\nclient.invoke()\n",
  },
  py_partial: {
    ...REQ,
    "app.py":
      "import functools\nfrom armoriq_sdk import ArmorIQClient\nmake = functools.partial(ArmorIQClient, a=1)\n",
  },
  py_getattr: {
    ...REQ,
    "app.py": "import armoriq_sdk\ncls = getattr(armoriq_sdk, 'ArmorIQClient')\ncls()\n",
  },
  py_bom_file: { ...REQ, "app.py": `﻿${CALL}` },
  js_require_member: {
    ...PKG,
    "src/a.js": "const Client = require('@armoriq/sdk').ArmorIQClient;\nnew Client().invoke();\n",
  },
  ts_import_require: {
    ...PKG,
    "src/a.ts": "import sdk = require('@armoriq/sdk');\nconst c = new sdk.ArmorIQClient();\nc.invoke();\n",
  },
  ts_merge_conflict_markers: {
    ...PKG,
    "src/agent.ts":
      '<<<<<<< HEAD\nimport { ArmorIQClient } from "@armoriq/sdk";\n=======\nimport { ArmorIQClient } from "@armoriq/sdk";\n>>>>>>> feature\nconst c = new ArmorIQClient({});\nawait c.invoke("x");\n',
  },
  js_unterminated_template_before_usage: {
    ...PKG,
    // An unterminated "${" in a template literal, then real usage.
    "src/a.js": `const q = \`hello $\{\nimport { ArmorIQClient } from "@armoriq/sdk";\nconst c = new ArmorIQClient({});\nc.invoke('x');\n`,
  },
  vue_sfc_with_merge_conflict: {
    ...PKG,
    "src/App.vue":
      '<script setup>\n<<<<<<< HEAD\nimport { ArmorIQClient } from "@armoriq/sdk";\n=======\nimport { ArmorIQClient } from "@armoriq/sdk";\n>>>>>>> x\nnew ArmorIQClient().invoke();\n</script>\n',
  },
  js_cdn_import_without_install: {
    "src/a.js":
      'import { ArmorIQClient } from "https://esm.sh/@armoriq/sdk@0.6.10";\nnew ArmorIQClient({}).invoke("x");\n',
  },
  html_inline_module_script: {
    "index.html":
      '<!doctype html><html><body>\n<script type="module">\nimport { ArmorIQClient } from "https://cdn.jsdelivr.net/npm/@armoriq/sdk/+esm";\nnew ArmorIQClient({}).invoke("x");\n</script>\n</body></html>\n',
  },
  vue_sfc: {
    ...PKG,
    "src/App.vue":
      "<template><button @click='go'>Go</button></template>\n<script setup lang=\"ts\">\nimport { ArmorIQClient } from '@armoriq/sdk';\nconst client = new ArmorIQClient();\nfunction go() { client.invoke(); }\n</script>\n",
  },
  svelte_sfc: {
    ...PKG,
    "src/Guard.svelte":
      "<script>\nimport { ArmorIQClient } from '@armoriq/sdk';\nnew ArmorIQClient().invoke();\n</script>\n",
  },
  langflow_flow_json: { ...REQ, "flows/agent.json": JSON.stringify({ data: { nodes: [{ code: CALL }] } }) },
  large_notebook: {
    ...REQ,
    "demo.ipynb": JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: CALL,
          outputs: [{ output_type: "display_data", data: { "image/png": "A".repeat(1_500_000) } }],
        },
      ],
    }),
  },
  git_submodule: {
    ...REQ,
    ".gitmodules": '[submodule "agent"]\n\tpath = agent\n\turl = https://github.com/o/agent\n',
  },
  code_in_env_dir: { ...REQ, "env/guard.py": CALL },
  code_in_build_dir: { ...REQ, "build/guard.py": CALL },
};

describe("false-disqualification patterns", () => {
  it.each(Object.keys(PATTERNS).sort())("%s is never auto-disqualified", async (name) => {
    const { outcome, reasons } = await outcomeOf(PATTERNS[name]);
    expect(outcome, `${name}: ${reasons.join("; ")}`).not.toBe("fail");
  });

  it("still skips a real virtualenv", async () => {
    const { outcome } = await outcomeOf({
      ...REQ,
      "app.py": "print('no sdk use')\n",
      "env/pyvenv.cfg": "home = /usr/bin\n",
      "env/lib/python3.12/site-packages/armoriq_sdk/x.py": CALL,
    });
    expect(outcome).toBe("fail");
  });

  it.each([
    [
      "type-only import",
      {
        ...PKG,
        "src/index.ts":
          "import type { ArmorIQClient } from '@armoriq/sdk';\nexport type C = ArmorIQClient;\n",
      },
    ],
    [
      "comments and README only",
      { ...REQ, "app.py": "# ArmorIQClient().invoke()\nprint('hi')\n", "README.md": "We use armoriq_sdk!" },
    ],
    [
      "lockfile-only mention",
      {
        ...PKG,
        "package-lock.json": JSON.stringify({ packages: { "node_modules/@armoriq/sdk": {} } }),
        "src/a.ts": "x()",
      },
    ],
  ])("positive absence still fails: %s", async (_name, files) => {
    const { outcome, reasons } = await outcomeOf(files as Record<string, string>);
    expect(outcome, reasons.join("; ")).toBe("fail");
  });
});
