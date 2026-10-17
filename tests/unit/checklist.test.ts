import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formSummary } from "../../src/agents/messages";
import { scanRepo } from "../../src/digest/armoriq";
import { CalibrationResultSchema } from "../../src/schemas/calibration";
import { EvaluationSchema } from "../../src/schemas/evaluation";
import { ArmorIQEvidenceSchema, MediaDigestSchema } from "../../src/schemas/evidence";
import { SubmissionSchema } from "../../src/schemas/submission";
import { checklist, statusReasons } from "../../src/service";
import { loadSettings, signaturesOf } from "../../src/settings";
import { NO_SECOND_OPINION } from "../../src/stages/calibrate";
import { tempDir } from "../helpers";

const sub = (fields: Record<string, unknown> = {}) =>
  SubmissionSchema.parse({
    id: "s",
    hackathonId: "h",
    teamName: "Dune",
    repoUrl: "https://github.com/o/r",
    video: { kind: "video", origin: "url", uri: "https://youtu.be/abcdefghijk" },
    liveDemoUrl: "https://demo.example.app/",
    answers: {
      xPost: "https://x.com/a/status/1",
      hashtag: "Yes, I used #FlowStateHackathon",
      armortoolsPro: "Yes",
    },
    submittedAt: "2026-10-14T06:56:21Z",
    ...fields,
  });

const byId = (checks: ReturnType<typeof checklist>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("submission checklist", () => {
  it("is pending before the pipeline runs, except what the form already answers", () => {
    const c = byId(checklist(sub(), null));
    expect([c.sdk.state, c.video.state, c.live_demo.state]).toEqual(["pending", "pending", "pending"]);
    expect([c.social.state, c.pro.state]).toEqual(["pass", "pass"]);
    expect(c.elevenlabs).toBeUndefined();
  });

  it("checks everything once the gate and media steps ran", () => {
    const ev = EvaluationSchema.parse({
      submissionId: "s",
      status: "needs_review",
      gate: { status: "pass", reasons: ["ok"] },
      evidence: { partners: { elevenlabs: [] } },
      media: MediaDigestSchema.parse({
        video: {
          durationS: 0,
          hasSpeech: true,
          transcript: [],
          keyframes: [],
          remoteUri: "https://youtu.be/x",
        },
        liveDemo: {
          url: "https://demo.example.app/",
          reachable: true,
          status: 405,
          error: "server responded HTTP 405",
        },
      }),
    });
    const c = byId(checklist(sub({ track: "elevenlabs" }), ev));
    expect(c.sdk.state).toBe("pass");
    expect(c.video).toMatchObject({ state: "pass", detail: "Watched by the AI judge" });
    expect(c.live_demo.state).toBe("warn");
    expect(c.elevenlabs).toMatchObject({ state: "warn" });
    expect(c.elevenlabs.detail).toMatch(/no ElevenLabs SDK/);
  });

  it("fails missing links and flags an unconfirmed hashtag", () => {
    const c = byId(
      checklist(sub({ video: null, liveDemoUrl: null, answers: { linkedinPost: "https://l.in/p" } }), null),
    );
    expect([c.video.state, c.live_demo.state, c.social.state, c.pro.state]).toEqual([
      "fail",
      "fail",
      "warn",
      "warn",
    ]);
  });
});

describe("review reasons without a second opinion", () => {
  it("replaces the per-criterion Jev noise with one line and keeps real reasons", () => {
    const ev = EvaluationSchema.parse({
      submissionId: "s",
      status: "needs_review",
      calibration: CalibrationResultSchema.parse({
        autoScore: 60,
        confidence: 0,
        route: "review",
        reasons: [
          NO_SECOND_OPINION,
          "confidence 0.00 is below 0.85",
          "demo_video: no Jev second opinion",
          "flag evaluator_injection_attempt = 0.90",
        ],
      }),
    });
    expect(statusReasons("needs_review", ev)).toEqual([
      "Ready for a judge: confirm or adjust the AI scores.",
      "flag evaluator_injection_attempt = 0.90",
    ]);
  });
});

describe("partner SDK detection", () => {
  it("finds ElevenLabs by manifest or import, not by a README mention", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@elevenlabs/elevenlabs-js": "^2" } }),
    );
    writeFileSync(
      join(root, "src", "voice.ts"),
      'const x = 1;\nimport { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";\n',
    );
    writeFileSync(join(root, "README.md"), "We love ElevenLabs.\n");
    const ev = await scanRepo(root, signaturesOf(loadSettings({})));
    expect(ev.partners.elevenlabs).toEqual(["package.json", "src/voice.ts:2"]);

    const bare = tempDir();
    writeFileSync(join(bare, "README.md"), "Narrated with ElevenLabs.\n");
    expect((await scanRepo(bare, signaturesOf(loadSettings({})))).partners.elevenlabs).toEqual([]);
  });

  it("tells the form analyst what the repo check found", () => {
    const text = formSummary(
      sub(),
      MediaDigestSchema.parse({}),
      ArmorIQEvidenceSchema.parse({ partners: { elevenlabs: [] } }),
    );
    expect(text).toContain("- elevenlabs: not found in the repository");
  });
});
