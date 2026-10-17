import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IntakeMappingSchema } from "../../src/config";
import { addSubmission, canonicalRepoUrl, importCsv, repoRefOf } from "../../src/intake";
import type { DB } from "../../src/store/db";
import * as q from "../../src/store/queries";
import { tempDir, testDb } from "../helpers";

const NOW = "2026-10-01T12:00:00Z";
const HEADER = "external_id,team_name,repo_url,deck,video,track,submitted_at\n";
const MAPPING = IntakeMappingSchema.parse({});
let db: DB;
let dir: string;

const csv = (body: string, bom = false): string => {
  const path = join(dir, "subs.csv");
  writeFileSync(path, (bom ? "﻿" : "") + HEADER + body);
  return path;
};

beforeEach(() => {
  db = testDb();
  dir = tempDir();
  q.createHackathon(db, "h", "Hack", "2026-10-02T00:00:00Z");
});

describe("CSV import", () => {
  it("counts outcomes and reports bad rows by line (Excel export with BOM and blank lines)", () => {
    const path = csv(
      "t1,Alpha,https://github.com/o/alpha,https://x/a.pdf,https://youtu.be/a,agents,2026-10-01T10:00:00Z\n" +
        "t2,Bravo,,https://x/b.pdf,,agents,\n\nt3,Late,https://github.com/o/late,,,agents,2026-10-03T00:00:00Z\n",
      true,
    );
    const report = importCsv(db, "h", path, MAPPING, NOW);
    expect([report.created, report.ignoredLate]).toEqual([1, 1]);
    expect(report.errors).toEqual(["row 3: team_name and repo_url are required"]);
    expect(report.late).toEqual(["row 5 (Late): submitted 2026-10-03T00:00:00Z, after the deadline"]);
  });

  it("re-import is unchanged and a resubmission updates", () => {
    const first = csv("t1,Alpha,https://github.com/o/alpha,,,,2026-10-01T10:00:00Z\n");
    expect(importCsv(db, "h", first, MAPPING, NOW).created).toBe(1);
    expect(importCsv(db, "h", first, MAPPING, NOW).unchanged).toBe(1);
    const second = csv("t1,Alpha,https://github.com/o/alpha,https://x/deck.pdf,,,2026-10-01T11:00:00Z\n");
    expect(importCsv(db, "h", second, MAPPING, NOW).updated).toBe(1);
  });

  it("dedupes repo URL spelling variants without an external id", () => {
    const path = csv(
      ",Alpha,https://github.com/Org/Alpha.git,,,,2026-10-01T10:00:00Z\n,Alpha,https://github.com/org/alpha/,,,,2026-10-01T10:00:00Z\n",
    );
    const report = importCsv(db, "h", path, MAPPING, NOW);
    expect([report.created, report.unchanged]).toEqual([1, 1]);
  });

  it("resolves relative upload paths against the CSV folder", () => {
    const path = csv("t1,Alpha,https://github.com/o/alpha,decks/alpha.pdf,https://youtu.be/a,,\n");
    importCsv(db, "h", path, MAPPING, NOW);
    const sub = q.currentSubmissions(db, "h")[0].submission;
    expect(sub.deck).toMatchObject({ origin: "upload", uri: resolve(dir, "decks/alpha.pdf") });
    expect(sub.video).toMatchObject({ origin: "url" });
    expect(sub.submittedAt).toBe(NOW);
  });

  it("fails on a missing required column", () => {
    const path = join(dir, "bad.csv");
    writeFileSync(path, "team,repo\nA,https://github.com/o/a\n");
    expect(() => importCsv(db, "h", path, MAPPING, NOW)).toThrow(/missing required column/);
  });

  it.each(["N/A", "-uhelp", "file:///etc/passwd", "/home/me/repo", "https://evil.example/o/r", "ext::sh"])(
    "rejects repo_url %s as a row error",
    (raw) => {
      const report = importCsv(db, "h", csv(`t1,Alpha,${raw},,,,2026-10-01T10:00:00Z\n`), MAPPING, NOW);
      expect(report.created).toBe(0);
      expect(report.errors[0]).toMatch(/repo_url/);
    },
  );

  it("rejects timestamps without an offset", () => {
    const report = importCsv(
      db,
      "h",
      csv("t1,Alpha,https://github.com/o/a,,,,2026-10-01T10:00:00\n"),
      MAPPING,
      NOW,
    );
    expect(report.errors).toEqual([
      "row 2: submitted_at must include a timezone offset (e.g. 2026-10-01T10:00:00Z), or set timezone in intake.yaml",
    ]);
  });

  it.each(["/etc/passwd", "../outside.pdf", "~/.aws/credentials"])(
    "keeps CSV file paths inside the CSV folder: %s",
    (cell) => {
      const report = importCsv(
        db,
        "h",
        csv(`t1,Alpha,https://github.com/o/a,${cell},,,2026-10-01T10:00:00Z\n`),
        MAPPING,
        NOW,
      );
      expect(report.created).toBe(0);
      expect(report.errors[0]).toMatch(/inside the CSV's folder/);
    },
  );
});

describe("repo URLs", () => {
  it.each([
    ["https://github.com/Org/Repo", "https://github.com/Org/Repo"],
    ["github.com/org/repo", "https://github.com/org/repo"],
    ["http://www.github.com/org/repo.git/", "https://github.com/org/repo"],
    ["git@github.com:org/repo.git", "https://github.com/org/repo"],
    ["https://github.com/org/repo/tree/main/src", "https://github.com/org/repo"],
    ["https://gitlab.com/group/sub/repo", "https://gitlab.com/group/sub/repo"],
  ])("canonicalizes %s", (raw, canonical) => {
    expect(canonicalRepoUrl(raw)).toBe(canonical);
  });
});

describe("single add", () => {
  it("adds one submission with a canonical repo URL", () => {
    const outcome = addSubmission(
      db,
      "h",
      { teamName: "Solo", repoUrl: "github.com/o/solo.git", video: "https://youtu.be/s" },
      NOW,
    );
    expect(outcome).toBe("created");
    expect(q.currentSubmissions(db, "h")[0].submission.repoUrl).toBe("https://github.com/o/solo");
  });
});

describe("branch links", () => {
  it("keeps the ref of a /tree/ link (the repo URL itself stays canonical)", () => {
    expect(repoRefOf("https://github.com/o/r/tree/hackathon")).toBe("hackathon");
    expect(repoRefOf("https://github.com/o/r/tree/feature/x/src/")).toBe("feature/x/src");
    expect(repoRefOf("https://github.com/o/r/tree/fix%2Fbug")).toBe("fix/bug");
    expect(repoRefOf("https://github.com/o/r")).toBeNull();
    expect(repoRefOf("https://github.com/o/r/tree/../../etc")).toBeNull();
    expect(repoRefOf("https://github.com/o/r/tree/-uhelp")).toBeNull();
  });
});
