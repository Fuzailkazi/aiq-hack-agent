import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestPath, iterRepoFiles, snippetAt } from "../../src/digest/armoriq/files";
import { SecretRedactor } from "../../src/digest/armoriq/secrets";
import { tempDir } from "../helpers";

const REDACTOR = new SecretRedactor();

describe("repo traversal", () => {
  it("skips excluded dirs, virtualenvs, symlinks and huge files", () => {
    const root = tempDir();
    const put = (rel: string, content: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    put("src/app.py", "x = 1");
    put("node_modules/@armoriq/sdk/index.js", "module.exports = {}");
    put("env/pyvenv.cfg", "home = /usr/bin");
    put("env/lib/x.py", "y = 2");
    put("big.py", "x".repeat(1_000_001));
    const outside = join(dirname(root), `outside-${Date.now()}.txt`);
    writeFileSync(outside, "ak_live_9f8e7d6c5b4a3210ffee");
    symlinkSync(outside, join(root, "src/link.txt"));
    symlinkSync(dirname(root), join(root, "src/linkdir"));
    const oversized: string[] = [];
    const found = iterRepoFiles(root, new Set(["node_modules", ".git"]), oversized).map((p) =>
      relative(root, p),
    );
    expect(found).toEqual(["src/app.py"]);
    expect(oversized.map((p) => relative(root, p))).toEqual(["big.py"]);
  });

  it("recognizes test paths", () => {
    const markers = ["test", "tests", "__tests__", "spec", "e2e"];
    expect(isTestPath("tests/test_guard.py", markers)).toBe(true);
    expect(isTestPath("src/__tests__/agent.ts", markers)).toBe(true);
    expect(isTestPath("src/agent.test.ts", markers)).toBe(true);
    expect(isTestPath("pkg/guard_test.py", markers)).toBe(true);
    expect(isTestPath("src/testing_utils_are_app_code.py", markers)).toBe(false);
    expect(isTestPath("src/agent.ts", markers)).toBe(false);
  });

  it("redacts snippets", () => {
    expect(REDACTOR.redact('key = "ak_live_9f8e7d6c5b4a3210ffee"')).toBe('key = "ak_****ffee"');
    expect(REDACTOR.redact("ak_live_your_key_here")).toBe("ak_live_your_key_here");
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    expect(snippetAt(lines, 15, REDACTOR, 2).split("\n")).toEqual([
      "line 13",
      "line 14",
      "line 15",
      "line 16",
      "line 17",
    ]);
  });
});
