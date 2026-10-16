/** Shared test helpers. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, type Policy } from "../src/config";
import { loadRubric, type Rubric } from "../src/schemas/rubric";
import { type DB, openDb } from "../src/store/db";

export const tempDir = (prefix = "hackeval-"): string => mkdtempSync(join(tmpdir(), prefix));
export const testDb = (): DB => openDb(":memory:");
export const exampleRubric = (): Rubric => loadRubric("config/rubrics/example_rubric.yaml");
export const shippedPolicy = (): Policy => loadPolicy("config/policy.yaml");
