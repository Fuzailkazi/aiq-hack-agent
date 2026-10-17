/**
 * Jev calibration: an independent per-criterion second opinion over the RAW evidence.
 * Jev never sees the LLM's levels, rationale or findings — only the deck text, transcript and scanner summary.
 */
import { noul, score } from "@typesafe-ai/sdk";
import { repoSummary } from "../agents/messages";
import { SecretRedactor } from "../digest/armoriq/secrets";
import type { ArmorIQEvidence, MediaDigest } from "../schemas/evidence";
import type { Citation, Scorecard } from "../schemas/findings";
import type { Criterion, Source } from "../schemas/rubric";
import type { JevQuestion } from "./client";
import { deckText, transcriptText } from "./prescreenQuestions";

export const SCORE = "score";
export const SUFFICIENT = "sufficient";
export const CLAIMS_UNSUPPORTED = "claims_unsupported";
export const CALIBRATION_BUDGET = 8000;

export function criterionQuestions(c: Criterion): Record<string, JevQuestion> {
  // The rubric schema guarantees 2-10 levels, which is exactly what Jev's Score accepts.
  const [lowest, next, ...rest] = c.levels.map((l) => `${l.label}: ${l.description}`);
  return {
    [SCORE]: score(
      `Using only \`evidence\`, which level best describes this submission on "${c.name}" (${c.description})?`,
      [lowest, next, ...rest],
    ),
    [SUFFICIENT]: noul(
      `Is there enough evidence in \`evidence\` to place this submission on the rubric for "${c.name}"?`,
    ),
  };
}

export const claimsQuestions = (): Record<string, JevQuestion> => ({
  [CLAIMS_UNSUPPORTED]: noul(
    "Do `deckText` or `videoTranscript` claim features, results or ArmorIQ usage that `repository` and the transcript do not support?",
  ),
});

const redactor = new SecretRedactor();
const LABEL: Record<Source, string> = {
  deck: "Deck",
  video: "Video transcript",
  repo: "Repository",
  form: "Live demo check",
};

/** Raw text per source; `cited` restricts deck and video to what the scorecard cited (repo stays whole: it is small). */
function sourceText(
  source: Source,
  media: MediaDigest,
  evidence: ArmorIQEvidence | null,
  cited: Citation[] | null,
): string {
  if (source === "repo") return repoSummary(evidence);
  if (source === "form") {
    // Free-text form answers stay with the LLM judge; Jev sees only the automated live demo check.
    const demo = media.liveDemo;
    if (!demo) return "(no live demo URL checked)";
    return [
      `url: ${demo.url}`,
      `reachable: ${demo.reachable ? "yes" : "no"}${demo.status ? ` (HTTP ${demo.status})` : ""}`,
      demo.error ? `error: ${demo.error}` : "",
      demo.title ? `page title: ${demo.title}` : "",
      demo.excerpt ? `page text: ${demo.excerpt}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (source === "deck") {
    if (!media.deck) return "(no deck submitted)";
    if (!cited) return deckText(media.deck);
    const pages = citedSlides(cited);
    return deckText({ ...media.deck, slides: media.deck.slides.filter((s) => pages.has(s.index)) });
  }
  if (!media.video) return "(no video submitted)";
  if (media.video.remoteUri)
    return "(the video was watched directly by the LLM judge; no transcript is available)";
  if (!media.video.transcript.length) return "(the video has no speech)";
  if (!cited) return transcriptText(media.video);
  const spans = citedSpans(cited);
  const transcript = media.video.transcript.filter((seg) =>
    spans.some(([start, end]) => seg.endS >= start && seg.startS <= end),
  );
  return transcriptText({ ...media.video, transcript });
}

function citedSlides(cited: Citation[]): Set<number> {
  const pages = new Set<number>();
  for (const c of cited.filter((c) => c.source === "deck")) {
    for (const m of c.ref.matchAll(/slides?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi)) {
      const from = Number(m[1]);
      const to = Math.min(Number(m[2] ?? m[1]), from + 50);
      for (let i = from; i <= to; i++) pages.add(i);
    }
  }
  return pages;
}

const seconds = (t: string): number => t.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);

function citedSpans(cited: Citation[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const c of cited.filter((c) => c.source === "video")) {
    const m = c.ref.match(/(\d+(?::\d{2}){1,2})(?:\s*[-–]\s*(\d+(?::\d{2}){1,2}))?/);
    if (m) spans.push([seconds(m[1]), seconds(m[2] ?? m[1])]);
  }
  return spans;
}

function sections(
  c: Criterion,
  media: MediaDigest,
  evidence: ArmorIQEvidence | null,
  cited: Citation[] | null,
) {
  return c.sources.map((s) => `## ${LABEL[s]}\n${sourceText(s, media, evidence, cited)}`).join("\n\n");
}

/** The Jev state for one criterion: all raw evidence for its sources, or only the cited parts when over budget. */
export function criterionState(
  c: Criterion,
  media: MediaDigest,
  evidence: ArmorIQEvidence | null,
  card: Scorecard,
  budget = CALIBRATION_BUDGET,
) {
  let text = redactor.redact(sections(c, media, evidence, null));
  if (text.length > budget) {
    const cited = card.scores.find((s) => s.criterionId === c.id)?.citations ?? [];
    const narrowed = redactor.redact(sections(c, media, evidence, cited));
    text = narrowed.slice(0, budget);
  }
  return { criterion: c.id, criterionName: c.name, evidence: text };
}

export function claimsState(
  media: MediaDigest,
  evidence: ArmorIQEvidence | null,
  budget = CALIBRATION_BUDGET,
) {
  const third = Math.floor(budget / 3);
  return {
    deckText: redactor.redact(deckText(media.deck)).slice(0, third),
    videoTranscript: redactor.redact(transcriptText(media.video)).slice(0, third),
    repository: repoSummary(evidence).slice(0, third),
  };
}
