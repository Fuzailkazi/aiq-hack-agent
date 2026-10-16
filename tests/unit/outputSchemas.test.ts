import { describe, expect, it } from "vitest";
import {
  analystOutputSchema,
  synthesisOutputSchema,
  toArtifactFindings,
  toScorecard,
} from "../../src/agents/outputSchemas";
import { forSource, levelIndex } from "../../src/schemas/rubric";
import { exampleRubric } from "../helpers";

const rubric = exampleRubric();
const finding = (label: string) => ({
  observations: ["clear demo"],
  citations: [{ source: "deck", ref: "slide 2" }],
  provisionalLevel: label,
});
const analystData = () => ({
  summary: "A guard for agents",
  claims: ["blocks unsafe tool calls"],
  redFlags: [],
  findings: Object.fromEntries(forSource(rubric, "deck").map((c) => [c.id, finding(c.levels[2].label)])),
});

describe("output schemas", () => {
  it("analyst output covers only that artifact's criteria", () => {
    const shape = analystOutputSchema(rubric, "deck").shape.findings.shape;
    expect(Object.keys(shape).sort()).toEqual([
      "architecture",
      "innovation",
      "presentation",
      "problem_solution",
    ]);
  });

  it("maps analyst output and rejects unknown labels", () => {
    const findings = toArtifactFindings("deck", rubric, analystData());
    expect(findings.claims).toEqual(["blocks unsafe tool calls"]);
    expect(findings.findings[0]).toMatchObject({
      criterionId: "problem_solution",
      provisionalLabel: "Clear",
    });
    expect(findings.findings[0].citations[0].ref).toBe("slide 2");
    const bad = analystData();
    (bad.findings.problem_solution as { provisionalLevel: string }).provisionalLevel = "Superb";
    expect(() => toArtifactFindings("deck", rubric, bad)).toThrow();
  });

  it("synthesis maps labels to level indices", () => {
    const scores = Object.fromEntries(
      rubric.criteria.map((c) => [c.id, { level: c.levels.at(-1)?.label, rationale: "r", citations: [] }]),
    );
    scores.demo_quality.level = "Mockup";
    const card = toScorecard(rubric, {
      scores,
      strengths: ["s"],
      weaknesses: [],
      inconsistencies: [],
      feedbackMd: "Great work",
    });
    const demo = rubric.criteria.find((c) => c.id === "demo_quality");
    expect(card.scores.find((s) => s.criterionId === "demo_quality")?.level).toBe(
      demo ? levelIndex(demo, "Mockup") : -1,
    );
    expect(card.scores.find((s) => s.criterionId === "innovation")?.level).toBe(3);
    expect(card.feedbackMd).toBe("Great work");
  });

  it("criterion ids that look like reserved words are fine", () => {
    const tricky = {
      ...rubric,
      criteria: [{ ...rubric.criteria[0], id: "constructor" }, ...rubric.criteria.slice(1)],
    };
    expect(Object.keys(synthesisOutputSchema(tricky).shape.scores.shape)).toContain("constructor");
  });
});
