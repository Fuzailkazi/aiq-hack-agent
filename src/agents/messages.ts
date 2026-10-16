/** Build each agent's multimodal user message from the digests: text plus slide/keyframe images. */
import { existsSync, readFileSync } from "node:fs";
import type { Part } from "@google/genai";
import { SecretRedactor } from "../digest/armoriq/secrets";
import { deckText, mmss, transcriptText } from "../jev/prescreenQuestions";
import { type ArmorIQEvidence, type MediaDigest, sdkFunctionsUsed } from "../schemas/evidence";
import type { ArtifactFindings } from "../schemas/findings";
import type { Source } from "../schemas/rubric";
import type { Submission } from "../schemas/submission";
import { FENCE_CLOSE, FENCE_OPEN } from "./prompts";

const MAX_REPO_SITES = 25;
const redactor = new SecretRedactor();

/** Wrap untrusted content; neutralize marker look-alikes so content cannot close the fence early. */
export function fence(text: string): string {
  const safe = text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
  return `${FENCE_OPEN}\n${safe}\n${FENCE_CLOSE}`;
}

const text = (value: string): Part => ({ text: value });
function image(path: string | null, mimeType: string): Part | null {
  if (!path || !existsSync(path)) return null;
  return { inlineData: { data: readFileSync(path).toString("base64"), mimeType } };
}

export function buildAnalystParts(
  source: Source,
  sub: Submission,
  media: MediaDigest,
  evidence: ArmorIQEvidence | null,
): Part[] {
  if (source === "deck") {
    const deck = media.deck;
    if (!deck) throw new Error("no deck to analyze");
    let intro = `Pitch deck with ${deck.slideCount} slides`;
    if (deck.imagesSampled) intro += "; slide images are provided for an evenly spaced sample";
    if (deck.renderError) intro += `; slide images are unavailable (${deck.renderError})`;
    const parts: Part[] = [
      text(`${intro}.`),
      text(fence(`Team: ${sub.teamName}\n${redactor.redact(deckText(deck))}`)),
    ];
    for (const slide of deck.slides) {
      const img = image(slide.imagePath, "image/png");
      if (img) parts.push(text(`Image of slide ${slide.index}:`), img);
    }
    return parts;
  }
  if (source === "video") {
    const video = media.video;
    if (!video) throw new Error("no video to analyze");
    let intro = `Video, ${mmss(video.durationS)} long. Timestamped transcript (mm:ss) and keyframes follow.`;
    if (!video.hasSpeech) intro += " No speech was detected.";
    const parts: Part[] = [
      text(intro),
      text(fence(`Team: ${sub.teamName}\n${redactor.redact(transcriptText(video))}`)),
    ];
    for (const frame of video.keyframes) {
      const img = image(frame.imagePath, "image/jpeg");
      if (img) parts.push(text(`Frame at ${mmss(frame.tS)}:`), img);
    }
    return parts;
  }
  return [
    text(`ArmorIQ integration evidence from a static scan of the team's repository (${sub.repoUrl}).`),
    text(fence(repoSummary(evidence))),
  ];
}

export function repoSummary(evidence: ArmorIQEvidence | null): string {
  if (!evidence) return "No repository evidence is available.";
  const lines = ["Install declarations:"];
  lines.push(
    ...(evidence.installs.length
      ? evidence.installs.map((i) => `- ${i.path}: ${i.package} (${i.kind})`)
      : ["- none"]),
  );
  lines.push(`SDK functions used: ${sdkFunctionsUsed(evidence).join(", ") || "none"}`, "Usage sites:");
  const sites = evidence.usageSites.filter((u) => u.kind !== "import").slice(0, MAX_REPO_SITES);
  for (const u of sites)
    lines.push(`- ${u.path}:${u.line} ${u.kind} ${u.symbol}${u.inTest ? " (test)" : ""}\n${u.snippet}`);
  if (!sites.length) lines.push("- none");
  if (evidence.unresolved.length) lines.push(`Scanner could not resolve: ${evidence.unresolved.join("; ")}`);
  if (evidence.configFiles.length) lines.push(`ArmorIQ config files: ${evidence.configFiles.join(", ")}`);
  if (evidence.secretExposed) lines.push("An ArmorIQ API key is committed to the repository (redacted).");
  return redactor.redact(lines.join("\n"));
}

export function buildSynthesisParts(
  sub: Submission,
  findings: ArtifactFindings[],
  evidence: ArmorIQEvidence | null,
): Part[] {
  return [
    text(`Analyst findings for a team submission (${sub.repoUrl}), then the repository evidence summary.`),
    text(
      fence(
        `Team: ${sub.teamName}\nFindings:\n${JSON.stringify(findings, null, 1)}\n\nRepository evidence:\n${repoSummary(evidence)}`,
      ),
    ),
  ];
}
