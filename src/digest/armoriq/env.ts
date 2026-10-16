/** Env-file evidence (an optional signal only). Values are inspected for shape, never stored. */
import { basename } from "node:path";
import type { EnvSignal } from "../../schemas/evidence";
import type { SecretRedactor } from "./secrets";

const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/;

export function isEnvFile(rel: string): boolean {
  const name = basename(rel).toLowerCase();
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

export function scanEnv(rel: string, text: string, envVars: string[], redactor: SecretRedactor): EnvSignal[] {
  const wanted = new Set(envVars);
  const signals: EnvSignal[] = [];
  for (const line of text.split("\n")) {
    const m = ASSIGN.exec(line);
    if (!m || !wanted.has(m[1])) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    signals.push({ path: rel, var: m[1], hasRealValue: redactor.isRealArmoriqKey(value) });
  }
  return signals;
}
