import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app";
import { sessionCookie, sign } from "../../src/api/auth";
import { DEFAULT_LIMITS } from "../../src/digest/media";
import { EvaluationSchema } from "../../src/schemas/evaluation";
import { MediaDigestSchema } from "../../src/schemas/evidence";
import { loadSettings, policyOf, type Settings } from "../../src/settings";
import { openDb } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { fakeDeps } from "../fakes";
import { tempDir } from "../helpers";
import { FIXTURE, SCRIPT } from "../scenario";

const SESSION_SECRET = "test-session-secret";
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const RUBRIC_YAML = readFileSync("config/rubrics/example_rubric.yaml", "utf8");
let app: FastifyInstance;
let settings: Settings;
let dir: string;

const auth = { cookie: `hackeval_session=${sessionCookie(SESSION_SECRET, "fuzail@armoriq.io")}` };
/** A Google token endpoint that answers with an ID token carrying these claims. */
const idToken = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
let googleClaims: Record<string, unknown> = {};
const googleFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body));
  if (body.get("client_secret") !== "test-secret" || !body.get("code_verifier"))
    return new Response("{}", { status: 400 });
  return new Response(JSON.stringify({ id_token: idToken(googleClaims) }), { status: 200 });
}) as typeof fetch;
const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, payload });
const form = (fields: Record<string, string | Blob>, files: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, path] of Object.entries(files))
    fd.append(k, new Blob([readFileSync(path)]), path.split("/").at(-1));
  return fd;
};
const waitForRun = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const run = (await api("GET", `/api/runs/${id}`)).json();
    if (run.state !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run did not finish");
};
async function setup() {
  expect((await api("POST", "/api/hackathons", { id: "demo", name: "Demo" })).statusCode).toBe(201);
  expect((await api("PUT", "/api/hackathons/demo/rubric", { yaml: RUBRIC_YAML })).statusCode).toBe(200);
  const imported = await app.inject({
    method: "POST",
    url: "/api/hackathons/demo/import",
    headers: auth,
    payload: form({}, { file: FIXTURE }),
  });
  expect(imported.statusCode, imported.body).toBe(200);
  return imported.json();
}

beforeEach(async () => {
  dir = tempDir();
  settings = loadSettings({
    HACKEVAL_DB_PATH: join(dir, "api.db"),
    HACKEVAL_WORKSPACE: join(dir, "ws"),
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
    HACKEVAL_SESSION_SECRET: SESSION_SECRET,
  });
  app = await buildApp({
    settings,
    db: openDb(settings.dbPath),
    buildDeps: (s, rubric) => fakeDeps(rubric, policyOf(s), SCRIPT),
    googleFetch,
  });
});
afterEach(async () => {
  await app.close();
});

describe("API auth", () => {
  const valid = (email = "isha@armoriq.io") => ({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    email,
    email_verified: true,
  });

  /** Start sign-in, then come back from Google with the given state (default: the one we were sent with). */
  async function signIn(claims: Record<string, unknown>, tamperState = false) {
    googleClaims = claims;
    const start = await app.inject({ method: "GET", url: "/api/auth/google" });
    expect(start.statusCode).toBe(302);
    const google = new URL(String(start.headers.location));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8000/api/auth/google/callback");
    const oauth = start.cookies.find((c) => c.name === "hackeval_oauth");
    const state = tamperState ? "forged" : (google.searchParams.get("state") ?? "");
    return app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${state}`,
      cookies: { hackeval_oauth: oauth?.value ?? "" },
    });
  }

  it("refuses to start without Google sign-in configured", async () => {
    const open = loadSettings({ HACKEVAL_DB_PATH: join(dir, "x.db"), HACKEVAL_WORKSPACE: join(dir, "ws") });
    await expect(buildApp({ settings: open, db: openDb(open.dbPath) })).rejects.toThrow(
      "GOOGLE_OAUTH_CLIENT_ID",
    );
  });

  it("only the allowlisted emails get in (fuzail@ and isha@ by default)", async () => {
    const ok = await signIn(valid("Isha@ArmorIQ.io"));
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe("/");
    const cookie = ok.cookies.find((c) => c.name === "hackeval_session");
    expect(cookie?.httpOnly).toBe(true);
    const me = await app.inject({
      method: "GET",
      url: "/api/session",
      cookies: { hackeval_session: cookie?.value ?? "" },
    });
    expect(me.json()).toEqual({ email: "isha@armoriq.io" });

    const outsider = await signIn(valid("someone@gmail.com"));
    expect(outsider.headers.location).toMatch(/^\/\?signin_error=.*not%20allowed/);
    expect(outsider.cookies.find((c) => c.name === "hackeval_session")).toBeUndefined();
  });

  it("rejects a forged state, an unverified email, another app's token and a non-Google issuer", async () => {
    for (const [claims, tamper] of [
      [valid(), true],
      [{ ...valid(), email_verified: false }, false],
      [{ ...valid(), aud: "someone-else" }, false],
      [{ ...valid(), iss: "https://evil.example" }, false],
      [{ ...valid(), exp: Math.floor(Date.now() / 1000) - 10 }, false],
    ] as const) {
      const res = await signIn(claims, tamper);
      expect(res.headers.location, JSON.stringify(claims)).toMatch(/^\/\?signin_error=/);
      expect(res.cookies.find((c) => c.name === "hackeval_session")).toBeUndefined();
    }
  });

  it("there is no token: forged, expired or bearer credentials are refused", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/hackathons" })).statusCode).toBe(401);
    const bearer = await app.inject({
      method: "GET",
      url: "/api/hackathons",
      headers: { authorization: `Bearer ${SESSION_SECRET}` },
    });
    expect(bearer.statusCode).toBe(401);
    for (const value of [
      sessionCookie("another-secret", "fuzail@armoriq.io"),
      sign(SESSION_SECRET, { email: "fuzail@armoriq.io", exp: Math.floor(Date.now() / 1000) - 1 }),
      "garbage",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/hackathons",
        cookies: { hackeval_session: value },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await api("GET", "/api/hackathons")).statusCode).toBe(200);
  });

  it("percent-encoded or oddly spelled API paths cannot skip auth", async () => {
    for (const url of ["/%61pi/hackathons", "/ap%69/hackathons", "/api/%68ackathons", "//api/hackathons"]) {
      const res = await app.inject({ method: "GET", url });
      expect([401, 404], url).toContain(res.statusCode);
    }
    const create = await app.inject({ method: "POST", url: "/%61pi/hackathons", payload: { id: "x" } });
    expect(create.statusCode).toBe(401);
  });
});

describe("API organizer flow", () => {
  it("creates a hackathon, imports, runs, reviews and exports the leaderboard", async () => {
    expect((await setup()).created).toBe(7);
    const bad = await api("PUT", "/api/hackathons/demo/rubric", {
      yaml: "id: x\nversion: '1'\ncriteria: []\n",
    });
    expect(bad.statusCode).toBe(400);

    const start = await api("POST", "/api/hackathons/demo/runs", { phase: "all" });
    expect(start.statusCode).toBe(202);
    const run = await waitForRun(start.json().id);
    expect(run.state).toBe("done");
    expect(run.report.processed).toBe(11);

    const detail = (await api("GET", "/api/hackathons/demo")).json();
    expect(detail.byStatus).toMatchObject({ finalized: 2, needs_review: 1, disqualified: 1 });
    expect(detail.rubric.id).toBe("example");

    const queue = (await api("GET", "/api/hackathons/demo/review-queue")).json() as {
      id: string;
      teamName: string;
    }[];
    const echo = queue.find((i) => i.teamName === "Echo");
    expect(echo).toBeDefined();
    const decided = await api("POST", `/api/submissions/${echo?.id}/decision`, {
      decision: "override",
      reviewer: "ana",
      overrides: { demo_quality: "Partial" },
    });
    expect(decided.json()).toEqual({ from: "needs_review", to: "finalized" });
    const invalid = await api("POST", `/api/submissions/${echo?.id}/decision`, {
      decision: "accept",
      reviewer: "ana",
    });
    expect(invalid.statusCode).toBe(409);

    const list = (await api("GET", "/api/hackathons/demo/submissions?status=finalized")).json() as unknown[];
    expect(list).toHaveLength(3);
    const one = (await api("GET", `/api/submissions/${echo?.id}`)).json();
    expect(one.submission.teamName).toBe("Echo");
    expect(one.evaluation.reviews[0].reviewer).toBe("ana");

    const board = (await api("GET", "/api/hackathons/demo/leaderboard")).json() as { teamName: string }[];
    expect(board).toHaveLength(3);
    const csv = await api("GET", "/api/hackathons/demo/leaderboard.csv");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toContain("rank");
  });

  it("rejects a second run on the same hackathon while one is active, and runs without a rubric", async () => {
    await api("POST", "/api/hackathons", { id: "empty" });
    expect((await api("POST", "/api/hackathons/empty/runs", {})).statusCode).toBe(409);
    await app.close();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    app = await buildApp({
      settings,
      db: openDb(settings.dbPath),
      buildDeps: (s, rubric) => {
        const deps = fakeDeps(rubric, policyOf(s), SCRIPT);
        return { ...deps, acquireRepo: async (sub) => gate.then(() => deps.acquireRepo(sub)) };
      },
    });
    await setup();
    const first = await api("POST", "/api/hackathons/demo/runs", {});
    expect(first.statusCode).toBe(202);
    const second = await api("POST", "/api/hackathons/demo/runs", {});
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("already in progress");
    release();
    expect((await waitForRun(first.json().id)).state).toBe("done");
  });

  it("adds a submission with an uploaded deck; server-side paths are not accepted from clients", async () => {
    await setup();
    const added = await app.inject({
      method: "POST",
      url: "/api/hackathons/demo/submissions",
      headers: auth,
      payload: form(
        { teamName: "Kilo", repoUrl: "https://github.com/example/kilo" },
        { deck: "tests/fixtures/decks/deck3.pdf" },
      ),
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().outcome).toBe("created");
    const kilo = (await api("GET", "/api/hackathons/demo/submissions"))
      .json()
      .find((s: { teamName: string }) => s.teamName === "Kilo");
    const sub = (await api("GET", `/api/submissions/${kilo.id}`)).json().submission;
    expect(sub.deck.origin).toBe("upload");
    expect(sub.deck.uri.startsWith(resolve(settings.workspace, "uploads"))).toBe(true);

    const sneaky = await app.inject({
      method: "POST",
      url: "/api/hackathons/demo/submissions",
      headers: auth,
      payload: form({ teamName: "Lima", repoUrl: "https://github.com/example/lima", deckUrl: "/etc/passwd" }),
    });
    expect(sneaky.statusCode).toBe(400);
  });

  it("rejects an uploaded deck over the deck size limit", async () => {
    await app.close();
    app = await buildApp({
      settings,
      db: openDb(settings.dbPath),
      limits: { ...DEFAULT_LIMITS, deckMaxBytes: 1000 },
    });
    await api("POST", "/api/hackathons", { id: "demo" });
    const res = await app.inject({
      method: "POST",
      url: "/api/hackathons/demo/submissions",
      headers: auth,
      payload: form(
        { teamName: "Big", repoUrl: "https://github.com/example/big" },
        { deck: "tests/fixtures/decks/deck3.pdf" },
      ),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("larger than");
  });

  it("attaching a file to an unreachable-media submission requeues it", async () => {
    await setup();
    await waitForRun((await api("POST", "/api/hackathons/demo/runs", {})).json().id);
    const foxtrot = (await api("GET", "/api/hackathons/demo/review-queue"))
      .json()
      .find((i: { teamName: string }) => i.teamName === "Foxtrot");
    const attached = await app.inject({
      method: "POST",
      url: `/api/submissions/${foxtrot.id}/attach`,
      headers: auth,
      payload: form({ reviewer: "ana" }, { video: "tests/fixtures/decks/deck3.pdf" }),
    });
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json()).toEqual({ from: "needs_attention", to: "scoring" });
  });
});

describe("API media", () => {
  async function scoredWithMedia() {
    await setup();
    const db = openDb(settings.dbPath);
    const [{ submission }] = q.currentSubmissions(db, "demo");
    const ws = resolve(settings.workspace);
    const slideDir = join(ws, "cache", "media", "abc.deck.x");
    mkdirSync(slideDir, { recursive: true });
    writeFileSync(join(slideDir, "slide-001.png"), "\x89PNG slide one");
    symlinkSync("/etc/hosts", join(slideDir, "slide-002.png"));
    const videoDir = join(ws, "media", submission.id);
    mkdirSync(videoDir, { recursive: true });
    writeFileSync(join(videoDir, "video.mp4"), Buffer.from("0123456789abcdef"));
    const media = MediaDigestSchema.parse({
      deck: {
        sourceFormat: "pdf",
        slideCount: 3,
        slides: [
          { index: 1, text: "one", imagePath: join(slideDir, "slide-001.png") },
          { index: 2, text: "two", imagePath: join(slideDir, "slide-002.png") },
          { index: 3, text: "three", imagePath: "/etc/hosts" },
        ],
      },
    });
    q.saveEvaluation(db, EvaluationSchema.parse({ submissionId: submission.id, status: "finalized", media }));
    db.close();
    return submission.id;
  }

  it("serves slide images from the stored digest, never files outside the workspace", async () => {
    const id = await scoredWithMedia();
    const slide = await api("GET", `/api/submissions/${id}/slides/1`);
    expect(slide.statusCode).toBe(200);
    expect(slide.body).toContain("slide one");
    expect((await api("GET", `/api/submissions/${id}/slides/2`)).statusCode).toBe(404); // symlink out
    expect((await api("GET", `/api/submissions/${id}/slides/3`)).statusCode).toBe(404); // absolute path out
    expect((await api("GET", `/api/submissions/${id}/slides/9`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/submissions/${id}/slides/1` })).statusCode).toBe(
      401,
    );
  });

  it("streams the video with Range support", async () => {
    const id = await scoredWithMedia();
    const part = await app.inject({
      method: "GET",
      url: `/api/submissions/${id}/video`,
      headers: { ...auth, range: "bytes=4-7" },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 4-7/16");
    expect(part.body).toBe("4567");
    expect((await api("GET", "/api/submissions/nope/video")).statusCode).toBe(404);
  });
});

describe("web UI", () => {
  it("serves the built UI at / with client-side routes falling back to index.html", async () => {
    const web = join(dir, "web-dist");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>hackeval</title>");
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    await app.close();
    app = await buildApp({ settings, db: openDb(settings.dbPath), webDist: web });
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("<title>hackeval</title>");
    expect((await app.inject({ method: "GET", url: "/h/demo/review" })).body).toContain(
      "<title>hackeval</title>",
    );
    expect((await app.inject({ method: "GET", url: "/assets/app.js" })).body).toBe("console.log(1)");
    const missing = await api("GET", "/api/nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });
  });
});

describe("OpenAPI", () => {
  it("documents the routes", async () => {
    const spec = (await api("GET", "/api/openapi.json")).json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/hackathons",
        "/api/hackathons/{hid}/runs",
        "/api/submissions/{id}/decision",
      ]),
    );
  });
});
