import { describe, expect, it } from "vitest";
import {
  criterion,
  forSource,
  hasRepoCriteria,
  levelIndex,
  loadRubric,
  maxIndex,
  type Rubric,
  RubricSchema,
  weightedScore,
} from "../../src/schemas/rubric";

const levels = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `L${i}`, description: `level ${i}` }));
const body = () => ({
  id: "demo",
  version: "1",
  criteria: [
    { id: "clarity", name: "Clarity", description: "d", weight: 2, sources: ["deck"], levels: levels(4) },
    { id: "armoriq", name: "ArmorIQ", description: "d", weight: 1, sources: ["repo"], levels: levels(3) },
  ],
});
const parse = (b: unknown): Rubric => RubricSchema.parse(b);

describe("rubric", () => {
  it("loads the shipped example rubric", () => {
    const rubric = loadRubric("config/rubrics/example_rubric.yaml");
    expect(rubric.id).toBe("example");
    expect(rubric.criteria).toHaveLength(6);
    expect(hasRepoCriteria(rubric)).toBe(true);
  });

  it.each([1, 11])("rejects %i levels (Jev Score allows 2-10)", (n) => {
    const b = body();
    b.criteria[0].levels = levels(n);
    expect(() => parse(b)).toThrow();
  });

  it("rejects duplicate level labels", () => {
    const b = body();
    b.criteria[0].levels[1].label = "L0";
    expect(() => parse(b)).toThrow(/duplicate level labels/);
  });

  it("rejects duplicate criterion ids", () => {
    const b = body();
    b.criteria[1].id = "clarity";
    expect(() => parse(b)).toThrow(/duplicate criterion ids/);
  });

  it("rejects zero weight and non-slug ids", () => {
    const zero = body();
    zero.criteria[0].weight = 0;
    expect(() => parse(zero)).toThrow();
    const slug = body();
    slug.criteria[0].id = "Not A Slug";
    expect(() => parse(slug)).toThrow();
  });

  it("maps labels to indices", () => {
    const clarity = criterion(parse(body()), "clarity");
    expect(levelIndex(clarity, "L2")).toBe(2);
    expect(maxIndex(clarity)).toBe(3);
    expect(() => levelIndex(clarity, "Nope")).toThrow();
  });

  it("selects criteria by source", () => {
    const rubric = parse(body());
    expect(forSource(rubric, "deck").map((c) => c.id)).toEqual(["clarity"]);
    expect(forSource(rubric, "video")).toEqual([]);
  });

  it("computes the weighted 0-100 score", () => {
    const rubric = parse(body());
    // clarity 3/3 = 1.0 (weight 2); armoriq 1/2 = 0.5 (weight 1) -> 2.5 / 3 = 83.33
    expect(weightedScore(rubric, { clarity: 3, armoriq: 1 })).toBe(83.33);
    expect(weightedScore(rubric, { clarity: 0, armoriq: 0 })).toBe(0);
  });

  it("rejects missing or out-of-range levels", () => {
    const rubric = parse(body());
    expect(() => weightedScore(rubric, { clarity: 1 })).toThrow(/missing levels/);
    expect(() => weightedScore(rubric, { clarity: 4, armoriq: 0 })).toThrow(/out of range/);
  });
});
