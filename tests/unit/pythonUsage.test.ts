import { beforeAll, describe, expect, it } from "vitest";
import { scanNotebook, scanPython } from "../../src/digest/armoriq/pythonUsage";
import { SecretRedactor } from "../../src/digest/armoriq/secrets";
import { initTreeSitter } from "../../src/digest/armoriq/treeSitter";

const REDACTOR = new SecretRedactor();
const MODULES = ["armoriq_sdk"];
const kinds = (source: string) =>
  scanPython("a.py", source, MODULES, false, REDACTOR).sites.map((s) => [s.kind, s.symbol, s.line]);

beforeAll(async () => {
  await initTreeSitter();
});

describe("Python usage", () => {
  it("from-import, client factory and method calls", () => {
    const src =
      "from armoriq_sdk import ArmorIQClient\n" +
      "client = ArmorIQClient.from_config('armoriq.yaml')\n" +
      "plan = client.capture_plan(llm='gpt-4', prompt='p', plan={})\n" +
      "token = client.get_intent_token(plan)\n";
    expect(kinds(src)).toEqual([
      ["import", "armoriq_sdk", 1],
      ["call", "from_config", 2],
      ["call", "capture_plan", 3],
      ["call", "get_intent_token", 4],
    ]);
  });

  it("aliases, attributes, context managers and subclassing", () => {
    const src =
      "import armoriq_sdk as aq\n" +
      "class G:\n" +
      "    def __init__(self):\n" +
      "        self.client = aq.ArmorIQClient()\n" +
      "    def go(self):\n" +
      "        return self.client.invoke(x=1)\n" +
      "with aq.ArmorIQClient() as c:\n" +
      "    c.capture_plan()\n" +
      "class Guard(aq.ArmorIQClient):\n" +
      "    pass\n";
    const got = kinds(src);
    expect(got).toContainEqual(["client_init", "ArmorIQClient", 4]);
    expect(got).toContainEqual(["call", "invoke", 6]);
    expect(got).toContainEqual(["call", "capture_plan", 8]);
    expect(got).toContainEqual(["client_init", "ArmorIQClient", 9]);
  });

  it("alias assignments and chained calls", () => {
    const src =
      "from armoriq_sdk import ArmorIQClient\n" +
      "FACTORY = ArmorIQClient\n" +
      "client = FACTORY()\n" +
      "client.invoke()\n" +
      "ArmorIQClient().invoke(x=1)\n" +
      "async def f():\n" +
      "    return (await ArmorIQClient.create()).capture_plan()\n";
    const got = kinds(src);
    expect(got).toContainEqual(["client_init", "ArmorIQClient", 3]);
    expect(got).toContainEqual(["call", "invoke", 4]);
    expect(got).toContainEqual(["call", "invoke", 5]);
    expect(got).toContainEqual(["call", "capture_plan", 7]);
  });

  it("comments, strings and unrelated calls do not count", () => {
    const src =
      '# client = ArmorIQClient()\n"""We call armoriq_sdk.invoke() later."""\ns = \'ArmorIQClient().invoke()\'\ndef invoke(): pass\ninvoke()\n';
    expect(kinds(src)).toEqual([]);
  });

  it("dynamic imports and broken files are unresolved", () => {
    const dyn = scanPython(
      "d.py",
      "import importlib\nimportlib.import_module('armoriq_sdk.x')\n",
      MODULES,
      false,
      REDACTOR,
    );
    expect(dyn.sites).toEqual([]);
    expect(dyn.unresolved).toEqual(["dynamic import of armoriq_sdk.x in d.py:2"]);
    expect(scanPython("b.py", "def (:\n armoriq_sdk", MODULES, false, REDACTOR).unresolved).toEqual([
      "unparseable Python file mentions the ArmorIQ SDK: b.py",
    ]);
    expect(scanPython("c.py", "def (:\n", MODULES, false, REDACTOR).unresolved).toEqual([]);
  });

  it("redacts a hard-coded key in snippets and strips a BOM", () => {
    const src =
      '\ufefffrom armoriq_sdk import ArmorIQClient\nc = ArmorIQClient(api_key="ak_live_9f8e7d6c5b4a3210ffee")\n';
    const { sites } = scanPython("a.py", src, MODULES, true, REDACTOR);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => !s.snippet.includes("ak_live_9f8e7d6c5b4a3210ffee"))).toBe(true);
    expect(sites.some((s) => s.snippet.includes('api_key="ak_****ffee"'))).toBe(true);
    expect(sites.every((s) => s.inTest)).toBe(true);
  });

  it("scans notebook code cells only", () => {
    const nb = {
      cells: [
        {
          cell_type: "code",
          source: ["%pip install armoriq-sdk\n", "from armoriq_sdk import ArmorIQClient\n"],
        },
        { cell_type: "markdown", source: "ArmorIQClient()" },
        { cell_type: "code", source: "c = ArmorIQClient()\nc.invoke()" },
      ],
    };
    const { sites } = scanNotebook("n.ipynb", JSON.stringify(nb), MODULES, false, REDACTOR);
    expect(sites.map((s) => [s.kind, s.symbol])).toEqual([
      ["import", "armoriq_sdk"],
      ["client_init", "ArmorIQClient"],
      ["call", "invoke"],
    ]);
  });
});
