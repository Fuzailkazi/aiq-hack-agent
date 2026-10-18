import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app";
import { sessionCookie } from "../../src/api/auth";
import { IntakeMappingSchema } from "../../src/config";
import { loadSettings, policyOf, type Settings } from "../../src/settings";
import { openDb } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { readSyncStatus, syncOnce } from "../../src/sync";
import { fakeDeps } from "../fakes";
import { tempDir } from "../helpers";
import { FIXTURE, SCRIPT } from "../scenario";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SHEET = "sheet-123";

/** Google: verifies the service account's signed JWT, then serves the sheet as CSV (or 403 if not shared). */
function fakeGoogle(csv: () => string, shared = true): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
      const [h, c, sig] = assertion.split(".");
      const { createVerify } = await import("node:crypto");
      const ok = createVerify("RSA-SHA256")
        .update(`${h}.${c}`)
        .verify(publicKey, Buffer.from(sig, "base64url"));
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      if (!ok || claims.iss !== "robot@proj.iam.gserviceaccount.com")
        return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ access_token: "tok" }));
    }
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${SHEET}/export`)) {
      const auth = new Headers(init?.headers).get("authorization");
      if (!shared || auth !== "Bearer tok") return new Response("{}", { status: 403 });
      return new Response(csv());
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

let dir: string;
let settings: Settings;

beforeEach(() => {
  dir = tempDir();
  const key = join(dir, "sa.json");
  writeFileSync(
    key,
    JSON.stringify({
      client_email: "robot@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  settings = loadSettings({
    HACKEVAL_DB_PATH: join(dir, "s.db"),
    HACKEVAL_WORKSPACE: join(dir, "ws"),
    HACKEVAL_SHEET_ID: SHEET,
    GOOGLE_SERVICE_ACCOUNT_FILE: key,
    HACKEVAL_HACKATHON: "demo",
    HACKEVAL_LOCAL_ONLY: "true",
  });
});

describe("form sheet sync", () => {
  it("imports the sheet, gates only what changed, and remembers the result", async () => {
    const db = openDb(settings.dbPath);
    q.createHackathon(db, "demo", "Demo", "2026-10-20T00:00:00Z");
    const runs: string[] = [];
    let csv = readFileSync(FIXTURE, "utf8");
    const deps = {
      db,
      settings,
      mapping: IntakeMappingSchema.parse({}),
      fetchImpl: fakeGoogle(() => csv),
      startRun: (_hid: string, phase: string) => {
        runs.push(phase);
        return `run-${runs.length}`;
      },
    };
    const first = await syncOnce("demo", deps);
    expect(first).toMatchObject({ ok: true, created: 7, updated: 0, error: null, runId: "run-1" });
    expect(runs).toEqual(["gate"]);

    const again = await syncOnce("demo", deps);
    expect(again).toMatchObject({ ok: true, created: 0, unchanged: 7, runId: null });
    expect(runs).toHaveLength(1);

    csv += "t9,Newcomer,https://github.com/o/newcomer,,,agents,2026-10-01T10:00:00Z\n";
    csv += "t10,Profile Link,https://github.com/justaname,,,agents,2026-10-01T10:00:00Z\n";
    const third = await syncOnce("demo", deps);
    expect(third).toMatchObject({ created: 1, runId: "run-2" });
    expect(third.skipped).toEqual([
      expect.stringMatching(/^row \d+ \(Profile Link\): repo_url must be a repository/),
    ]);
    expect(readSyncStatus(settings.workspace, "demo")).toEqual(third);
  });

  it("says so plainly when the sheet is not shared with the service account", async () => {
    const db = openDb(settings.dbPath);
    q.createHackathon(db, "demo", "Demo", null);
    const status = await syncOnce("demo", {
      db,
      settings,
      mapping: IntakeMappingSchema.parse({}),
      fetchImpl: fakeGoogle(() => "", false),
    });
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/share the sheet with it as a viewer/);
  });

  it("is exposed in the API: status, and Sync now (which starts a gate run)", async () => {
    const db = openDb(settings.dbPath);
    const app = await buildApp({
      settings,
      db,
      buildDeps: (s, rubric) => fakeDeps(rubric, policyOf(s), SCRIPT),
      syncFetch: fakeGoogle(() => readFileSync(FIXTURE, "utf8")),
    });
    const cookie = { hackeval_session: sessionCookie("unused", "x") };
    expect(
      (await app.inject({ method: "POST", url: "/api/hackathons", payload: { id: "demo", name: "Demo" } }))
        .statusCode,
    ).toBe(201);
    await app.inject({
      method: "PUT",
      url: "/api/hackathons/demo/rubric",
      payload: { yaml: readFileSync("config/rubrics/example_rubric.yaml", "utf8") },
      cookies: cookie,
    });
    const before = (await app.inject({ method: "GET", url: "/api/hackathons/demo/sync" })).json();
    expect(before).toMatchObject({ configured: true, intervalMin: 5, autoScore: false, last: null });
    const now = await app.inject({ method: "POST", url: "/api/hackathons/demo/sync" });
    expect(now.json()).toMatchObject({ ok: true, created: 7 });
    expect(now.json().runId).toEqual(expect.any(String));
    expect((await app.inject({ method: "GET", url: "/api/hackathons/demo/sync" })).json().last.created).toBe(
      7,
    );

    await app.inject({ method: "POST", url: "/api/hackathons", payload: { id: "other", name: "Other" } });
    expect((await app.inject({ method: "POST", url: "/api/hackathons/other/sync" })).statusCode).toBe(409);
    await app.close();
  });
});
