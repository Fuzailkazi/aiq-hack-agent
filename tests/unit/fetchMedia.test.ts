import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { fetchArtifact, pageHostReason, rewriteUrl, sniff } from "../../src/acquire/media";
import type { ArtifactRef } from "../../src/schemas/submission";
import { tempDir } from "../helpers";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, "x")]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(200)]);
const HTML = Buffer.from("﻿  <!DOCTYPE html><html><body>Sign in to continue</body></html>");

async function zipBytes(withPpt = true): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  if (withPpt) zip.file("ppt/presentation.xml", "<p/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

const fakeFetch = (routes: Record<string, Buffer>, calls: string[] = []) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    return body ? new Response(body, { status: 200 }) : new Response("nope", { status: 404 });
  }) as typeof fetch;

const urlRef = (kind: "deck" | "video", uri: string): ArtifactRef => ({
  kind,
  origin: "url",
  uri,
  sha256: null,
  unreachableReason: null,
});

describe("share links and hosts", () => {
  it.each([
    [
      "https://docs.google.com/presentation/d/AbC123/edit#slide=id.p",
      "https://docs.google.com/presentation/d/AbC123/export/pdf",
    ],
    [
      "https://drive.google.com/file/d/XyZ_9/view?usp=sharing",
      "https://drive.google.com/uc?export=download&id=XyZ_9",
    ],
    ["https://www.dropbox.com/s/abc/deck.pdf?dl=0", "https://www.dropbox.com/s/abc/deck.pdf?dl=1"],
    ["https://example.com/deck.pdf", "https://example.com/deck.pdf"],
  ])("rewrites %s", (url, expected) => {
    expect(rewriteUrl(url)).toBe(expected);
  });

  it.each([
    "https://www.canva.com/design/DAF/view",
    "https://pitch.com/v/our-deck",
    "https://gamma.app/docs/x",
    "https://www.icloud.com/keynote/0abc",
    "https://www.figma.com/deck/abc",
  ])("rejects page host %s with guidance", (url) => {
    expect(pageHostReason(url)).toMatch(/export.*attach/);
  });

  it("does not reject file hosts", () => {
    expect(pageHostReason("https://example.com/deck.pdf")).toBeNull();
  });
});

describe("sniff", () => {
  it.each([
    ["pdf", PDF],
    ["mp4", MP4],
    ["webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2])],
    ["html", HTML],
    [null, Buffer.from("???")],
  ])("detects %s", (expected, bytes) => {
    expect(sniff(bytes.subarray(0, 64))).toBe(expected);
  });

  it("detects zip", async () => {
    expect(sniff((await zipBytes()).subarray(0, 64))).toBe("zip");
  });
});

describe("fetchArtifact", () => {
  it("downloads a PDF and hashes it", async () => {
    const dir = tempDir();
    const got = await fetchArtifact(urlRef("deck", "https://x.test/deck.pdf"), dir, {
      maxBytes: 10_000,
      fetchImpl: fakeFetch({ "https://x.test/deck.pdf": PDF }),
    });
    expect(got.unreachableReason).toBeNull();
    expect(got.detected).toBe("pdf");
    expect(readFileSync(got.path as string)).toEqual(PDF);
    expect(got.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
  });

  it("treats a login page as unreachable", async () => {
    const got = await fetchArtifact(urlRef("deck", "https://x.test/deck"), tempDir(), {
      maxBytes: 10_000,
      fetchImpl: fakeFetch({ "https://x.test/deck": HTML }),
    });
    expect(got.path).toBeNull();
    expect(got.unreachableReason).toBe("link returned an HTML page (login or preview) instead of a file");
  });

  it("reports HTTP errors", async () => {
    const got = await fetchArtifact(urlRef("deck", "https://x.test/missing.pdf"), tempDir(), {
      maxBytes: 10_000,
      fetchImpl: fakeFetch({}),
    });
    expect(got.unreachableReason).toBe("download failed with HTTP 404");
  });

  it("enforces the size cap and leaves nothing behind", async () => {
    const dir = tempDir();
    const got = await fetchArtifact(urlRef("deck", "https://x.test/big.pdf"), dir, {
      maxBytes: 1_000,
      fetchImpl: fakeFetch({ "https://x.test/big.pdf": Buffer.concat(Array(100).fill(PDF)) }),
    });
    expect(got.unreachableReason).toMatch(/exceeds/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("detects PPTX and rejects other zips", async () => {
    const dir = tempDir();
    const fetchImpl = fakeFetch({
      "https://x.test/deck.pptx": await zipBytes(),
      "https://x.test/other.zip": await zipBytes(false),
    });
    const ok = await fetchArtifact(urlRef("deck", "https://x.test/deck.pptx"), join(dir, "a"), {
      maxBytes: 10_000,
      fetchImpl,
    });
    expect(ok.detected).toBe("pptx");
    expect(ok.path?.endsWith("deck.pptx")).toBe(true);
    const bad = await fetchArtifact(urlRef("deck", "https://x.test/other.zip"), join(dir, "b"), {
      maxBytes: 10_000,
      fetchImpl,
    });
    expect(bad.unreachableReason).toBe("expected a deck (PDF or PPTX) but the file is a zip archive");
  });

  it("rejects a file of the wrong kind", async () => {
    const got = await fetchArtifact(urlRef("deck", "https://x.test/deck"), tempDir(), {
      maxBytes: 10_000,
      fetchImpl: fakeFetch({ "https://x.test/deck": MP4 }),
    });
    expect(got.unreachableReason).toBe("expected a deck (PDF or PPTX) but the file is a video (mp4)");
  });

  it("copies uploads and reports missing uploads", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in/pitch.pdf"), PDF);
    const got = await fetchArtifact(
      {
        kind: "deck",
        origin: "upload",
        uri: join(dir, "in/pitch.pdf"),
        sha256: null,
        unreachableReason: null,
      },
      join(dir, "out"),
      {
        maxBytes: 10_000,
      },
    );
    expect(got.detected).toBe("pdf");
    expect(readFileSync(got.path as string)).toEqual(PDF);
    const missing = await fetchArtifact(
      { kind: "video", origin: "upload", uri: join(dir, "nope.mp4"), sha256: null, unreachableReason: null },
      join(dir, "out2"),
      {
        maxBytes: 10_000,
      },
    );
    expect(missing.unreachableReason).toBe("uploaded file not found: nope.mp4");
  });

  it("applies the size cap to uploaded files too", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "big.pdf"), Buffer.concat([PDF, Buffer.alloc(20_000)]));
    const got = await fetchArtifact(
      { kind: "deck", origin: "upload", uri: join(dir, "big.pdf"), sha256: null, unreachableReason: null },
      join(dir, "out"),
      { maxBytes: 10_000 },
    );
    expect(got.path).toBeNull();
    expect(got.unreachableReason).toContain("larger than");
  });

  it("uses the video downloader for video hosts", async () => {
    const got = await fetchArtifact(urlRef("video", "https://youtu.be/abc"), tempDir(), {
      maxBytes: 10_000,
      videoDownloader: async (_url, dest) => {
        writeFileSync(join(dest, "download.mp4"), MP4);
        return join(dest, "download.mp4");
      },
    });
    expect(got.detected).toBe("mp4");
    expect(got.path?.endsWith("video.mp4")).toBe(true);
  });

  it("reports a failed video download", async () => {
    const got = await fetchArtifact(urlRef("video", "https://www.youtube.com/watch?v=abc"), tempDir(), {
      maxBytes: 10,
      videoDownloader: async () => {
        throw new Error("ERROR: [youtube] abc: Sign in to confirm you're not a bot\nmore");
      },
    });
    expect(got.unreachableReason).toBe(
      "video download failed: ERROR: [youtube] abc: Sign in to confirm you're not a bot",
    );
  });

  it("rejects page hosts without touching the network", async () => {
    const calls: string[] = [];
    const got = await fetchArtifact(urlRef("deck", "https://www.canva.com/design/DAF/view"), tempDir(), {
      maxBytes: 10_000,
      fetchImpl: fakeFetch({}, calls),
    });
    expect(got.unreachableReason).not.toBeNull();
    expect(calls).toEqual([]);
  });
});
