/** Turn a pitch deck (PPTX or PDF) into per-slide text, notes and evenly sampled slide images. */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";
import { type DeckDigest, DeckDigestSchema, type SlideDigest } from "../schemas/evidence";
import { run } from "../util/exec";

const TARGET_WIDTH_PX = 1280;
/** Hostile-deck guards: real decks are far below these. */
const MAX_SLIDES = 300;
const MAX_ENTRY_BYTES = 10_000_000;
const MAX_TOTAL_XML_BYTES = 100_000_000;

export interface DeckOptions {
  maxImages?: number;
  soffice?: string;
  pdftoppm?: string;
  pdftotext?: string;
  timeoutS?: number;
}

/** Up to k indices spread evenly over 0..n-1, always including the first and last. */
export function sampleIndices(n: number, k: number): number[] {
  if (n <= 0 || k <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  if (k === 1) return [0];
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1))))].sort(
    (a, b) => a - b,
  );
}

export async function digestDeck(path: string, outDir: string, opts: DeckOptions = {}): Promise<DeckDigest> {
  const suffix = extname(path).toLowerCase();
  if (suffix !== ".pptx" && suffix !== ".pdf")
    throw new Error(`unsupported deck format: ${suffix || basename(path)}`);
  await mkdir(outDir, { recursive: true });
  const timeoutMs = (opts.timeoutS ?? 180) * 1000;

  let slides: SlideDigest[];
  let pdfPath: string | null;
  let renderError: string | null = null;
  const pdftotext = opts.pdftotext ?? "pdftotext";
  if (suffix === ".pptx") {
    slides = await pptxSlides(path);
    const converted = await pptxToPdf(path, outDir, opts.soffice ?? "soffice", timeoutMs);
    pdfPath = converted.pdf;
    renderError = converted.error;
  } else {
    slides = (await pdfTexts(path, pdftotext, timeoutMs))
      .slice(0, MAX_SLIDES)
      .map((text, i) => ({ index: i + 1, text, notes: "", imagePath: null }));
    pdfPath = path;
  }

  const picked = sampleIndices(slides.length, opts.maxImages ?? 40);
  if (pdfPath) {
    const pages = Math.min((await pdfTexts(pdfPath, pdftotext, timeoutMs)).length, MAX_SLIDES);
    if (pages !== slides.length) {
      renderError = `rendered ${pages} pages for ${slides.length} slides; images skipped`;
    } else {
      for (const i of picked) {
        const rendered = await renderPage(pdfPath, i + 1, outDir, opts.pdftoppm ?? "pdftoppm", timeoutMs);
        if (typeof rendered !== "string") {
          renderError = rendered.error;
          break;
        }
        slides[i].imagePath = rendered;
      }
    }
  }
  return DeckDigestSchema.parse({
    sourceFormat: suffix === ".pptx" ? "pptx" : "pdf",
    slideCount: slides.length,
    slides,
    imagesSampled: picked.length < slides.length,
    renderError,
  });
}

// --- PPTX: slide order from presentation.xml, text from <a:t> runs, notes from the notes slide body ---

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string): string =>
  s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith("#x")
      ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
      : e.startsWith("#")
        ? String.fromCodePoint(Number(e.slice(1)))
        : XML_ENTITIES[e],
  );

/** Paragraph texts (each <a:p>, its <a:t> runs joined) in document order. */
function paragraphs(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
    .map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(""))
    .filter((t) => t.trim());
}

function relTargets(relsXml: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    out.set(attr("Id"), { target: attr("Target"), type: attr("Type") });
  }
  return out;
}

async function pptxSlides(path: string): Promise<SlideDigest[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(path));
  } catch (e) {
    throw new Error(`could not read deck: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Read entries as streams with a byte cap: declared sizes in a zip can lie (zip bombs).
  let budget = MAX_TOTAL_XML_BYTES;
  const read = async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (!file) return "";
    const text = await readCapped(file, Math.min(MAX_ENTRY_BYTES, budget), name);
    budget -= text.length;
    return text;
  };
  const presentation = await read("ppt/presentation.xml");
  if (!presentation) throw new Error("could not read deck: not a PowerPoint file");
  const rels = relTargets(await read("ppt/_rels/presentation.xml.rels"));
  // A slide referenced twice is read once (repeated references would amplify text without bound).
  const order = [
    ...new Set(
      [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => rels.get(m[1])?.target ?? ""),
    ),
  ].slice(0, MAX_SLIDES);

  const slides: SlideDigest[] = [];
  for (const [i, target] of order.entries()) {
    const slidePath = `ppt/${target.replace(/^\/?ppt\//, "")}`;
    const text = paragraphs(await read(slidePath)).join("\n");
    const slideRels = relTargets(
      await read(slidePath.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels")),
    );
    const notesRel = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"));
    let notes = "";
    if (notesRel) {
      const notesXml = await read(`ppt/${notesRel.target.replace(/^\.\.\//, "")}`);
      const body = [...notesXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].find((sp) =>
        /<p:ph\b[^>]*type="body"/.test(sp[0]),
      );
      notes = body ? paragraphs(body[0]).join("\n").trim() : "";
    }
    slides.push({ index: i + 1, text, notes, imagePath: null });
  }
  return slides;
}

async function pptxToPdf(
  path: string,
  outDir: string,
  soffice: string,
  timeoutMs: number,
): Promise<{ pdf: string | null; error: string | null }> {
  const profile = await mkdtemp(join(tmpdir(), "hackeval-lo-"));
  try {
    const result = await run(
      soffice,
      [
        `-env:UserInstallation=file://${profile}`,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        path,
      ],
      timeoutMs,
    );
    if (result.missing) return { pdf: null, error: "LibreOffice (soffice) not available" };
    if (result.timedOut)
      return { pdf: null, error: `pptx to pdf conversion timed out after ${timeoutMs / 1000}s` };
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  const pdf = join(outDir, `${basename(path, extname(path))}.pdf`);
  return existsSync(pdf) ? { pdf, error: null } : { pdf: null, error: "pptx to pdf conversion failed" };
}

/** JSZip's chunked reader (present at runtime, missing from its type declarations). */
interface ZipStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): ZipStream;
  on(event: "error", cb: (e: Error) => void): ZipStream;
  on(event: "end", cb: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

function readCapped(file: JSZip.JSZipObject, maxBytes: number, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = (file as unknown as { internalStream(type: "uint8array"): ZipStream }).internalStream(
      "uint8array",
    );
    stream
      .on("data", (chunk: Uint8Array) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.pause();
          reject(new Error(`could not read deck: ${name} is too large`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (e: Error) => reject(new Error(`could not read deck: ${e.message}`)))
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      .resume();
  });
}

/** Per-page text. Out of process with poppler's pdftotext (a hostile PDF cannot hang this process); pdf.js only
 *  when pdftotext is not installed. */
async function pdfTexts(path: string, pdftotext: string, timeoutMs: number): Promise<string[]> {
  const result = await run(pdftotext, ["-enc", "UTF-8", "-q", path, "-"], timeoutMs);
  if (result.timedOut)
    throw new Error(`could not read deck: PDF text extraction timed out after ${timeoutMs / 1000}s`);
  if (!result.missing) {
    if (result.code !== 0)
      throw new Error(`could not read deck: ${result.stderr.trim().split("\n")[0] || "unreadable PDF"}`);
    const pages = result.stdout.split("\f");
    if (pages.length > 1 && pages.at(-1)?.trim() === "") pages.pop();
    return pages.map((t) => t.trim());
  }
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
    const { text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((t) => t.trim());
  } catch (e) {
    throw new Error(`could not read deck: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function renderPage(
  pdf: string,
  page: number,
  outDir: string,
  pdftoppm: string,
  timeoutMs: number,
): Promise<string | { error: string }> {
  const prefix = join(outDir, `slide-${String(page).padStart(3, "0")}`);
  const args = [
    "-png",
    "-f",
    String(page),
    "-l",
    String(page),
    "-singlefile",
    "-scale-to-x",
    String(TARGET_WIDTH_PX),
    "-scale-to-y",
    "-1",
    pdf,
    prefix,
  ];
  const result = await run(pdftoppm, args, timeoutMs);
  if (result.missing) return { error: "poppler (pdftoppm) not available; slide images skipped" };
  return existsSync(`${prefix}.png`) ? `${prefix}.png` : { error: `rendering slide ${page} failed` };
}
