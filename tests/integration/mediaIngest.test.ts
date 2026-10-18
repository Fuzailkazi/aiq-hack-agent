import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, ingestMedia } from "../../src/digest/media";
import type { TranscriptSegment } from "../../src/schemas/evidence";
import { type Submission, SubmissionSchema } from "../../src/schemas/submission";
import { FAKE_KEY } from "../gateRepos";
import { tempDir } from "../helpers";
import { hasFfmpeg, makeVideo } from "../videoFixtures";

const LIMITS = { ...DEFAULT_LIMITS, maxSlideImages: 2, maxKeyframes: 4, audioChunkS: 5 };

class CountingTranscriber {
  calls: string[] = [];
  async transcribe(path: string): Promise<TranscriptSegment[]> {
    this.calls.push(path);
    return [{ startS: 0.5, endS: 2, text: `words ${this.calls.length}` }];
  }
}

const sub = (id: string, deck: string | null, video: string | null): Submission =>
  SubmissionSchema.parse({
    id,
    hackathonId: "h",
    teamName: "T",
    repoUrl: "https://github.com/o/r",
    deck: deck ? { kind: "deck", origin: "upload", uri: deck } : null,
    video: video ? { kind: "video", origin: "upload", uri: video } : null,
    submittedAt: "2026-10-01T00:00:00Z",
  });

let video: string;
let silent: string;
beforeAll(() => {
  if (!hasFfmpeg()) return;
  const dir = tempDir();
  video = makeVideo(join(dir, "demo.mp4"), 12);
  silent = makeVideo(join(dir, "silent.mp4"), 3, false);
});

describe.skipIf(!hasFfmpeg())("ingestMedia", () => {
  it("digests deck and video, then serves both from cache", async () => {
    const workspace = tempDir();
    const transcriber = new CountingTranscriber();
    const media = await ingestMedia(sub("s1", "tests/fixtures/decks/deck3.pptx", video), {
      workspace,
      transcriber,
      limits: LIMITS,
    });
    expect(media.unreachable).toEqual({});
    expect(media.deck?.slideCount).toBe(3);
    expect(media.video?.durationS).toBeGreaterThan(11.5);
    expect(media.video?.keyframes).toHaveLength(4);
    expect(media.video?.hasSpeech).toBe(true);
    expect(media.video?.transcript.map((s) => s.startS)).toEqual([0.5, 5.5, 10.5]);
    expect(transcriber.calls).toHaveLength(3);

    const again = await ingestMedia(sub("s2", "tests/fixtures/decks/deck3.pptx", video), {
      workspace,
      transcriber,
      limits: LIMITS,
    });
    expect(transcriber.calls).toHaveLength(3); // same content hash -> no new transcription
    expect(again).toEqual(media);
  });

  it("redacts secrets from slide text and transcripts before caching or returning them", async () => {
    const workspace = tempDir();
    const zip = await JSZip.loadAsync(readFileSync("tests/fixtures/decks/deck3.pptx"));
    const slide = "ppt/slides/slide1.xml";
    const xml = (await zip.file(slide)?.async("string")) ?? "";
    zip.file(slide, xml.replace(/<a:t>[^<]*<\/a:t>/, `<a:t>our key ${FAKE_KEY}</a:t>`));
    const deck = join(tempDir(), "leaky.pptx");
    writeFileSync(deck, await zip.generateAsync({ type: "nodebuffer" }));
    const transcriber = { transcribe: async () => [{ startS: 0, endS: 2, text: `paste ${FAKE_KEY} here` }] };
    const media = await ingestMedia(sub("s9", deck, video), { workspace, transcriber, limits: LIMITS });
    const everything =
      JSON.stringify(media) +
      readdirSync(join(workspace, "cache", "media"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => readFileSync(join(workspace, "cache", "media", f), "utf8"))
        .join("");
    expect(everything).not.toContain(FAKE_KEY);
    expect(media.deck?.slides[0].text).toContain("our key ak_");
  });

  it("only analyzes the first maxVideoS seconds of a (possibly forged) long video", async () => {
    const transcriber = new CountingTranscriber();
    const media = await ingestMedia(sub("s10", null, video), {
      workspace: tempDir(),
      transcriber,
      limits: { ...LIMITS, maxVideoS: 4 },
    });
    expect(media.video?.analyzedUntilS).toBe(4);
    expect(media.video?.keyframes.every((k) => k.tS < 4)).toBe(true);
    expect(transcriber.calls).toHaveLength(1); // one 5 s chunk covers the first 4 s
  });

  it("a corrupt cache entry is recomputed, not trusted", async () => {
    const workspace = tempDir();
    const transcriber = new CountingTranscriber();
    const opts = { workspace, transcriber, limits: LIMITS };
    await ingestMedia(sub("c1", null, video), opts);
    const dir = join(workspace, "cache", "media");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")))
      writeFileSync(join(dir, f), '{"torn":');
    const again = await ingestMedia(sub("c2", null, video), opts);
    expect(again.unreachable).toEqual({});
    expect(again.video?.transcript.length).toBeGreaterThan(0);
  });

  it("does not cache a deck whose slide images failed to render (retried once tools work)", async () => {
    const workspace = tempDir();
    const transcriber = new CountingTranscriber();
    const broken = { ...LIMITS, soffice: "/nonexistent/soffice" };
    const first = await ingestMedia(sub("r1", "tests/fixtures/decks/deck3.pptx", null), {
      workspace,
      transcriber,
      limits: broken,
    });
    expect(first.deck?.renderError).toContain("not available");
    const cachedDecks = readdirSync(join(workspace, "cache", "media")).filter(
      (f) => f.includes(".deck.") && f.endsWith(".json"),
    );
    expect(cachedDecks).toEqual([]);
  });

  it("concurrent digests of the same file both succeed with intact images", async () => {
    const workspace = tempDir();
    const transcriber = new CountingTranscriber();
    const opts = { workspace, transcriber, limits: LIMITS };
    const [a, b] = await Promise.all([
      ingestMedia(sub("p1", "tests/fixtures/decks/deck3.pdf", video), opts),
      ingestMedia(sub("p2", "tests/fixtures/decks/deck3.pdf", video), opts),
    ]);
    for (const m of [a, b]) {
      expect(m.unreachable).toEqual({});
      for (const s of m.deck?.slides ?? []) if (s.imagePath) expect(existsSync(s.imagePath)).toBe(true);
      for (const k of m.video?.keyframes ?? []) expect(existsSync(k.imagePath)).toBe(true);
    }
  });

  it("a model outage while transcribing fails the run instead of blaming the team's video", async () => {
    const quota = {
      transcribe: async (): Promise<TranscriptSegment[]> => {
        throw new Error('{"error":{"code":429,"message":"You exceeded your current quota"}}');
      },
    };
    await expect(
      ingestMedia(sub("s-quota", null, video), { workspace: tempDir(), transcriber: quota, limits: LIMITS }),
    ).rejects.toThrow(/429/);
  });

  it("treats absent artifacts as fine", async () => {
    const media = await ingestMedia(sub("s1", null, null), {
      workspace: tempDir(),
      transcriber: new CountingTranscriber(),
    });
    expect(media).toEqual({ deck: null, video: null, liveDemo: null, unreachable: {} });
  });

  it("reports missing uploads and unreadable decks", async () => {
    const dir = tempDir();
    const badDeck = join(dir, "bad.pdf");
    writeFileSync(badDeck, "%PDF-1.7 truncated garbage");
    const media = await ingestMedia(sub("s1", badDeck, join(dir, "gone.mp4")), {
      workspace: dir,
      transcriber: new CountingTranscriber(),
    });
    expect(media.unreachable.video).toBe("uploaded file not found: gone.mp4");
    expect(media.unreachable.deck?.startsWith("deck could not be read:")).toBe(true);
  });

  it("skips transcription for a silent video", async () => {
    const transcriber = new CountingTranscriber();
    const media = await ingestMedia(sub("s1", null, silent), { workspace: tempDir(), transcriber });
    expect(media.video?.hasSpeech).toBe(false);
    expect(media.video?.transcript).toEqual([]);
    expect(transcriber.calls).toEqual([]);
  });
});
