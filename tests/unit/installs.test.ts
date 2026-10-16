import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSignatures } from "../../src/config";
import { canonicalPypi, findInstalls } from "../../src/digest/armoriq/installs";
import { tempDir } from "../helpers";

const SIG = loadSignatures("config/armoriq_signatures.yaml");
const write = (files: Record<string, string>): [string, string[]] => {
  const root = tempDir();
  const paths = Object.entries(files).map(([rel, content]) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
    return join(root, rel);
  });
  return [root, paths.sort()];
};
const summary = (root: string, paths: string[]) =>
  findInstalls(root, paths, SIG)
    .map((h) => [h.path, h.kind, h.package, h.versionSpec])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));

describe("install detection", () => {
  it("canonicalizes PyPI names", () => {
    expect(canonicalPypi("ArmorIQ_SDK")).toBe("armoriq-sdk");
    expect(canonicalPypi("armoriq.sdk")).toBe("armoriq-sdk");
  });

  it("finds declarations across file types", () => {
    const [root, paths] = write({
      "requirements-dev.txt": "# armoriq-sdk\nArmorIQ_SDK[extra]>=0.6 ; python_version>'3.9'\n",
      "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.12"\narmoriq-sdk = "^0.6"\n',
      "web/package.json": JSON.stringify({ devDependencies: { "@armoriq/sdk": "^0.6.10" } }),
      "yarn.lock": '"@armoriq/sdk@^0.6.10":\n  version "0.6.10"\n',
      "setup.sh": "npm install --save @armoriq/sdk@0.6.10\n",
      Dockerfile: "FROM python:3.12\nRUN pip install --no-cache-dir \\\n    armoriq-sdk==0.6.10 fastapi\n",
      "poetry.lock": 'name = "armoriq-sdk-dev"\n',
      "bad/package.json": "{not json @armoriq/sdk",
      "README.md": "pip install armoriq-sdk",
    });
    expect(summary(root, paths)).toEqual([
      ["Dockerfile", "dockerfile", "armoriq-sdk", null],
      ["bad/package.json", "manifest", "@armoriq/sdk", null],
      ["poetry.lock", "lockfile", "armoriq-sdk-dev", null],
      ["pyproject.toml", "manifest", "armoriq-sdk", null],
      ["requirements-dev.txt", "manifest", "armoriq-sdk", ">=0.6"],
      ["setup.sh", "script", "@armoriq/sdk", null],
      ["web/package.json", "manifest", "@armoriq/sdk", "^0.6.10"],
      ["yarn.lock", "lockfile", "@armoriq/sdk", null],
    ]);
  });

  it("finds notebook %pip installs", () => {
    const nb = { cells: [{ cell_type: "code", source: ["%pip install armoriq-sdk\n", "import os\n"] }] };
    const [root, paths] = write({ "demo.ipynb": JSON.stringify(nb) });
    expect(summary(root, paths).map((h) => [h[1], h[2]])).toEqual([["notebook", "armoriq-sdk"]]);
  });

  it("does not match similar package names", () => {
    const [root, paths] = write({
      "requirements.txt": "armoriq-sdk-extras\nnot-armoriq-sdk\n",
      "package.json": JSON.stringify({ dependencies: { "@armoriq/sdk-mock": "1.0.0" } }),
    });
    expect(findInstalls(root, paths, SIG)).toEqual([]);
  });

  it("survives malformed manifests", () => {
    const [root, paths] = write({
      "a/package.json": "[]",
      "b/package.json": JSON.stringify({ dependencies: ["@armoriq/sdk"] }),
      "c/pyproject.toml": 'project = "x"\n',
      "d/pyproject.toml": '[project]\ndependencies = "armoriq-sdk"\n',
      "e/Pipfile": "packages = 3\n",
    });
    expect(() => findInstalls(root, paths, SIG)).not.toThrow();
  });
});
