/** Fetch a submission's deck or video (URL or upload) into the workspace, safely and with size caps. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import JSZip from "jszip";
import type { ArtifactRef } from "../schemas/submission";

export type VideoDownloader = (url: string, destDir: string, maxBytes: number) => Promise<string>;

export interface FetchedArtifact {
  path: string | null;
  sha256: string | null;
  detected: string | null;
  unreachableReason: string | null;
}

export interface FetchOptions {
  maxBytes: number;
  timeoutS?: number;
  fetchImpl?: typeof fetch;
  videoDownloader?: VideoDownloader;
}

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "loom.com", "vimeo.com"];
const PAGE_HOSTS: Record<string, string> = {
  "canva.com": "Canva",
  "pitch.com": "Pitch",
  "gamma.app": "Gamma",
  "icloud.com": "Keynote (iCloud)",
  "figma.com": "Figma",
};
const DECK_TYPES = new Set(["pdf", "pptx"]);
const VIDEO_TYPES = new Set(["mp4", "webm"]);
export const HTML_REASON = "link returned an HTML page (login or preview) instead of a file";

const unreachable = (reason: string): FetchedArtifact => ({
  path: null,
  sha256: null,
  detected: null,
  unreachableReason: reason,
});

/** Turn common share links into direct-download links. */
export function rewriteUrl(url: string): string {
  const slides = /^https:\/\/docs\.google\.com\/presentation\/d\/([\w-]+)/.exec(url);
  if (slides) return `https://docs.google.com/presentation/d/${slides[1]}/export/pdf`;
  const drive = /^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/.exec(url);
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  if (url.includes("dropbox.com") && url.includes("dl=0")) return url.replace("dl=0", "dl=1");
  return url;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const matches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export function pageHostReason(url: string): string | null {
  const host = hostOf(url);
  for (const [domain, name] of Object.entries(PAGE_HOSTS)) {
    if (matches(host, domain))
      return `link is a ${name} page, not a file; export the deck to PDF and attach it`;
  }
  return null;
}

export function sniff(head: Buffer): string | null {
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  const text = head
    .toString("utf8")
    .replace(/^[﻿\s]+/, "")
    .toLowerCase();
  if (["<!doctype html", "<html", "<head", "<body"].some((p) => text.startsWith(p))) return "html";
  return null;
}

/** Download a hosted video with the yt-dlp binary (single-file format, so no ffmpeg merge step). */
export const ytdlpDownload: VideoDownloader = (url, destDir, maxBytes) =>
  new Promise((resolve, reject) => {
    const args = ["-f", "best[ext=mp4]/best", "--max-filesize", String(maxBytes), "--no-playlist", "--quiet"];
    args.push("-o", join(destDir, "download.%(ext)s"), "--print", "after_move:filepath", "--", url);
    execFile("yt-dlp", args, { timeout: 15 * 60_000 }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new Error(
            missing
              ? "yt-dlp is not installed; attach the video file instead"
              : stderr.trim() || error.message,
          ),
        );
      } else resolve(stdout.trim().split("\n").at(-1) as string);
    });
  });

export async function fetchArtifact(
  ref: ArtifactRef,
  destDir: string,
  opts: FetchOptions,
): Promise<FetchedArtifact> {
  await mkdir(destDir, { recursive: true });
  if (ref.origin === "upload") {
    if (!existsSync(ref.uri) || !statSync(ref.uri).isFile())
      return unreachable(`uploaded file not found: ${basename(ref.uri)}`);
    if (statSync(ref.uri).size > opts.maxBytes)
      return unreachable(
        `uploaded file is larger than the ${Math.floor(opts.maxBytes / 1_000_000)} MB limit`,
      );
    const raw = join(destDir, `${ref.kind}.download`);
    await copyFile(ref.uri, raw);
    return finish(ref, raw, destDir);
  }

  const pageReason = pageHostReason(ref.uri);
  if (pageReason) return unreachable(pageReason);

  if (ref.kind === "video" && VIDEO_HOSTS.some((h) => matches(hostOf(ref.uri), h))) {
    let raw: string;
    try {
      raw = await (opts.videoDownloader ?? ytdlpDownload)(ref.uri, destDir, opts.maxBytes);
    } catch (e) {
      const first = (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] || "unknown error";
      return unreachable(`video download failed: ${first.slice(0, 300)}`);
    }
    return finish(ref, raw, destDir);
  }

  const raw = join(destDir, `${ref.kind}.download`);
  const reason = await httpDownload(rewriteUrl(ref.uri), raw, opts);
  if (reason) {
    await rm(raw, { force: true });
    return unreachable(reason);
  }
  return finish(ref, raw, destDir);
}

async function httpDownload(url: string, dest: string, opts: FetchOptions): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout((opts.timeoutS ?? 120) * 1000),
    });
  } catch (e) {
    return `download failed: ${e instanceof Error ? e.name : "network error"}`;
  }
  if (!response.ok) return `download failed with HTTP ${response.status}`;
  if (!response.body) return "download failed: empty response";
  const out = createWriteStream(dest);
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > opts.maxBytes) return `file exceeds the ${Math.floor(opts.maxBytes / 1_000_000)} MB limit`;
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  return null;
}

async function finish(ref: ArtifactRef, raw: string, destDir: string): Promise<FetchedArtifact> {
  const handle = await open(raw, "r");
  const head = Buffer.alloc(64);
  const { bytesRead } = await handle.read(head, 0, 64, 0);
  await handle.close();
  let detected = sniff(head.subarray(0, bytesRead));
  if (detected === "zip") detected = (await isPptx(raw)) ? "pptx" : "zip archive";
  const mismatch = typeMismatch(ref.kind, detected);
  if (mismatch) {
    await rm(raw, { force: true });
    return unreachable(mismatch);
  }
  const final = join(destDir, `${ref.kind}.${detected}`);
  await rename(raw, final);
  // Remove leftovers from a video downloader (temp fragments etc.).
  for (const name of await readdir(destDir))
    if (name.startsWith("download.")) await rm(join(destDir, name), { force: true });
  return { path: final, sha256: await sha256(final), detected, unreachableReason: null };
}

async function isPptx(path: string): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(await readFile(path));
    return zip.file("ppt/presentation.xml") !== null;
  } catch {
    return false;
  }
}

function typeMismatch(kind: string, detected: string | null): string | null {
  if (detected === "html") return HTML_REASON;
  const allowed = kind === "deck" ? DECK_TYPES : VIDEO_TYPES;
  if (detected && allowed.has(detected)) return null;
  const expected = kind === "deck" ? "a deck (PDF or PPTX)" : "a video (MP4, MOV or WebM)";
  const got =
    detected && VIDEO_TYPES.has(detected)
      ? `a video (${detected})`
      : detected && DECK_TYPES.has(detected)
        ? `a ${detected.toUpperCase()} document`
        : detected === "zip archive"
          ? "a zip archive"
          : "of an unrecognized type";
  return `expected ${expected} but the file is ${got}`;
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
