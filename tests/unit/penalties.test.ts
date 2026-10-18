import { describe, expect, it } from "vitest";
import { applyPenalties, assessPenalties } from "../../src/penalties";
import { ArmorIQEvidenceSchema, MediaDigestSchema } from "../../src/schemas/evidence";
import { loadRubric } from "../../src/schemas/rubric";
import { SubmissionSchema } from "../../src/schemas/submission";

const rubric = loadRubric("config/rubrics/flow_state.yaml");
const sub = (fields: Record<string, unknown> = {}) =>
  SubmissionSchema.parse({
    id: "s",
    hackathonId: "h",
    teamName: "T",
    repoUrl: "https://github.com/o/r",
    track: "main",
    liveDemoUrl: "https://demo.example.app/",
    answers: { xPost: "https://x.com/t/status/1", hashtag: "Yes, I used #FlowStateHackathon in my post" },
    submittedAt: "2026-10-14T06:56:21Z",
    ...fields,
  });
const video = (durationS: number) =>
  MediaDigestSchema.parse({ video: { durationS, hasSpeech: true, transcript: [], keyframes: [] } });
const ids = (p: { id: string }[]) => p.map((x) => x.id);

describe("deductions for missing requirements", () => {
  it("cuts nothing when every requirement is met", () => {
    expect(assessPenalties(rubric, sub(), video(240), null)).toEqual([]);
  });

  it("cuts 5 for no social post (and not again for the hashtag)", () => {
    const p = assessPenalties(rubric, sub({ answers: {} }), video(240), null);
    expect(p).toEqual([
      expect.objectContaining({ id: "social_post", points: 5, label: "No X or LinkedIn post" }),
    ]);
  });

  it("cuts 2 for a post without the hashtag confirmed", () => {
    expect(
      ids(assessPenalties(rubric, sub({ answers: { linkedinPost: "https://l.in/p" } }), null, null)),
    ).toEqual(["hashtag"]);
  });

  it("cuts 3 for a video well outside 3 to 5 minutes, with grace, and never on an unknown length", () => {
    expect(ids(assessPenalties(rubric, sub(), video(398), null))).toEqual(["video_length"]);
    expect(assessPenalties(rubric, sub(), video(398), null)[0].detail).toBe(
      "the video is 6:38 long (over 5 minutes)",
    );
    expect(ids(assessPenalties(rubric, sub(), video(120), null))).toEqual(["video_length"]);
    expect(assessPenalties(rubric, sub(), video(310), null)).toEqual([]); // within grace
    expect(assessPenalties(rubric, sub(), video(0), null)).toEqual([]); // unknown
  });

  it("cuts 10 on the ElevenLabs track when ElevenLabs is not in the code, but not before the repo was scanned", () => {
    const eleven = sub({ track: "elevenlabs" });
    expect(
      ids(
        assessPenalties(rubric, eleven, null, ArmorIQEvidenceSchema.parse({ partners: { elevenlabs: [] } })),
      ),
    ).toEqual(["elevenlabs_code"]);
    expect(
      assessPenalties(
        rubric,
        eleven,
        null,
        ArmorIQEvidenceSchema.parse({ partners: { elevenlabs: ["src/voice.ts:3"] } }),
      ),
    ).toEqual([]);
    expect(assessPenalties(rubric, eleven, null, ArmorIQEvidenceSchema.parse({}))).toEqual([]);
    expect(
      assessPenalties(rubric, sub(), null, ArmorIQEvidenceSchema.parse({ partners: { elevenlabs: [] } })),
    ).toEqual([]);
  });

  it("subtracts from the rubric score and never goes below zero", () => {
    expect(applyPenalties(73.61, [{ points: 5 }, { points: 3 }])).toBe(65.61);
    expect(applyPenalties(4, [{ points: 10 }])).toBe(0);
  });
});
