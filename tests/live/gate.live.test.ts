/**
 * Live checks (run with `npm run test:live`):
 * - Jev: real TypeSafe call with the gate question (needs TYPESAFE_API_KEY).
 * - Gate: real clone + scan + rule on organizer-supplied repos:
 *   HACKEVAL_LIVE_REPOS="https://github.com/org/a=pass,https://github.com/org/b=fail"
 */
import { describe, expect, it } from "vitest";
import { acquireRepo } from "../../src/acquire/repo";
import { GatePolicySchema, loadSignatures } from "../../src/config";
import { scanRepo } from "../../src/digest/armoriq";
import { TypeSafeJevClient } from "../../src/jev/client";
import { gateQuestions, SDK_CALLED_IN_APP_CODE } from "../../src/jev/gateQuestions";
import { SubmissionSchema } from "../../src/schemas/submission";
import { classify } from "../../src/stages/gate";
import { tempDir } from "../helpers";

const SNIPPET =
  "client = ArmorIQClient.from_config('armoriq.yaml')\ntoken = client.get_intent_token(client.capture_plan(llm='gpt-4', prompt=p, plan=plan))\nresult = client.invoke(mcp_name='weather', action='get', intent_token=token, inputs={})";

describe.skipIf(!process.env.TYPESAFE_API_KEY)("Jev (live)", () => {
  it("answers the gate question", async () => {
    const client = new TypeSafeJevClient("jev-1.13.0");
    const out = await client.decide(
      {
        openQuestions: ["SDK calls found but no install declaration"],
        installs: [],
        usageSites: [
          { location: "app/main.py:4", symbol: "invoke", kind: "call", inTest: false, snippet: SNIPPET },
        ],
      },
      gateQuestions(),
    );
    const decision = out[SDK_CALLED_IN_APP_CODE];
    expect(decision.type).toBe("noul");
    expect(Number(decision.value)).toBeGreaterThanOrEqual(0);
    expect(decision.model.startsWith("jev-")).toBe(true);
  });
});

const CASES = (process.env.HACKEVAL_LIVE_REPOS ?? "")
  .split(",")
  .filter((item) => item.includes("="))
  .map((item) => [item.slice(0, item.lastIndexOf("=")), item.slice(item.lastIndexOf("=") + 1)] as const);

describe.skipIf(!CASES.length)("gate on real repositories (live)", () => {
  it.each(CASES)("%s -> %s", async (url, expected) => {
    const sub = SubmissionSchema.parse({
      id: "live",
      hackathonId: "live",
      teamName: "live",
      repoUrl: url,
      submittedAt: new Date().toISOString(),
    });
    const acquisition = await acquireRepo(sub, {
      workspace: tempDir(),
      deadline: null,
      pinToDeadline: false,
      timeoutS: 300,
      maxMb: 500,
      githubToken: process.env.GITHUB_TOKEN,
    });
    expect(acquisition.path, acquisition.unreachableReason ?? "").not.toBeNull();
    const evidence = await scanRepo(
      acquisition.path as string,
      loadSignatures("config/armoriq_signatures.yaml"),
    );
    const { outcome, reasons } = classify(evidence, GatePolicySchema.parse({}));
    expect(outcome, reasons.join("; ")).toBe(expected);
  });
});
