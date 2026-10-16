/** Evidence extracted from submission artifacts (repo, deck, video). */
import { z } from "zod";
import { Timestamp } from "./submission";

export const RepoSnapshotSchema = z.object({
  url: z.string(),
  commitSha: z.string(),
  committerDate: Timestamp,
  commitsAfterDeadline: z.number().int().default(0),
  fileCount: z.number().int(),
  readmeExcerpt: z.string().default(""),
  /** The ref the team linked (`/tree/<ref>`), and the branch/tag it resolved to (null: default branch scanned). */
  requestedRef: z.string().nullable().default(null),
  resolvedRef: z.string().nullable().default(null),
});
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

/** Result of cloning: a snapshot + local path, or why the repo could not be fetched. */
export interface RepoAcquisition {
  snapshot: RepoSnapshot | null;
  path: string | null;
  unreachableReason: string | null;
}

export const InstallHitSchema = z.object({
  path: z.string(),
  kind: z.enum(["manifest", "lockfile", "dockerfile", "script", "notebook"]),
  ecosystem: z.enum(["pypi", "npm"]),
  package: z.string(),
  versionSpec: z.string().nullable().default(null),
});
export type InstallHit = z.infer<typeof InstallHitSchema>;

export const UsageSiteSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  symbol: z.string(),
  kind: z.enum(["import", "client_init", "call", "http_call"]),
  snippet: z.string(),
  inTest: z.boolean().default(false),
  /** TS `import type`: cannot call anything at runtime. */
  typeOnly: z.boolean().default(false),
});
export type UsageSite = z.infer<typeof UsageSiteSchema>;

export const EnvSignalSchema = z.object({
  path: z.string(),
  var: z.string(),
  /** Whether the value looks like a real key; the value itself is never stored. */
  hasRealValue: z.boolean(),
});
export type EnvSignal = z.infer<typeof EnvSignalSchema>;

export const ArmorIQEvidenceSchema = z.object({
  installs: z.array(InstallHitSchema).default([]),
  usageSites: z.array(UsageSiteSchema).default([]),
  /** Things the scanner could not follow; they route to Jev / human review instead of FAIL. */
  unresolved: z.array(z.string()).default([]),
  envSignals: z.array(EnvSignalSchema).default([]),
  configFiles: z.array(z.string()).default([]),
  secretExposed: z.boolean().default(false),
  redactedKeys: z.array(z.string()).default([]),
});
export type ArmorIQEvidence = z.infer<typeof ArmorIQEvidenceSchema>;

export const sdkFunctionsUsed = (ev: ArmorIQEvidence): string[] =>
  [
    ...new Set(
      ev.usageSites.filter((u) => u.kind === "client_init" || u.kind === "call").map((u) => u.symbol),
    ),
  ].sort();

export const SlideDigestSchema = z.object({
  index: z.number().int(),
  text: z.string(),
  notes: z.string().default(""),
  imagePath: z.string().nullable().default(null),
});
export type SlideDigest = z.infer<typeof SlideDigestSchema>;

export const DeckDigestSchema = z.object({
  sourceFormat: z.enum(["pptx", "pdf"]),
  slideCount: z.number().int(),
  slides: z.array(SlideDigestSchema),
  imagesSampled: z.boolean().default(false),
  /** Slide images unavailable (text is still complete). */
  renderError: z.string().nullable().default(null),
});
export type DeckDigest = z.infer<typeof DeckDigestSchema>;

export const TranscriptSegmentSchema = z.object({ startS: z.number(), endS: z.number(), text: z.string() });
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const KeyframeSchema = z.object({ tS: z.number(), imagePath: z.string() });
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const VideoDigestSchema = z.object({
  durationS: z.number(),
  hasSpeech: z.boolean(),
  transcript: z.array(TranscriptSegmentSchema),
  keyframes: z.array(KeyframeSchema),
  /** Set when only the first part of a long video was analyzed (keyframes and transcript stop here). */
  analyzedUntilS: z.number().nullable().default(null),
});
export type VideoDigest = z.infer<typeof VideoDigestSchema>;

export const MediaDigestSchema = z.object({
  deck: DeckDigestSchema.nullable().default(null),
  video: VideoDigestSchema.nullable().default(null),
  /** Artifact kind -> why it could not be fetched or read. */
  unreachable: z.record(z.string(), z.string()).default({}),
});
export type MediaDigest = z.infer<typeof MediaDigestSchema>;
