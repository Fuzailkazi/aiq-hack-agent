/** A team's submission: repo URL plus optional deck and video artifacts. */
import { z } from "zod";

/** ISO-8601 timestamp that must carry a timezone offset (e.g. 2026-10-01T10:00:00Z). */
export const Timestamp = z.iso.datetime({ offset: true });

export const ArtifactRefSchema = z.object({
  kind: z.enum(["deck", "video"]),
  origin: z.enum(["url", "upload"]),
  uri: z.string(),
  sha256: z.string().nullable().default(null),
  unreachableReason: z.string().nullable().default(null),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const SubmissionSchema = z.object({
  id: z.string(),
  hackathonId: z.string(),
  externalId: z.string().nullable().default(null),
  teamName: z.string(),
  track: z.string().nullable().default(null),
  repoUrl: z.string(),
  /** Branch/tag (possibly followed by a path) from a `/tree/<ref>` link; resolved against the remote at clone time. */
  repoRef: z.string().nullable().default(null),
  deck: ArtifactRefSchema.nullable().default(null),
  video: ArtifactRefSchema.nullable().default(null),
  /** A deployed app the team links to; checked for reachability, never logged into. */
  liveDemoUrl: z.string().nullable().default(null),
  /** Free-text form answers (key -> answer), judged by the form analyst. */
  answers: z.record(z.string(), z.string()).default({}),
  submittedAt: Timestamp,
  revision: z.number().int().default(1),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^http:\/\//i, "https://")
    .replace(/^https:\/\/www\./i, "https://")
    .replace(/\.git$/, "")
    .toLowerCase();
}

/** Identity used for dedupe: the organizer-provided id, else the normalized repo URL. */
export const naturalKey = (s: Submission): string => s.externalId ?? normalizeRepoUrl(s.repoUrl);

/** Fields whose change makes a resubmission a new revision. */
export const contentKey = (s: Submission): string =>
  JSON.stringify([
    s.teamName,
    s.track,
    normalizeRepoUrl(s.repoUrl),
    s.repoRef,
    s.deck?.uri ?? null,
    s.video?.uri ?? null,
    s.liveDemoUrl,
    Object.entries(s.answers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
