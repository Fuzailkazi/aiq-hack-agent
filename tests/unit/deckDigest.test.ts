import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { digestDeck, sampleIndices } from "../../src/digest/deck";
import { tempDir } from "../helpers";

const has = (bin: string): boolean => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const canRender = has("soffice") && has("pdftoppm");
const DECK3 = "tests/fixtures/decks/deck3.pptx";
const DECK10 = "tests/fixtures/decks/deck10.pptx";

describe("sampleIndices", () => {
  it.each([
    [0, 5, []],
    [1, 5, [0]],
    [3, 40, [0, 1, 2]],
    [5, 1, [0]],
    [10, 4, [0, 3, 6, 9]],
  ])("(%i, %i)", (n, k, expected) => {
    expect(sampleIndices(n, k)).toEqual(expected);
  });

  it("spreads over large decks", () => {
    const picked = sampleIndices(100, 40);
    expect(picked).toHaveLength(40);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(99);
    expect([...new Set(picked)].sort((a, b) => a - b)).toEqual(picked);
  });
});

describe("digestDeck", () => {
  it("extracts PPTX text, notes and tables even without a renderer", async () => {
    const digest = await digestDeck(DECK3, tempDir(), { soffice: "definitely-not-soffice" });
    expect(digest.sourceFormat).toBe("pptx");
    expect(digest.slideCount).toBe(3);
    const first = digest.slides[0];
    expect(first.index).toBe(1);
    expect(first.text).toContain("Slide 1: Guarded agent");
    expect(first.text).toContain("Body 1 & more");
    expect(first.text).toContain("Metric");
    expect(first.text).toContain("99% blocked");
    expect(first.notes).toBe("Speaker note 1");
    expect(digest.slides.every((s) => s.imagePath === null)).toBe(true);
    expect(digest.renderError).toBe("LibreOffice (soffice) not available");
  });

  it.skipIf(!canRender)("renders every slide of a small deck", async () => {
    const digest = await digestDeck(DECK3, tempDir());
    expect(digest.renderError).toBeNull();
    expect(digest.imagesSampled).toBe(false);
    expect(digest.slides.every((s) => s.imagePath?.endsWith(".png") && existsSync(s.imagePath))).toBe(true);
  });

  it.skipIf(!canRender)("renders an even sample of a large deck but keeps all text", async () => {
    const digest = await digestDeck(DECK10, tempDir(), { maxImages: 4 });
    expect(digest.imagesSampled).toBe(true);
    expect(digest.slides.filter((s) => s.imagePath).map((s) => s.index)).toEqual([1, 4, 7, 10]);
    expect(digest.slides.every((s) => s.text)).toBe(true);
  });

  it.skipIf(!has("pdftoppm"))("reads PDF decks", async () => {
    const digest = await digestDeck("tests/fixtures/decks/deck3.pdf", tempDir());
    expect(digest.sourceFormat).toBe("pdf");
    expect(digest.slideCount).toBe(3);
    expect(digest.slides[1].text).toContain("Slide 2: Guarded agent");
    expect(digest.slides.every((s) => s.imagePath)).toBe(true);
  });

  it.each(["broken.pptx", "broken.pdf"])("rejects a corrupt %s", async (name) => {
    const dir = tempDir();
    writeFileSync(join(dir, name), "not really a document");
    await expect(
      digestDeck(join(dir, name), join(dir, "out"), { soffice: "definitely-not-soffice" }),
    ).rejects.toThrow(/could not read deck/);
  });

  it("rejects unsupported formats", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "deck.key"), "x");
    await expect(digestDeck(join(dir, "deck.key"), dir)).rejects.toThrow(/unsupported deck format/);
  });
});

describe("hostile decks", () => {
  const rewrite = async (edit: (zip: JSZip) => Promise<void>) => {
    const zip = await JSZip.loadAsync(readFileSync(DECK3));
    await edit(zip);
    const out = join(tempDir(), "hostile.pptx");
    writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    return out;
  };

  it("counts a slide referenced many times once (no text amplification)", async () => {
    const deck = await rewrite(async (zip) => {
      const xml = (await zip.file("ppt/presentation.xml")?.async("string")) ?? "";
      const first = /<p:sldId\b[^>]*\/>/.exec(xml)?.[0] ?? "";
      zip.file("ppt/presentation.xml", xml.replace(first, first.repeat(300)));
    });
    const digest = await digestDeck(deck, tempDir(), { soffice: "/nonexistent/soffice" });
    expect(digest.slideCount).toBeLessThanOrEqual(3);
  });

  it("refuses a slide whose XML decompresses past the size cap", async () => {
    const deck = await rewrite(async (zip) => {
      zip.file("ppt/slides/slide1.xml", `<p:sld><a:t>${"A".repeat(12_000_000)}</a:t></p:sld>`);
    });
    await expect(digestDeck(deck, tempDir(), { soffice: "/nonexistent/soffice" })).rejects.toThrow(
      /too large/,
    );
  });

  it("extracts PDF text out of process, under the timeout", async () => {
    const slow = join(tempDir(), "slow-pdftotext");
    writeFileSync(slow, "#!/bin/sh\nsleep 10\n");
    chmodSync(slow, 0o755);
    const started = Date.now();
    await expect(
      digestDeck("tests/fixtures/decks/deck3.pdf", tempDir(), { pdftotext: slow, timeoutS: 1 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
