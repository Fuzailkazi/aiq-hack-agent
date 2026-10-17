/**
 * Fetch and digest a submission's deck and video; digests are cached by content hash.
 *
 * An absent artifact is not an error (analysts mark its criteria absent). An artifact that cannot be fetched or
 * read is reported in `MediaDigest.unreachable` so an organizer can fix the link or attach the file.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkLiveDemo } from "../acquire/liveDemo";
import { type FetchOptions, fetchArtifact, type VideoDownloader } from "../acquire/media";
import {
  type DeckDigest,
  DeckDigestSchema,
  type LiveDemoCheck,
  type MediaDigest,
  type VideoDigest,
  VideoDigestSchema,
} from "../schemas/evidence";
import type { Submission } from "../schemas/submission";
import { Limiter } from "../util/limiter";
import { redactDeep } from "./armoriq/secrets";
import { digestDeck } from "./deck";
import { type Transcriber, transcribeChunks } from "./transcribe";
import { extractAudioChunks, extractKeyframes, probe } from "./video";

export interface MediaLimits {
  deckMaxBytes: number;
  videoMaxBytes: number;
  maxSlideImages: number;
  maxKeyframes: number;
  audioChunkS: number;
  downloadTimeoutS: number;
  soffice: string;
  pdftoppm: string;
  pdftotext: string;
  /** Only the first maxVideoS seconds are analyzed (container durations can be forged). */
  maxVideoS: number;
}

export const DEFAULT_LIMITS: MediaLimits = {
  deckMaxBytes: 100_000_000,
  videoMaxBytes: 1_500_000_000,
  maxSlideImages: 40,
  maxKeyframes: 24,
  audioChunkS: 600,
  downloadTimeoutS: 300,
  soffice: "soffice",
  pdftoppm: "pdftoppm",
  pdftotext: "pdftotext",
  maxVideoS: 1800,
};

export interface IngestOptions {
  workspace: string;
  transcriber: Transcriber;
  limits?: MediaLimits;
  /** Caps concurrent ffmpeg / LibreOffice / pdftoppm work across submissions. */
  cpu?: Limiter;
  fetchImpl?: typeof fetch;
  videoDownloader?: VideoDownloader;
  /** Hand public YouTube links to the model as-is (Gemini watches them) instead of downloading them. */
  remoteYoutube?: boolean;
  /** Live demo checker (tests inject a fake). */
  liveDemoCheck?: (url: string) => Promise<LiveDemoCheck>;
}

const YOUTUBE =
  /^https?:\/\/(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)/i;

/** A canonical https://www.youtube.com/watch?v=<id> link, or null when `url` is not a YouTube video link. */
export function youtubeWatchUrl(url: string): string | null {
  if (!YOUTUBE.test(url.trim())) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.split("/").filter(Boolean);
  const id =
    host === "youtu.be"
      ? path[0]
      : (parsed.searchParams.get("v") ??
        (["shorts", "live", "embed"].includes(path[0]) ? path[1] : undefined));
  return id && /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** Digest parameters that change the output; part of the cache key ("r1": text is secret-redacted). */
function cacheTag(kind: "deck" | "video", limits: MediaLimits): string {
  const params =
    kind === "deck"
      ? { format: "r1", maxSlideImages: limits.maxSlideImages }
      : {
          format: "r1",
          maxKeyframes: limits.maxKeyframes,
          audioChunkS: limits.audioChunkS,
          maxVideoS: limits.maxVideoS,
        };
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 8);
}

/**
 * Content-hash cache for digests. Each attempt renders into its own folder and only the JSON is published
 * (atomically), so concurrent digests of the same file never share or delete each other's images. A corrupt or
 * outdated entry is a miss; results that `keep` rejects (e.g. a transient render failure) are not cached.
 */
async function cached<T>(
  cacheDir: string,
  key: string,
  parse: (raw: unknown) => T,
  compute: (outDir: string) => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const path = join(cacheDir, `${key}.json`);
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // missing, torn or from an older schema: recompute
  }
  const outDir = join(cacheDir, `${key}.${randomUUID().slice(0, 8)}`);
  let result: T;
  try {
    result = await compute(outDir);
  } catch (e) {
    await rm(outDir, { recursive: true, force: true });
    throw e;
  }
  if (keep(result)) {
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(result));
    await rename(tmp, path);
  }
  return result;
}

export async function ingestMedia(sub: Submission, opts: IngestOptions): Promise<MediaDigest> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const cpu = opts.cpu ?? new Limiter(1);
  const downloads = join(opts.workspace, "media", sub.id);
  const cacheDir = join(opts.workspace, "cache", "media");
  const unreachable: Record<string, string> = {};
  const fetchOpts = (maxBytes: number): FetchOptions => ({
    maxBytes,
    timeoutS: limits.downloadTimeoutS,
    fetchImpl: opts.fetchImpl,
    videoDownloader: opts.videoDownloader,
  });

  let deck: DeckDigest | null = null;
  if (sub.deck) {
    const fetched = await fetchArtifact(sub.deck, downloads, fetchOpts(limits.deckMaxBytes));
    if (!fetched.path || !fetched.sha256)
      unreachable.deck = fetched.unreachableReason ?? "deck could not be fetched";
    else {
      const key = `${fetched.sha256}.deck.${cacheTag("deck", limits)}`;
      const path = fetched.path;
      try {
        deck = await cached(
          cacheDir,
          key,
          (raw) => DeckDigestSchema.parse(raw),
          async (outDir) =>
            redactDeep(
              await cpu.run(() =>
                digestDeck(path, outDir, {
                  maxImages: limits.maxSlideImages,
                  soffice: limits.soffice,
                  pdftoppm: limits.pdftoppm,
                  pdftotext: limits.pdftotext,
                }),
              ),
            ),
          (digest) => !digest.renderError, // e.g. LibreOffice missing or busy: try again next time
        );
      } catch (e) {
        unreachable.deck = `deck could not be read: ${(e instanceof Error ? e.message : String(e)).replace(/^could not read deck: /, "")}`;
      }
    }
  }

  let video: VideoDigest | null = null;
  const remote = sub.video?.origin === "url" && opts.remoteYoutube ? youtubeWatchUrl(sub.video.uri) : null;
  if (remote) {
    video = {
      durationS: 0,
      hasSpeech: true,
      transcript: [],
      keyframes: [],
      analyzedUntilS: null,
      remoteUri: remote,
    };
  } else if (sub.video) {
    const fetched = await fetchArtifact(sub.video, downloads, fetchOpts(limits.videoMaxBytes));
    if (!fetched.path || !fetched.sha256)
      unreachable.video = fetched.unreachableReason ?? "video could not be fetched";
    else {
      const key = `${fetched.sha256}.video.${cacheTag("video", limits)}`;
      const path = fetched.path;
      try {
        video = await cached(
          cacheDir,
          key,
          (raw) => VideoDigestSchema.parse(raw),
          async (outDir) => redactDeep(await digestVideo(path, outDir, opts.transcriber, limits, cpu)),
        );
      } catch (e) {
        unreachable.video = `video could not be read: ${(e instanceof Error ? e.message : String(e)).replace(/^could not read video: /, "")}`;
      }
    }
  }
  const liveDemo = sub.liveDemoUrl
    ? redactDeep(await (opts.liveDemoCheck ?? ((url: string) => checkLiveDemo(url)))(sub.liveDemoUrl))
    : null;
  return { deck, video, liveDemo, unreachable };
}

async function digestVideo(
  path: string,
  outDir: string,
  transcriber: Transcriber,
  limits: MediaLimits,
  cpu: Limiter,
): Promise<VideoDigest> {
  // ffmpeg work holds a CPU slot; transcription (network) runs outside it.
  const { durationS, hasAudio, keyframes, chunks } = await cpu.run(async () => {
    const { durationS, hasAudio } = await probe(path);
    const span = Math.min(durationS, limits.maxVideoS);
    const keyframes = await extractKeyframes(path, join(outDir, "frames"), span, limits.maxKeyframes);
    const chunks = hasAudio
      ? await extractAudioChunks(path, join(outDir, "audio"), span, limits.audioChunkS)
      : [];
    return { durationS, hasAudio, keyframes, chunks };
  });
  const transcript = hasAudio ? await transcribeChunks(transcriber, chunks) : [];
  return {
    durationS: Math.round(durationS * 100) / 100,
    hasSpeech: transcript.length > 0,
    transcript,
    keyframes,
    analyzedUntilS: durationS > limits.maxVideoS ? limits.maxVideoS : null,
    remoteUri: null,
  };
}
