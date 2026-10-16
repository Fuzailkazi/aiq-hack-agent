/** Find where the ArmorIQ SDK is declared as a dependency or installed. */
import { basename, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Signatures } from "../../config";
import type { InstallHit } from "../../schemas/evidence";
import { readText } from "./files";

type Kind = InstallHit["kind"];
type Ecosystem = InstallHit["ecosystem"];

/** Manifest/lock files whose mentions of the SDK are handled here (not by the "unparsed file" rule). */
export const INSTALL_FILE_NAMES = new Set([
  "pyproject.toml",
  "pipfile",
  "pipfile.lock",
  "setup.cfg",
  "poetry.lock",
  "uv.lock",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
]);

const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;#]*)/;
const INSTALL_CMD = /\b(pip3?|uv|poetry|pipx|npm|yarn|pnpm|bun)\b.*\b(install|add|i)\b/i;
const VERSION_SPLIT = /[=<>~!;[ ]/;

export const canonicalPypi = (name: string): string => name.replace(/[-_.]+/g, "-").toLowerCase();
const hit = (
  path: string,
  kind: Kind,
  ecosystem: Ecosystem,
  pkg: string,
  versionSpec: string | null = null,
): InstallHit => ({
  path,
  kind,
  ecosystem,
  package: pkg,
  versionSpec,
});

export function findInstalls(root: string, files: string[], sig: Signatures): InstallHit[] {
  const pypi = new Set(sig.pypiPackages.map(canonicalPypi));
  const npm = new Set(sig.npmPackages);
  const hits: InstallHit[] = [];
  for (const path of files) {
    const rel = relative(root, path).split("\\").join("/");
    const name = basename(path).toLowerCase();
    const text = readText(path);
    if (text === null) continue;
    if (name.startsWith("requirements") && (name.endsWith(".txt") || name.endsWith(".in")))
      hits.push(...requirements(rel, text, pypi));
    else if (name === "pyproject.toml") hits.push(...pyproject(rel, text, pypi));
    else if (name === "pipfile") hits.push(...pipfile(rel, text, pypi));
    else if (name === "setup.py" || name === "setup.cfg")
      hits.push(...mentions(rel, text, pypi, "manifest", "pypi"));
    else if (["poetry.lock", "uv.lock", "pipfile.lock"].includes(name))
      hits.push(...mentions(rel, text, pypi, "lockfile", "pypi"));
    else if (name === "package.json") hits.push(...packageJson(rel, text, npm));
    else if (["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"].includes(name)) {
      hits.push(...mentions(rel, text, npm, "lockfile", "npm"));
    } else if (name.startsWith("dockerfile") || name.endsWith(".dockerfile")) {
      hits.push(...installCommands(rel, text, pypi, npm, "dockerfile"));
    } else if (name.endsWith(".sh")) hits.push(...installCommands(rel, text, pypi, npm, "script"));
    else if (name.endsWith(".ipynb"))
      hits.push(...installCommands(rel, notebookSource(text), pypi, npm, "notebook"));
  }
  return hits;
}

function pep508Hit(rel: string, requirement: string, pypi: Set<string>, kind: Kind): InstallHit | null {
  const m = PEP508.exec(requirement);
  if (!m || !pypi.has(canonicalPypi(m[1]))) return null;
  return hit(rel, kind, "pypi", canonicalPypi(m[1]), m[3].trim() || null);
}

function requirements(rel: string, text: string, pypi: Set<string>): InstallHit[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map((line) => pep508Hit(rel, line, pypi, "manifest"))
    .filter((h): h is InstallHit => h !== null);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function pyproject(rel: string, text: string, pypi: Set<string>): InstallHit[] {
  let data: Record<string, unknown>;
  try {
    data = record(parseToml(text));
  } catch {
    return mentions(rel, text, pypi, "manifest", "pypi");
  }
  const project = record(data.project);
  const reqs = [...strings(project.dependencies)];
  for (const group of Object.values(record(project["optional-dependencies"]))) reqs.push(...strings(group));
  for (const group of Object.values(record(data["dependency-groups"]))) reqs.push(...strings(group));
  const poetry = record(record(data.tool).poetry);
  reqs.push(...Object.keys(record(poetry.dependencies)));
  for (const group of Object.values(record(poetry.group)))
    reqs.push(...Object.keys(record(record(group).dependencies)));
  const hits = reqs
    .map((r) => pep508Hit(rel, r, pypi, "manifest"))
    .filter((h): h is InstallHit => h !== null);
  return hits.length ? hits : mentions(rel, text, pypi, "manifest", "pypi"); // unusual layouts still count
}

function pipfile(rel: string, text: string, pypi: Set<string>): InstallHit[] {
  let data: Record<string, unknown>;
  try {
    data = record(parseToml(text));
  } catch {
    return mentions(rel, text, pypi, "manifest", "pypi");
  }
  const names = [...Object.keys(record(data.packages)), ...Object.keys(record(data["dev-packages"]))];
  const hits = names
    .map((n) => pep508Hit(rel, n, pypi, "manifest"))
    .filter((h): h is InstallHit => h !== null);
  return hits.length ? hits : mentions(rel, text, pypi, "manifest", "pypi");
}

function packageJson(rel: string, text: string, npm: Set<string>): InstallHit[] {
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(text));
  } catch {
    return mentions(rel, text, npm, "manifest", "npm");
  }
  const hits: InstallHit[] = [];
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(record(data[section]))) {
      if (npm.has(name)) hits.push(hit(rel, "manifest", "npm", name, String(version)));
    }
  }
  return hits.length ? hits : mentions(rel, text, npm, "manifest", "npm");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function mentions(
  rel: string,
  text: string,
  packages: Set<string>,
  kind: Kind,
  ecosystem: Ecosystem,
): InstallHit[] {
  const hits: InstallHit[] = [];
  for (const pkg of [...packages].sort()) {
    const variants = new Set([pkg, pkg.replaceAll("-", "_")]);
    if ([...variants].some((v) => new RegExp(`(?<![\\w-])${escapeRe(v)}(?![\\w-])`, "i").test(text))) {
      hits.push(hit(rel, kind, ecosystem, pkg));
    }
  }
  return hits;
}

function installCommands(
  rel: string,
  text: string,
  pypi: Set<string>,
  npm: Set<string>,
  kind: Kind,
): InstallHit[] {
  const hits: InstallHit[] = [];
  for (const line of text.replaceAll("\\\n", " ").split("\n")) {
    if (!INSTALL_CMD.test(line)) continue;
    for (const raw of line.split(/\s+/)) {
      const token = raw.replace(/^['"`,;&|()]+|['"`,;&|()]+$/g, "");
      const npmName = token.replace(/(?<=.)@[^/]*$/, "");
      if (npm.has(npmName)) {
        hits.push(hit(rel, kind, "npm", npmName));
        continue;
      }
      const pyName = canonicalPypi(token.split(VERSION_SPLIT)[0]);
      if (pypi.has(pyName)) hits.push(hit(rel, kind, "pypi", pyName));
    }
  }
  return hits;
}

/** Joined source of all notebook cells (install magics like %pip live in code cells). */
export function notebookSource(text: string, codeOnly = false): string {
  let cells: unknown[];
  try {
    cells = (record(JSON.parse(text)).cells as unknown[]) ?? [];
  } catch {
    return "";
  }
  if (!Array.isArray(cells)) return "";
  return cells
    .map(record)
    .filter((cell) => !codeOnly || cell.cell_type === "code")
    .map((cell) => (Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "")))
    .join("\n");
}
