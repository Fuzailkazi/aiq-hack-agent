/** Write the API's OpenAPI document to web/openapi.json (the UI's types are generated from it). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/api/app";
import { loadSettings } from "../src/settings";
import { openDb } from "../src/store/db";

const workspace = mkdtempSync(join(tmpdir(), "hackeval-spec-"));
const settings = loadSettings({ HACKEVAL_ADMIN_TOKEN: "spec-only", HACKEVAL_WORKSPACE: workspace });
const app = await buildApp({ settings, db: openDb(":memory:") });
await app.ready();
writeFileSync(new URL("../web/openapi.json", import.meta.url), `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
