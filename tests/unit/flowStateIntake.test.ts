import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IntakeMappingSchema, loadIntake } from "../../src/config";
import { importCsv, parseTimestamp, trackOf, zonedToIso } from "../../src/intake";
import { loadRubric } from "../../src/schemas/rubric";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { tempDir, testDb } from "../helpers";

const NOW = "2026-10-17T00:00:00Z";

const stringify = (rows: string[][]): string =>
  rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\r\n");

describe("naive timestamps in a configured timezone", () => {
  it("reads Google Forms times as Asia/Kolkata", () => {
    expect(zonedToIso("10/14/2026 12:26:21", "Asia/Kolkata")).toBe("2026-10-14T06:56:21Z");
    expect(zonedToIso("10/16/2026 3:27:28", "Asia/Kolkata")).toBe("2026-10-15T21:57:28Z");
    expect(zonedToIso("2026-10-14 12:26", "Asia/Kolkata")).toBe("2026-10-14T06:56:00Z");
  });

  it("follows daylight saving time", () => {
    expect(zonedToIso("7/1/2026 12:00:00", "America/New_York")).toBe("2026-07-01T16:00:00Z");
    expect(zonedToIso("12/1/2026 12:00:00", "America/New_York")).toBe("2026-12-01T17:00:00Z");
  });

  it("rejects impossible dates and unknown formats", () => {
    expect(zonedToIso("2/30/2026 10:00:00", "Asia/Kolkata")).toBeNull();
    expect(zonedToIso("yesterday", "Asia/Kolkata")).toBeNull();
    expect(() => parseTimestamp("yesterday", NOW, "submitted_at", "Asia/Kolkata")).toThrow(
      /not a recognized/,
    );
  });

  it("keeps explicit offsets and still rejects naive times without a timezone", () => {
    expect(parseTimestamp("2026-10-14T12:00:00+05:30", NOW, "submitted_at", "Asia/Kolkata")).toBe(
      "2026-10-14T12:00:00+05:30",
    );
    expect(() => parseTimestamp("10/14/2026 12:26:21", NOW)).toThrow(/set timezone in intake.yaml/);
  });
});

describe("track rules", () => {
  const cells: Record<string, string | null> = { "Did you use ElevenLabs?": "yes ", Track: "agents" };
  const cell = (c: string) => cells[c] ?? null;

  it("maps a column's value to a track, case-insensitively, with a default", () => {
    const rule = { column: "Did you use ElevenLabs?", values: { Yes: "elevenlabs" }, default: "main" };
    expect(trackOf(rule, cell)).toBe("elevenlabs");
    expect(trackOf(rule, () => "No")).toBe("main");
    expect(trackOf(rule, () => null)).toBe("main");
  });

  it("still reads a plain track column", () => {
    expect(trackOf("Track", cell)).toBe("agents");
    expect(trackOf(null, cell)).toBeNull();
  });
});

describe("Flow State Google Form import", () => {
  let db: DB;
  let dir: string;
  const mapping = loadIntake("config/intake.flow_state.yaml");
  const headers = [
    "Timestamp",
    "Team name",
    "Team leader's full name",
    "Team leader's email",
    "Have you subscribed to the ArmorTools Pro plan for each member?",
    "Project name",
    "GitHub repo URL for the project",
    "Live demo URL",
    "Demo video URL (3 to 5 minutes; YouTube, Loom or Vimeo link)",
    "How did you use ArmorIQ?",
    "Did you use ElevenLabs?",
    "If yes, how did you integrate ElevenLabs? (answer only if you chose Yes above)",
    "ArmorTools feedback: what worked, what did not (optional)",
  ];
  const row = (team: string, at: string, elevenlabs: string, demo: string) => [
    at,
    team,
    "Leader Name",
    "leader@example.com",
    "Yes",
    `${team} project`,
    `https://github.com/o/${team.toLowerCase()}.git`,
    demo,
    "https://youtu.be/abcdefghijk",
    "Every tool call goes through invokeWithPolicy.",
    elevenlabs,
    elevenlabs === "Yes" ? "Voice alerts" : "",
    "",
  ];

  beforeEach(() => {
    db = testDb();
    dir = tempDir();
    q.createHackathon(db, "h", "Flow State", "2026-10-20T18:29:00Z");
  });

  it("imports form rows: Kolkata timestamps, tracks, live demo and answers without personal data", () => {
    const path = join(dir, "responses.csv");
    writeFileSync(
      path,
      stringify([
        headers,
        row("Semicolon", "10/14/2026 12:26:21", "Yes", "https://secure-flow.example.app"),
        row("Dune", "10/16/2026 3:27:28", "No", "not a url"),
      ]),
    );
    const report = importCsv(db, "h", path, mapping, NOW);
    expect(report).toMatchObject({ created: 2, errors: [] });
    const subs = Object.fromEntries(
      q.currentSubmissions(db, "h").map((r) => [r.submission.teamName, r.submission]),
    );
    expect(subs.Semicolon).toMatchObject({
      track: "elevenlabs",
      submittedAt: "2026-10-14T06:56:21Z",
      repoUrl: "https://github.com/o/semicolon",
      deck: null,
      liveDemoUrl: "https://secure-flow.example.app/",
      video: { kind: "video", origin: "url", uri: "https://youtu.be/abcdefghijk" },
    });
    expect(subs.Semicolon.answers).toEqual({
      projectName: "Semicolon project",
      armortoolsPro: "Yes",
      howArmoriq: "Every tool call goes through invokeWithPolicy.",
      elevenlabsUsed: "Yes",
      elevenlabsHow: "Voice alerts",
    });
    expect(JSON.stringify(subs.Semicolon)).not.toContain("leader@example.com");
    expect(subs.Dune).toMatchObject({
      track: "main",
      liveDemoUrl: null,
      submittedAt: "2026-10-15T21:57:28Z",
    });
  });

  it("fails fast on an unknown timezone", () => {
    const path = join(dir, "responses.csv");
    writeFileSync(path, stringify([headers]));
    const bad = IntakeMappingSchema.parse({ ...mapping, timezone: "Mars/Olympus" });
    expect(() => importCsv(db, "h", path, bad, NOW)).toThrow(/unknown timezone/);
  });

  it("ships a valid Flow State rubric", () => {
    const rubric = loadRubric("config/rubrics/flow_state.yaml");
    expect(rubric.criteria.map((c) => [c.id, c.weight])).toEqual([
      ["demo_video", 40],
      ["live_demo", 40],
      ["armoriq_integration", 20],
      ["takeaways", 15],
      ["armortools_pro", 5],
    ]);
    expect(rubric.tracks).toEqual(["main", "elevenlabs"]);
  });
});
