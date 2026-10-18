/** ArmorIQ eligibility gate: a pure rule plus Jev adjudication for cases the scanner cannot resolve. */
import type { GatePolicy } from "../config";
import type { JevClient } from "../jev/client";
import { gateQuestions, gateState, SDK_CALLED_IN_APP_CODE } from "../jev/gateQuestions";
import { type GateResult, GateResultSchema } from "../schemas/evaluation";
import type { ArmorIQEvidence, RepoSnapshot } from "../schemas/evidence";
import { disqualificationFeedback } from "./feedback";

export type Outcome = "pass" | "fail" | "unresolved";

/**
 * PASS: installed and called in non-test application code, or an ArmorIQ plugin package (ArmorClaw) declared in a
 * manifest. FAIL only on positive absence. Anything the scanner
 * could not settle (calls without an install, test/notebook/HTTP-only use, untraced imports, scanner notes) is
 * UNRESOLVED and goes to Jev / a human, never straight to disqualification.
 */
export function classify(
  evidence: ArmorIQEvidence,
  policy: GatePolicy,
): { outcome: Outcome; reasons: string[]; checks: Record<string, boolean> } {
  const isNotebook = (path: string) => path.endsWith(".ipynb");
  const sdkSites = evidence.usageSites.filter((u) => u.kind === "client_init" || u.kind === "call");
  const notebook = sdkSites.filter((u) => isNotebook(u.path));
  const tests = sdkSites.filter((u) => u.inTest && !isNotebook(u.path));
  const app = sdkSites.filter((u) => !isNotebook(u.path) && (policy.testOnlyUsageCounts || !u.inTest));
  const http = evidence.usageSites.filter((u) => u.kind === "http_call" && !u.inTest);
  const imports = evidence.usageSites.filter(
    (u) => u.kind === "import" && !u.typeOnly && !u.inTest && !isNotebook(u.path),
  );
  const installed = evidence.installs.length > 0 || !policy.requireInstall;
  const envKey = evidence.envSignals.some((s) => s.var.endsWith("API_KEY"));
  const plugins = evidence.installs.filter(
    (i) => i.kind === "manifest" && policy.pluginPackages.includes(i.package),
  );
  const checks = {
    sdkInstalled: evidence.installs.length > 0,
    sdkCalledInAppCode: app.length > 0,
    envApiKeyPresent: envKey,
    ...(plugins.length ? { armorclawPlugin: true } : {}),
  };

  if (plugins.length) {
    const where = [...new Set(plugins.map((i) => i.path))].sort().join(", ");
    return {
      outcome: "pass",
      reasons: [
        `ArmorIQ plugin ${[...new Set(plugins.map((i) => i.package))].join(", ")} declared in ${where} (loaded by the agent runtime, e.g. OpenClaw)`,
      ],
      checks,
    };
  }

  if (installed && app.length && (envKey || !policy.envRequired)) {
    const where = [...new Set(app.map((u) => `${u.path}:${u.line}`))].sort().slice(0, 5).join(", ");
    return {
      outcome: "pass",
      reasons: [`ArmorIQ SDK installed and called in application code (${where})`],
      checks,
    };
  }

  const reasons: string[] = [];
  if (app.length && !installed) {
    reasons.push(
      "SDK calls found but no install declaration in manifests, lockfiles, Dockerfiles, scripts or notebooks",
    );
  }
  if (app.length && installed && policy.envRequired && !envKey)
    reasons.push("SDK is called but no ARMORIQ_API_KEY was found in any env file");
  if (tests.length && !app.length) reasons.push("ArmorIQ SDK is called only in test files");
  if (notebook.length && !app.length) reasons.push("ArmorIQ SDK is called only in notebooks");
  if (http.length && !app.length) reasons.push("direct HTTP calls to the ArmorIQ API without SDK calls");
  if (imports.length && !app.length) {
    reasons.push(
      "ArmorIQ SDK imported in application code but no SDK call could be traced (e.g. dynamic, wrapped or re-exported use)",
    );
  }
  reasons.push(...evidence.unresolved);
  if (reasons.length) return { outcome: "unresolved", reasons, checks };
  if (evidence.installs.length)
    return {
      outcome: "fail",
      reasons: ["ArmorIQ SDK is installed but never called in application code"],
      checks,
    };
  return {
    outcome: "fail",
    reasons: ["No ArmorIQ SDK install declaration and no SDK calls were found"],
    checks,
  };
}

export async function decideGate(
  evidence: ArmorIQEvidence,
  snapshot: RepoSnapshot,
  policy: GatePolicy,
  /** null when no second opinion is configured: unresolved cases go straight to a human. */
  jev: JevClient | null,
): Promise<GateResult> {
  const { outcome, reasons, checks } = classify(evidence, policy);
  const flags: string[] = [];
  if (snapshot.commitsAfterDeadline > 0)
    flags.push(`${snapshot.commitsAfterDeadline} commit(s) after the deadline`);
  if (evidence.secretExposed) flags.push("ArmorIQ API key committed to the repository (value redacted)");
  const result = (status: GateResult["status"], extra: Partial<GateResult> = {}) =>
    GateResultSchema.parse({ status, checks, reasons, flags, ...extra });

  if (outcome === "pass") return result("pass");
  if (outcome === "fail" && snapshot.requestedRef && !snapshot.resolvedRef) {
    reasons.push(
      `the team linked '${snapshot.requestedRef}', which is not a branch or tag of the repository, so the default branch was scanned; a judge should check the intended branch before disqualifying`,
    );
    return result("review");
  }
  if (outcome === "fail" && snapshot.commitsAfterDeadline > 0) {
    // Pinning can miss SDK work that landed via a post-deadline squash/rebase: let a judge decide.
    reasons.push(
      `the pre-deadline commit fails the ArmorIQ check, but ${snapshot.commitsAfterDeadline} later commit(s) exist; a judge should confirm before disqualifying`,
    );
    return result("review");
  }
  if (outcome === "fail") return result("fail", { feedbackMd: disqualificationFeedback(evidence, reasons) });

  // Unresolved: Jev can promote to pass or send to a human. It never disqualifies.
  if (!jev) {
    reasons.push("no second opinion is configured, so a judge decides this unresolved case");
    return result("review");
  }
  const decision = (await jev.decide(gateState(evidence, reasons), gateQuestions()))[SDK_CALLED_IN_APP_CODE];
  const p = Number(decision.value);
  return result(p >= policy.jevPass ? "pass" : "review", {
    reasons: [...reasons, `Jev P(application code calls the SDK) = ${p.toFixed(2)}`],
    jev: [decision],
  });
}
