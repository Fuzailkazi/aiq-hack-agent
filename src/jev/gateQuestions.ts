/** Jev question and state for ArmorIQ gate cases the scanner could not resolve. */
import { noul } from "@typesafe-ai/sdk";
import type { ArmorIQEvidence } from "../schemas/evidence";
import type { JevQuestion } from "./client";

export const SDK_CALLED_IN_APP_CODE = "sdk_called_in_app_code";
const MAX_SITES = 12;

export function gateQuestions(): Record<string, JevQuestion> {
  return {
    [SDK_CALLED_IN_APP_CODE]: noul(
      "Using `usageSites` (code snippets from the repository) and `openQuestions`, does this repository's " +
        "application code call the ArmorIQ SDK (`armoriq-sdk` for Python, `@armoriq/sdk` for JavaScript/TypeScript) " +
        "as part of its runtime behaviour? Calls that appear only in comments, documentation, tests or unused example " +
        "files do not count.",
      {
        true: "Application code instantiates the ArmorIQ client or calls ArmorIQ SDK functions.",
        false: "The SDK is absent, unused, or referenced only outside application code.",
      },
    ),
  };
}

/** Compact, secret-free state: snippets are already redacted by the scanner. */
export function gateState(evidence: ArmorIQEvidence, openQuestions: string[]): Record<string, unknown> {
  return {
    openQuestions,
    installs: evidence.installs.slice(0, MAX_SITES).map((i) => `${i.path}: ${i.package} (${i.kind})`),
    usageSites: evidence.usageSites
      .filter((u) => u.kind !== "import")
      .slice(0, MAX_SITES)
      .map((u) => ({
        location: `${u.path}:${u.line}`,
        symbol: u.symbol,
        kind: u.kind,
        inTest: u.inTest,
        snippet: u.snippet,
      })),
  };
}
