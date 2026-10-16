import { describe, expect, it } from "vitest";
import {
  DECK_IS_REAL_PITCH,
  INJECTION,
  prescreenState,
  SAME_PROJECT,
  TRACK_FIT,
  VIDEO_SHOWS_PROJECT,
} from "../../src/jev/prescreenQuestions";
import { type MediaDigest, MediaDigestSchema } from "../../src/schemas/evidence";
import { SubmissionSchema } from "../../src/schemas/submission";
import { prescreen } from "../../src/stages/prescreen";
import { FakeJevClient } from "../fakes";
import { exampleRubric } from "../helpers";

const SUB = SubmissionSchema.parse({
  id: "s1",
  hackathonId: "h",
  teamName: "T",
  track: "security",
  repoUrl: "https://github.com/o/r",
  submittedAt: "2026-10-01T00:00:00Z",
});
const DECK = {
  sourceFormat: "pdf",
  slideCount: 2,
  slides: [
    { index: 1, text: "GuardRail: intent-verified agents", notes: "say hi", imagePath: "/x/slide-001.png" },
    { index: 2, text: "key ak_live_9f8e7d6c5b4a3210ffee in our config" },
  ],
};
const VIDEO = {
  durationS: 65,
  hasSpeech: true,
  transcript: [{ startS: 62, endS: 64, text: "Here GuardRail blocks a bad tool call." }],
  keyframes: [{ tS: 1, imagePath: "/x/frame-000.jpg" }],
};
const media = (over: Record<string, unknown>): MediaDigest => MediaDigestSchema.parse(over);
const rubric = exampleRubric();

describe("Jev prescreen", () => {
  it("asks only about the artifacts that exist", async () => {
    const jev = new FakeJevClient({ [DECK_IS_REAL_PITCH]: 0.9, [INJECTION]: 0.02 });
    const result = await prescreen(SUB, media({ deck: DECK }), jev, rubric);
    expect(Object.keys(jev.calls[0].questions).sort()).toEqual([DECK_IS_REAL_PITCH, INJECTION].sort());
    expect(result.flags).toEqual({ [DECK_IS_REAL_PITCH]: 0.9, [INJECTION]: 0.02 });
    expect(result.trackFit).toBeNull();
  });

  it("adds consistency and track questions", async () => {
    const jev = new FakeJevClient({}, { [TRACK_FIT]: "security" });
    const result = await prescreen(SUB, media({ deck: DECK, video: VIDEO }), jev, {
      ...rubric,
      tracks: ["agents", "security"],
    });
    const questions = jev.calls[0].questions;
    expect(Object.keys(questions).sort()).toEqual(
      [DECK_IS_REAL_PITCH, VIDEO_SHOWS_PROJECT, SAME_PROJECT, INJECTION, TRACK_FIT].sort(),
    );
    expect(questions[TRACK_FIT].type).toBe("choice");
    expect(result.trackFit).toBe("security");
    expect(result.jev).toHaveLength(5);
  });

  it("makes no call when nothing was submitted", async () => {
    const jev = new FakeJevClient();
    const result = await prescreen(SUB, media({}), jev, rubric);
    expect(jev.calls).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it("sends text only, redacted and trimmed", () => {
    const state = prescreenState(SUB, media({ deck: DECK, video: VIDEO }), 400);
    const blob = JSON.stringify(state);
    expect(blob).not.toContain("slide-001.png");
    expect(blob).not.toContain("frame-000.jpg");
    expect(blob).not.toContain("ak_live_9f8e7d6c5b4a3210ffee");
    expect(blob).toContain("ak_****ffee");
    expect(state.declaredTrack).toBe("security");
    expect(state.deckText).toContain("[slide 1] GuardRail");
    expect(state.deckText).toContain("Notes: say hi");
    expect(state.videoTranscript.startsWith("[01:02] Here GuardRail")).toBe(true);
    const long = prescreenState(
      SUB,
      media({ deck: { ...DECK, slides: Array(200).fill(DECK.slides[0]) } }),
      400,
    );
    expect(long.deckText.length).toBeLessThanOrEqual(400);
  });
});

describe("prescreen without a second opinion", () => {
  it("raises no flags and makes no Jev call", async () => {
    const result = await prescreen(SUB, media({ deck: DECK, video: VIDEO }), null, rubric);
    expect(result).toMatchObject({ flags: {}, trackFit: null, jev: [] });
  });
});
