/** Video helpers built on ffprobe/ffmpeg: duration, keyframes across the whole video, transcription-sized audio. */
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Keyframe } from "../schemas/evidence";
import { run } from "../util/exec";

/** Duration in seconds and whether there is an audio stream. Throws for unreadable files. */
export async function probe(
  path: string,
  ffprobe = "ffprobe",
): Promise<{ durationS: number; hasAudio: boolean }> {
  const result = await run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    path,
  ]);
  if (result.code !== 0) {
    const last =
      result.stderr.trim().split("\n").at(-1) ||
      (result.missing ? "ffprobe is not installed" : "ffprobe failed");
    throw new Error(`could not read video: ${last.slice(0, 200)}`);
  }
  const data = JSON.parse(result.stdout || "{}") as {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  const durationS = Number(data.format?.duration ?? 0);
  if (!(durationS > 0)) throw new Error("could not read video: no duration");
  return { durationS, hasAudio: (data.streams ?? []).some((s) => s.codec_type === "audio") };
}

/** Frames at evenly spaced midpoints across the whole video (at most one per second). */
export async function extractKeyframes(
  path: string,
  outDir: string,
  durationS: number,
  maxFrames = 24,
  ffmpeg = "ffmpeg",
): Promise<Keyframe[]> {
  await mkdir(outDir, { recursive: true });
  const n = Math.max(1, Math.min(maxFrames, Math.floor(durationS)));
  const frames: Keyframe[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) * durationS) / n;
    const out = join(outDir, `frame-${String(i).padStart(3, "0")}.jpg`);
    await run(ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      "-q:v",
      "3",
      out,
    ]);
    if (existsSync(out) && statSync(out).size > 0)
      frames.push({ tS: Math.round(t * 100) / 100, imagePath: out });
  }
  return frames;
}

/** Mono 16 kHz 64 kbps MP3 chunks (10 min is about 4.8 MB, under the 25 MB transcription upload limit). */
export async function extractAudioChunks(
  path: string,
  outDir: string,
  durationS: number,
  chunkS = 600,
  ffmpeg = "ffmpeg",
): Promise<[number, string][]> {
  await mkdir(outDir, { recursive: true });
  const chunks: [number, string][] = [];
  for (let i = 0; i < Math.ceil(durationS / chunkS); i++) {
    const start = i * chunkS;
    const out = join(outDir, `audio-${String(i).padStart(3, "0")}.mp3`);
    await run(ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(start),
      "-t",
      String(chunkS),
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      out,
    ]);
    if (existsSync(out) && statSync(out).size > 0) chunks.push([start, out]);
  }
  return chunks;
}
