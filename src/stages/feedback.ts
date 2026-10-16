/** Team-facing feedback text. */
import type { ArmorIQEvidence } from "../schemas/evidence";

export function disqualificationFeedback(evidence: ArmorIQEvidence, reasons: string[]): string {
  const installs =
    evidence.installs.map((i) => `  - \`${i.path}\`: \`${i.package}\` (${i.kind})`).join("\n") ||
    "  - none found";
  const calls =
    evidence.usageSites
      .filter((u) => u.kind === "client_init" || u.kind === "call")
      .slice(0, 10)
      .map((u) => `  - \`${u.path}:${u.line}\` \`${u.symbol}\`${u.inTest ? " (test file)" : ""}`)
      .join("\n") || "  - none found";
  return [
    "## ArmorIQ integration check: not met",
    "",
    "This hackathon requires the ArmorIQ SDK to be **installed** and **called from your application code**.",
    "",
    "### What we looked for",
    "- An install of `armoriq-sdk` (Python) or `@armoriq/sdk` (JavaScript/TypeScript) in requirements files, " +
      "`pyproject.toml`, `Pipfile`, `setup.py`/`setup.cfg`, lockfiles, `package.json`, Dockerfiles, shell scripts or notebooks.",
    "- Calls to the SDK, such as `ArmorIQClient(...)`, `capture_plan` / `capturePlan`, `get_intent_token` / `getIntentToken` " +
      "or `invoke`, in non-test source files.",
    "",
    "### What we found",
    `- Install declarations:\n${installs}`,
    `- SDK call sites:\n${calls}`,
    "",
    "### Result",
    ...reasons.map((r) => `- ${r}`),
    "",
    "If you believe this is wrong, contact the organizers with a link to the file and line where your application calls the ArmorIQ SDK.",
    "",
  ].join("\n");
}
