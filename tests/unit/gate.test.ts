import { describe, expect, it } from "vitest";
import { GatePolicySchema } from "../../src/config";
import { SDK_CALLED_IN_APP_CODE } from "../../src/jev/gateQuestions";
import {
  ArmorIQEvidenceSchema,
  type InstallHit,
  RepoSnapshotSchema,
  type UsageSite,
} from "../../src/schemas/evidence";
import { classify, decideGate } from "../../src/stages/gate";
import { FakeJevClient } from "../fakes";

const POLICY = GatePolicySchema.parse({});
const SNAP = RepoSnapshotSchema.parse({
  url: "u",
  commitSha: "c".repeat(40),
  committerDate: "2026-10-01T00:00:00Z",
  fileCount: 1,
});
const INSTALL: InstallHit = {
  path: "requirements.txt",
  kind: "manifest",
  ecosystem: "pypi",
  package: "armoriq-sdk",
  versionSpec: null,
};
const site = (over: Partial<UsageSite> = {}): UsageSite => ({
  path: "app.py",
  line: 3,
  symbol: "invoke",
  kind: "call",
  snippet: "client.invoke()",
  inTest: false,
  typeOnly: false,
  ...over,
});
const ev = (over: Record<string, unknown> = {}) => ArmorIQEvidenceSchema.parse(over);

describe("classify", () => {
  it.each([
    ["installed + app call", ev({ installs: [INSTALL], usageSites: [site()] }), "pass"],
    ["nothing", ev(), "fail"],
    ["installed only", ev({ installs: [INSTALL] }), "fail"],
    [
      "installed + untraced import",
      ev({ installs: [INSTALL], usageSites: [site({ kind: "import" })] }),
      "unresolved",
    ],
    [
      "installed + type-only import",
      ev({ installs: [INSTALL], usageSites: [site({ kind: "import", typeOnly: true })] }),
      "fail",
    ],
    ["calls without install", ev({ usageSites: [site()] }), "unresolved"],
    ["test-only calls", ev({ installs: [INSTALL], usageSites: [site({ inTest: true })] }), "unresolved"],
    [
      "notebook-only calls",
      ev({ installs: [INSTALL], usageSites: [site({ path: "nb.ipynb" })] }),
      "unresolved",
    ],
    [
      "HTTP-only",
      ev({ installs: [INSTALL], usageSites: [site({ kind: "http_call", symbol: "armoriq.ai" })] }),
      "unresolved",
    ],
    [
      "scanner unresolved",
      ev({ installs: [INSTALL], unresolved: ["dynamic import of @armoriq/sdk in x.ts:2"] }),
      "unresolved",
    ],
  ])("%s -> %s", (_name, evidence, expected) => {
    const { outcome, reasons } = classify(evidence, POLICY);
    expect(outcome, reasons.join("; ")).toBe(expected);
  });

  it("explains an untraced import", () => {
    const { reasons } = classify(ev({ installs: [INSTALL], usageSites: [site({ kind: "import" })] }), POLICY);
    expect(
      reasons.some((r) => r.includes("imported in application code but no SDK call could be traced")),
    ).toBe(true);
  });

  it("honours policy switches", () => {
    const testOnly = ev({ installs: [INSTALL], usageSites: [site({ inTest: true })] });
    expect(classify(testOnly, GatePolicySchema.parse({ testOnlyUsageCounts: true })).outcome).toBe("pass");
    const noEnv = ev({ installs: [INSTALL], usageSites: [site()] });
    expect(classify(noEnv, GatePolicySchema.parse({ envRequired: true })).outcome).toBe("unresolved");
    const withEnv = { ...noEnv, envSignals: [{ path: ".env", var: "ARMORIQ_API_KEY", hasRealValue: false }] };
    expect(classify(withEnv, GatePolicySchema.parse({ envRequired: true })).outcome).toBe("pass");
  });
});

describe("decideGate", () => {
  it("fails with feedback and no Jev call", async () => {
    const jev = new FakeJevClient();
    const gate = await decideGate(ev({ installs: [INSTALL] }), SNAP, POLICY, jev);
    expect(gate.status).toBe("fail");
    expect(jev.calls).toEqual([]);
    expect(gate.feedbackMd).toContain("installed but never called");
    expect(gate.feedbackMd).toContain("requirements.txt");
  });

  it.each([
    [0.95, "pass"],
    [0.8, "pass"],
    [0.5, "review"],
    [0.05, "review"],
  ])("unresolved goes to Jev (p=%s -> %s) and Jev never disqualifies", async (p, status) => {
    const jev = new FakeJevClient({ [SDK_CALLED_IN_APP_CODE]: p });
    const gate = await decideGate(ev({ usageSites: [site()] }), SNAP, POLICY, jev);
    expect(gate.status).toBe(status);
    expect(gate.jev.map((d) => d.questionId)).toEqual([SDK_CALLED_IN_APP_CODE]);
    expect((jev.calls[0].state as { usageSites: { location: string }[] }).usageSites[0].location).toBe(
      "app.py:3",
    );
  });

  it("without a second opinion, unresolved goes to a judge and is never disqualified", async () => {
    const gate = await decideGate(ev({ usageSites: [site()] }), SNAP, POLICY, null);
    expect(gate.status).toBe("review");
    expect(gate.jev).toEqual([]);
    expect(gate.reasons.join(" ")).toContain("no second opinion is configured");
  });

  it("raises flags and keeps secrets out of the Jev state", async () => {
    const evidence = ev({
      usageSites: [
        site({
          kind: "client_init",
          symbol: "ArmorIQClient",
          snippet: 'ArmorIQClient(api_key="ak_****ffee")',
        }),
      ],
      secretExposed: true,
      redactedKeys: ["ak_****ffee"],
    });
    const jev = new FakeJevClient({ [SDK_CALLED_IN_APP_CODE]: 0.9 });
    const gate = await decideGate(evidence, { ...SNAP, commitsAfterDeadline: 2 }, POLICY, jev);
    expect(gate.flags).toEqual([
      "2 commit(s) after the deadline",
      "ArmorIQ API key committed to the repository (value redacted)",
    ]);
    expect(JSON.stringify(jev.calls[0].state)).not.toContain("ak_live");
  });

  it("sends a failing pinned commit with later commits to review, not DQ", async () => {
    const jev = new FakeJevClient();
    const gate = await decideGate(
      ev({ installs: [INSTALL] }),
      { ...SNAP, commitsAfterDeadline: 3 },
      POLICY,
      jev,
    );
    expect(gate.status).toBe("review");
    expect(jev.calls).toEqual([]);
    expect(gate.reasons.some((r) => r.includes("3 later commit(s)"))).toBe(true);
  });
});

describe("branch links in the gate", () => {
  it("a FAIL on the default branch, when the team linked a ref we could not find, goes to a judge", async () => {
    const snapshot = RepoSnapshotSchema.parse({
      url: "https://github.com/o/r",
      commitSha: "a".repeat(40),
      committerDate: "2026-10-01T00:00:00Z",
      fileCount: 1,
      requestedRef: "hackathon",
      resolvedRef: null,
    });
    const result = await decideGate(
      ArmorIQEvidenceSchema.parse({}),
      snapshot,
      GatePolicySchema.parse({}),
      new FakeJevClient(),
    );
    expect(result.status).toBe("review");
    expect(result.reasons.join(" ")).toContain("'hackathon'");
  });
});
