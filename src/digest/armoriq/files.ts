/** Safe repository traversal and text helpers shared by the ArmorIQ scanner. */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SecretRedactor } from "./secrets";

export const MAX_FILE_BYTES = 1_000_000;
export const SNIPPET_RADIUS = 8;
const TEST_FILE = /(^test_.*\.py$|.*_test\.py$|.*\.(test|spec)\.[cm]?[jt]sx?$)/;

/**
 * Regular files under root (absolute paths, sorted). Never follows symlinks; skips excluded directory names
 * and Python virtualenvs (any directory containing pyvenv.cfg). Files larger than MAX_FILE_BYTES are not
 * returned; they are appended to `oversized` when given.
 */
export function iterRepoFiles(root: string, excludeDirs: Set<string>, oversized?: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name) && !existsSync(join(path, "pyvenv.cfg"))) walk(path);
      } else if (entry.isFile()) {
        if (lstatSync(path).size > MAX_FILE_BYTES) oversized?.push(path);
        else out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Stream a (possibly large) file looking for any needle, reading at most limitBytes. */
export function fileMentions(path: string, needles: string[], limitBytes = 50_000_000): boolean {
  const encoded = needles.map((n) => Buffer.from(n));
  const overlap = Math.max(1, ...encoded.map((n) => n.length));
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    let tail = Buffer.alloc(0);
    let read = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0 || read >= limitBytes) return false;
      read += n;
      const window = Buffer.concat([tail, chunk.subarray(0, n)]);
      if (encoded.some((needle) => window.includes(needle))) return true;
      tail = window.subarray(Math.max(0, window.length - overlap));
    }
  } finally {
    closeSync(fd);
  }
}

export function isTestPath(rel: string, markers: string[]): boolean {
  const parts = rel.toLowerCase().split("/");
  return parts.slice(0, -1).some((p) => markers.includes(p)) || TEST_FILE.test(parts.at(-1) ?? "");
}

/** Lines around a 1-based line number, with secrets redacted. */
export function snippetAt(
  lines: string[],
  lineNo: number,
  redactor: SecretRedactor,
  radius = SNIPPET_RADIUS,
): string {
  const start = Math.max(0, lineNo - 1 - radius);
  return redactor.redact(lines.slice(start, lineNo + radius).join("\n"));
}
