/**
 * ArmorIQ integration scanner: turns a checked-out repo into ArmorIQEvidence. Never executes code.
 *
 * FAIL needs positive absence, so anything the scanner cannot follow (oversized or unparsed files that mention
 * the SDK, git submodules) is reported in `unresolved` and routed to Jev / human review instead.
 */
import { existsSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Signatures } from "../../config";
import { type ArmorIQEvidence, ArmorIQEvidenceSchema, type UsageSite } from "../../schemas/evidence";
import { isEnvFile, scanEnv } from "./env";
import { fileMentions, isTestPath, iterRepoFiles, MAX_FILE_BYTES, readText, snippetAt } from "./files";
import { findInstalls, INSTALL_FILE_NAMES } from "./installs";
import { JS_SUFFIXES, SFC_SUFFIXES, scanJs, scanSfc } from "./jsUsage";
import { scanNotebook, scanPython } from "./pythonUsage";
import { redactSecret, SecretRedactor } from "./secrets";
import { initTreeSitter } from "./treeSitter";

const COMMENT_PREFIXES = ["#", "//", "*", "/*"];
const MAX_NOTEBOOK_BYTES = 50_000_000; // notebooks inflate with saved outputs; still parse them
/** Files we never parse but which can carry SDK usage (flow exports, other languages, config). */
const UNPARSED_SUFFIXES = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".scala",
  ".dart",
  ".lua",
  ".ex",
  ".exs",
]);
const CODE_SUFFIXES = new Set([".py", ".ipynb", ...Object.keys(JS_SUFFIXES), ...SFC_SUFFIXES]);

export async function scanRepo(root: string, sig: Signatures): Promise<ArmorIQEvidence> {
  await initTreeSitter();
  const redactor = SecretRedactor.fromSignatures(sig);
  const oversized: string[] = [];
  const files = iterRepoFiles(root, new Set(sig.excludeDirs), oversized);
  const evidence = ArmorIQEvidenceSchema.parse({ installs: findInstalls(root, files, sig) });
  const needles = [...sig.pythonModules, ...sig.jsModules];
  const configNames = new Set(sig.configFiles.map((c) => c.toLowerCase()));
  const secrets = new Set<string>();
  const relOf = (path: string) => relative(root, path).split("\\").join("/");

  for (const path of files) {
    const rel = relOf(path);
    const text = readText(path);
    if (text === null) continue;
    for (const key of redactor.armoriqKeys(text)) secrets.add(key);
    const name = basename(path).toLowerCase();
    const suffix = extname(path).toLowerCase();
    if (configNames.has(name)) evidence.configFiles.push(rel);
    if (isEnvFile(rel)) evidence.envSignals.push(...scanEnv(rel, text, sig.envVars, redactor));
    scanCode(evidence, rel, text, suffix, sig, redactor);
    if (
      UNPARSED_SUFFIXES.has(suffix) &&
      !INSTALL_FILE_NAMES.has(name) &&
      !configNames.has(name) &&
      needles.some((n) => text.includes(n))
    ) {
      evidence.unresolved.push(`ArmorIQ SDK referenced in ${rel}, which the scanner does not parse`);
    }
  }

  for (const path of oversized) {
    const rel = relOf(path);
    const suffix = extname(path).toLowerCase();
    const size = statSync(path).size;
    if (suffix === ".ipynb" && size <= MAX_NOTEBOOK_BYTES) {
      const text = readText(path);
      if (text !== null) {
        for (const key of redactor.armoriqKeys(text)) secrets.add(key);
        scanCode(evidence, rel, text, suffix, sig, redactor);
      }
    } else if ((CODE_SUFFIXES.has(suffix) || UNPARSED_SUFFIXES.has(suffix)) && fileMentions(path, needles)) {
      evidence.unresolved.push(
        `${rel} is too large to parse (${(size / 1_000_000).toFixed(1)} MB > ${MAX_FILE_BYTES / 1_000_000} MB) but references the ArmorIQ SDK`,
      );
    }
  }

  if (existsSync(join(root, ".gitmodules"))) {
    evidence.unresolved.push(
      "repository uses git submodules, which are not fetched; SDK usage may live there",
    );
  }
  evidence.secretExposed = secrets.size > 0;
  evidence.redactedKeys = [...secrets].map(redactSecret).sort();
  return evidence;
}

/** Alias kept for the pipeline's naming (scanArmoriq is the gate stage). */
export const scanArmoriq = scanRepo;

function scanCode(
  evidence: ArmorIQEvidence,
  rel: string,
  text: string,
  suffix: string,
  sig: Signatures,
  redactor: SecretRedactor,
): void {
  const inTest = isTestPath(rel, sig.testPathMarkers);
  let result: { sites: UsageSite[]; unresolved: string[] };
  if (suffix === ".py") result = scanPython(rel, text, sig.pythonModules, inTest, redactor);
  else if (suffix in JS_SUFFIXES) result = scanJs(rel, text, suffix, sig.jsModules, inTest, redactor);
  else if (SFC_SUFFIXES.has(suffix)) result = scanSfc(rel, text, suffix, sig.jsModules, inTest, redactor);
  else if (suffix === ".ipynb") result = scanNotebook(rel, text, sig.pythonModules, inTest, redactor);
  else return;
  evidence.usageSites.push(...result.sites, ...httpSites(rel, text, sig.hosts, inTest, redactor));
  evidence.unresolved.push(...result.unresolved);
}

function httpSites(
  rel: string,
  text: string,
  hosts: string[],
  inTest: boolean,
  redactor: SecretRedactor,
): UsageSite[] {
  const lines = text.split("\n");
  const sites: UsageSite[] = [];
  lines.forEach((line, i) => {
    if (COMMENT_PREFIXES.some((p) => line.trimStart().startsWith(p))) return;
    for (const host of hosts) {
      if (line.includes(host)) {
        sites.push({
          path: rel,
          line: i + 1,
          symbol: host,
          kind: "http_call",
          snippet: snippetAt(lines, i + 1, redactor),
          inTest,
          typeOnly: false,
        });
      }
    }
  });
  return sites;
}
