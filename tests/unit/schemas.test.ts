import { describe, expect, it } from "vitest";
import { CalibrationResultSchema } from "../../src/schemas/calibration";
import { EvaluationSchema, GateResultSchema } from "../../src/schemas/evaluation";
import { ArmorIQEvidenceSchema, RepoSnapshotSchema, sdkFunctionsUsed } from "../../src/schemas/evidence";
import { levelsById, ScorecardSchema } from "../../src/schemas/findings";
import { contentKey, naturalKey, normalizeRepoUrl, SubmissionSchema } from "../../src/schemas/submission";

const sub = (over: Record<string, unknown> = {}) =>
  SubmissionSchema.parse({
    id: "s1",
    hackathonId: "h",
    teamName: "Alpha",
    repoUrl: "https://github.com/o/r",
    submittedAt: "2026-10-01T00:00:00Z",
    ...over,
  });

describe("submission", () => {
  it.each([
    "https://github.com/Org/Repo",
    "https://GitHub.com/Org/Repo.git/",
    "git@github.com:Org/Repo.git",
    "http://www.github.com/org/repo",
    "  https://github.com/org/repo/  ",
  ])("normalizes %s to one key", (url) => {
    expect(normalizeRepoUrl(url)).toBe("https://github.com/org/repo");
  });

  it("prefers the organizer's external id as natural key", () => {
    expect(naturalKey(sub({ externalId: "T-7" }))).toBe("T-7");
    expect(naturalKey(sub({ repoUrl: "https://github.com/O/R.git" }))).toBe("https://github.com/o/r");
  });

  it("content key changes with artifacts but not ids", () => {
    const a = sub({ deck: { kind: "deck", origin: "url", uri: "https://x/deck.pdf" } });
    const b = sub({ deck: { kind: "deck", origin: "url", uri: "https://x/deck-v2.pdf" } });
    expect(contentKey(a)).not.toBe(contentKey(b));
    expect(contentKey(sub())).toBe(contentKey(sub({ id: "other" })));
  });

  it("rejects timestamps without an offset", () => {
    expect(() => sub({ submittedAt: "2026-10-01T00:00:00" })).toThrow();
  });
});

describe("evidence and evaluation", () => {
  it("lists SDK functions used (calls and client inits only)", () => {
    const ev = ArmorIQEvidenceSchema.parse({
      usageSites: [
        { path: "a.py", line: 1, symbol: "armoriq_sdk", kind: "import", snippet: "" },
        { path: "a.py", line: 2, symbol: "invoke", kind: "call", snippet: "" },
        { path: "a.py", line: 3, symbol: "ArmorIQClient", kind: "client_init", snippet: "" },
      ],
    });
    expect(sdkFunctionsUsed(ev)).toEqual(["ArmorIQClient", "invoke"]);
  });

  it("scorecard levels by criterion id", () => {
    const card = ScorecardSchema.parse({
      scores: [{ criterionId: "a", levelLabel: "Good", level: 2, rationale: "r" }],
    });
    expect(levelsById(card)).toEqual({ a: 2 });
  });

  it("evaluation survives a JSON round trip", () => {
    const ev = EvaluationSchema.parse({
      submissionId: "s1",
      status: "finalized",
      repo: RepoSnapshotSchema.parse({
        url: "u",
        commitSha: "c".repeat(40),
        committerDate: "2026-10-01T00:00:00Z",
        fileCount: 3,
      }),
      evidence: ArmorIQEvidenceSchema.parse({}),
      gate: GateResultSchema.parse({ status: "pass", reasons: ["ok"] }),
      scorecard: ScorecardSchema.parse({
        scores: [{ criterionId: "a", levelLabel: "Good", level: 2, rationale: "r" }],
      }),
      calibration: CalibrationResultSchema.parse({ autoScore: 80, confidence: 0.9, route: "accept" }),
      autoScore: 80,
      finalScore: 80,
    });
    expect(EvaluationSchema.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
  });
});
