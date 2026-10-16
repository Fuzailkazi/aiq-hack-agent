/** Live smoke tests for the analyst agents. Run with `npm run test:live` and GOOGLE_API_KEY and/or OPENAI_API_KEY. */
import { describe, expect, it } from "vitest";
import { AdkAnalyze } from "../../src/agents/analysts";
import { buildModel } from "../../src/agents/models";
import { loadModels } from "../../src/config";
import { MediaDigestSchema } from "../../src/schemas/evidence";
import { forSource, loadRubric } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";

const SUB = SubmissionSchema.parse({
  id: "live",
  hackathonId: "live",
  teamName: "Live",
  repoUrl: "https://github.com/o/r",
  submittedAt: new Date().toISOString(),
});
const DECK = MediaDigestSchema.parse({
  deck: {
    sourceFormat: "pdf",
    slideCount: 3,
    slides: [
      { index: 1, text: "GuardRail: every agent tool call is intent-verified with ArmorIQ" },
      { index: 2, text: "Problem: agents execute unintended actions; 3 incidents at our startup" },
      { index: 3, text: "Architecture: planner -> ArmorIQ capture_plan -> intent token -> invoke" },
    ],
  },
});

describe.each([
  ["gemini", "GOOGLE_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
] as const)("deck analyst on %s (live)", (provider, env) => {
  it.skipIf(!process.env[env])("returns a finding for every deck criterion", async () => {
    const rubric = loadRubric("config/rubrics/example_rubric.yaml");
    const models = loadModels("config/models.yaml");
    const findings = await new AdkAnalyze(rubric, (role) => buildModel(provider, role, models)).analyze(
      "deck",
      SUB,
      DECK,
      null,
    );
    expect(findings.findings.map((f) => f.criterionId).sort()).toEqual(
      forSource(rubric, "deck")
        .map((c) => c.id)
        .sort(),
    );
    expect(findings.findings.every((f) => f.provisionalLabel)).toBe(true);
  });
});
