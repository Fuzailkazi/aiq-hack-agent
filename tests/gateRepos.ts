/** Synthetic repos for the ArmorIQ gate: files to write + expected classify() outcome. (Ported from the Python suite.) */

export const FAKE_KEY = "ak_live_9f8e7d6c5b4a3210ffee"; // real-format key; must never appear in evidence

export const GATE_REPOS: Record<
  string,
  { files: Record<string, string>; expected: "pass" | "fail" | "unresolved" }
> = {
  py_sdk_used: {
    expected: "pass",
    files: {
      "requirements.txt": "armoriq-sdk==0.6.10\nrequests\n",
      "app/main.py":
        'from armoriq_sdk import ArmorIQClient\n\nclient = ArmorIQClient.from_config("armoriq.yaml")\n\n\ndef guard(prompt: str) -> str:\n    plan = client.capture_plan(llm="gpt-4", prompt=prompt, plan={"goal": prompt, "steps": []})\n    return client.get_intent_token(plan)\n',
    },
  },
  ts_sdk_used: {
    expected: "pass",
    files: {
      "package.json": '{"name": "app", "dependencies": {"@armoriq/sdk": "^0.6.10", "zod": "^3.0.0"}}',
      "src/agent.ts":
        "import { ArmorIQClient } from '@armoriq/sdk';\n\nconst client = new ArmorIQClient({ apiKey: process.env.ARMORIQ_API_KEY });\n\nexport async function run(prompt: string) {\n  const plan = await client.capturePlan({ llm: 'gpt-4', prompt });\n  return client.invoke({ mcpName: 'weather', action: 'get', intentToken: plan.token });\n}\n",
    },
  },
  ts_aliased_import: {
    expected: "pass",
    files: {
      "package.json": '{"name": "app", "dependencies": {"@armoriq/sdk": "^0.6.10", "zod": "^3.0.0"}}',
      "src/a.ts":
        "import * as aiq from '@armoriq/sdk';\nconst c = new aiq.ArmorIQClient();\nc.startSession();\n",
      "src/b.cjs": "const { ArmorIQClient: Client } = require('@armoriq/sdk');\nnew Client().listMcps();\n",
    },
  },
  monorepo_nested: {
    expected: "pass",
    files: {
      "services/api/pyproject.toml": '[project]\nname = "api"\ndependencies = ["armoriq_sdk>=0.6"]\n',
      "services/api/src/guard.py":
        'from armoriq_sdk import ArmorIQClient\n\nclient = ArmorIQClient.from_config("armoriq.yaml")\n\n\ndef guard(prompt: str) -> str:\n    plan = client.capture_plan(llm="gpt-4", prompt=prompt, plan={"goal": prompt, "steps": []})\n    return client.get_intent_token(plan)\n',
      "web/package.json": '{"name": "web", "dependencies": {"react": "^18.0.0"}}',
    },
  },
  dockerfile_install: {
    expected: "pass",
    files: {
      Dockerfile: "FROM python:3.12\nRUN pip install --no-cache-dir \\\n    armoriq-sdk==0.6.10 fastapi\n",
      "app.py":
        'from armoriq_sdk import ArmorIQClient\n\nclient = ArmorIQClient.from_config("armoriq.yaml")\n\n\ndef guard(prompt: str) -> str:\n    plan = client.capture_plan(llm="gpt-4", prompt=prompt, plan={"goal": prompt, "steps": []})\n    return client.get_intent_token(plan)\n',
    },
  },
  no_sdk: {
    expected: "fail",
    files: {
      "requirements.txt": "flask\n",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n",
    },
  },
  sdk_installed_unused: {
    expected: "fail",
    files: {
      "package.json": '{"name": "app", "dependencies": {"@armoriq/sdk": "^0.6.10", "zod": "^3.0.0"}}',
      "src/index.ts": "import type { ArmorIQClient } from '@armoriq/sdk';\nexport type C = ArmorIQClient;\n",
    },
  },
  sdk_in_comments_only: {
    expected: "fail",
    files: {
      "requirements.txt": "armoriq-sdk\n",
      "app.py": '# client = ArmorIQClient()\n"""We call armoriq_sdk.invoke() later."""\nprint("hi")\n',
      "README.md": "Uses ArmorIQClient().invoke()",
    },
  },
  calls_without_install: {
    expected: "unresolved",
    files: {
      "requirements.txt": "flask\n",
      "app.py":
        'from armoriq_sdk import ArmorIQClient\n\nclient = ArmorIQClient.from_config("armoriq.yaml")\n\n\ndef guard(prompt: str) -> str:\n    plan = client.capture_plan(llm="gpt-4", prompt=prompt, plan={"goal": prompt, "steps": []})\n    return client.get_intent_token(plan)\n',
    },
  },
  sdk_only_in_tests: {
    expected: "unresolved",
    files: {
      "requirements.txt": "armoriq-sdk\n",
      "tests/test_guard.py":
        'from armoriq_sdk import ArmorIQClient\n\nclient = ArmorIQClient.from_config("armoriq.yaml")\n\n\ndef guard(prompt: str) -> str:\n    plan = client.capture_plan(llm="gpt-4", prompt=prompt, plan={"goal": prompt, "steps": []})\n    return client.get_intent_token(plan)\n',
      "app.py": "print('hi')\n",
    },
  },
  dynamic_import: {
    expected: "unresolved",
    files: {
      "package.json": '{"name": "app", "dependencies": {"@armoriq/sdk": "^0.6.10", "zod": "^3.0.0"}}',
      "src/x.ts":
        "export async function load() {\n  const m = await import('@armoriq/sdk');\n  return m;\n}\n",
    },
  },
  committed_secret: {
    expected: "pass",
    files: {
      "requirements.txt": "armoriq-sdk\n",
      ".env": "ARMORIQ_API_KEY=ak_live_9f8e7d6c5b4a3210ffee\nARMORIQ_USER_ID=u1\n",
      "app.py":
        "from armoriq_sdk import ArmorIQClient\nclient = ArmorIQClient(api_key=\"ak_live_9f8e7d6c5b4a3210ffee\")\nclient.invoke(mcp_name='m', action='a', intent_token='t', inputs={})\n",
    },
  },
};
