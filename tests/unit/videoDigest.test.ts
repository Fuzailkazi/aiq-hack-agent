import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractAudioChunks, extractKeyframes, probe } from "../../src/digest/video";
import { tempDir } from "../helpers";
import { hasFfmpeg, makeVideo } from "../videoFixtures";

let video: string;
beforeAll(() => {
  if (hasFfmpeg()) video = makeVideo(join(tempDir(), "demo.mp4"));
});

describe.skipIf(!hasFfmpeg())("video digest", () => {
  it("probes duration and audio", async () => {
    const { durationS, hasAudio } = await probe(video);
    expect(durationS).toBeGreaterThan(11.5);
    expect(durationS).toBeLessThan(12.5);
    expect(hasAudio).toBe(true);
    expect((await probe(makeVideo(join(tempDir(), "silent.mp4"), 3, false))).hasAudio).toBe(false);
  });

  it("rejects a non-video", async () => {
    const bad = join(tempDir(), "bad.mp4");
    writeFileSync(bad, "nope");
    await expect(probe(bad)).rejects.toThrow(/could not read video/);
  });

  it("takes keyframes across the whole video", async () => {
    const frames = await extractKeyframes(video, tempDir(), 12, 4);
    expect(frames.map((f) => f.tS)).toEqual([1.5, 4.5, 7.5, 10.5]);
    expect(frames.every((f) => existsSync(f.imagePath))).toBe(true);
  });

  it("takes at most one keyframe per second", async () => {
    expect(await extractKeyframes(video, tempDir(), 12, 24)).toHaveLength(12);
  });

  it("cuts mono 16 kHz audio chunks covering the video", async () => {
    const chunks = await extractAudioChunks(video, tempDir(), 12, 5);
    expect(chunks.map(([offset]) => offset)).toEqual([0, 5, 10]);
    const info = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=channels,sample_rate",
        "-of",
        "json",
        chunks[0][1],
      ]).toString(),
    );
    expect([info.streams[0].channels, info.streams[0].sample_rate]).toEqual([1, "16000"]);
    expect(chunks.every(([, path]) => path.endsWith(".mp3") && statSync(path).size > 0)).toBe(true);
  });
});
