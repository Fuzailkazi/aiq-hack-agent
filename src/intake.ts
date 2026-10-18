/** Submission intake: CSV import (organizer export) and single adds (CLI / UI upload). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { IntakeMapping } from "./config";
import { type ArtifactRef, type Submission, SubmissionSchema, Timestamp } from "./schemas/submission";
import type { DB } from "./store/db";
import * as q from "./store/queries";

export interface ImportReport {
  created: number;
  updated: number;
  unchanged: number;
  ignoredLate: number;
  ignoredOlder: number;
  errors: string[];
  late: string[];
}

export const ALLOWED_REPO_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];
const STOP_SEGMENTS = new Set([
  "tree",
  "blob",
  "-",
  "commit",
  "commits",
  "pull",
  "pulls",
  "issues",
  "releases",
  "actions",
  "wiki",
]);
const URL_RE = /^https?:\/\//i;

/** Normalize a repository link to https://<host>/<owner>/<repo>; anything else is an error. */
export function canonicalRepoUrl(raw: string, allowedHosts: string[] = ALLOWED_REPO_HOSTS): string {
  const value = raw.trim();
  const error = new q.InputError(
    `repo_url must be a repository URL on ${allowedHosts.join(", ")} (got '${value}')`,
  );
  let host: string;
  let path: string;
  const ssh = /^git@([\w.-]+):(.+)$/.exec(value);
  if (ssh) {
    [host, path] = [ssh[1], ssh[2]];
  } else {
    let url = value;
    if (!URL_RE.test(url)) {
      if (!/^[\w-]+(\.[\w-]+)+\//.test(url)) throw error;
      url = `https://${url}`;
    }
    try {
      const parsed = new URL(url);
      [host, path] = [parsed.hostname, parsed.pathname];
    } catch {
      throw error;
    }
  }
  host = host.toLowerCase().replace(/^www\./, "");
  if (!allowedHosts.includes(host)) throw error;
  let segments = path.split("/").filter(Boolean);
  const stop = segments.findIndex((s) => STOP_SEGMENTS.has(s));
  if (stop >= 0) segments = segments.slice(0, stop);
  if (host === "github.com" || host === "bitbucket.org") segments = segments.slice(0, 2);
  if (segments.length) segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, "");
  if (segments.length < 2 || !segments.every((s) => /^[\w.-]+$/.test(s))) throw error;
  return `https://${host}/${segments.join("/")}`;
}

/** URL cells stay URLs; anything else is a local file. CSV cells (team-supplied) must stay inside baseDir. */
export function artifactFromCell(
  kind: "deck" | "video",
  value: string | null | undefined,
  baseDir: string,
  { confineToBase = false } = {},
): ArtifactRef | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (URL_RE.test(v)) return { kind, origin: "url", uri: v, sha256: null, unreachableReason: null };
  const outside = new q.InputError(`${kind}: local file paths in the CSV must be inside the CSV's folder`);
  if (confineToBase && (v.startsWith("~") || isAbsolute(v))) throw outside;
  const expanded = v.startsWith("~/") ? resolve(homedir(), v.slice(2)) : v;
  const path = resolve(baseDir, expanded);
  if (confineToBase && relative(resolve(baseDir), path).startsWith("..")) throw outside;
  return { kind, origin: "upload", uri: path, sha256: null, unreachableReason: null };
}

const REF_SEGMENT = /^[\w.-]+$/;

/**
 * The ref part of a `/tree/<ref>[/<path>]` (GitHub/Bitbucket) or `/-/tree/<ref>` (GitLab) link, or null.
 * Where the ref ends and the path begins is decided later against the remote's real branches and tags.
 */
export function repoRefOf(value: string): string | null {
  let path: string;
  try {
    path = new URL(value.trim()).pathname;
  } catch {
    return null;
  }
  const m = path.match(/^\/[^/]+\/[^/]+(?:\/-)?\/(?:tree|src)\/(.+)$/);
  if (!m) return null;
  let ref: string;
  try {
    ref = decodeURIComponent(m[1]).replace(/\/+$/, "");
  } catch {
    return null;
  }
  const segments = ref.split("/");
  const safe = segments.every((s) => REF_SEGMENT.test(s) && s !== "." && s !== "..") && !ref.startsWith("-");
  return ref && safe ? ref : null;
}

/** "10/14/2026 12:26:21" (Google Forms, US order) or "2026-10-14 12:26:21" / "2026-10-14T12:26:21". */
const NAIVE_US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const NAIVE_ISO = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Minutes east of UTC for `zone` at the given UTC instant. */
function zoneOffsetMinutes(zone: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** A wall-clock time in `zone` as ISO-8601 UTC, or null when `value` is not a recognized naive format. */
export function zonedToIso(value: string, zone: string): string | null {
  let y: number, mo: number, d: number, h: number, mi: number, s: number;
  const us = NAIVE_US.exec(value);
  const iso = NAIVE_ISO.exec(value);
  if (us) [mo, d, y, h, mi, s] = [+us[1], +us[2], +us[3], +us[4], +us[5], +(us[6] ?? 0)];
  else if (iso) [y, mo, d, h, mi, s] = [+iso[1], +iso[2], +iso[3], +iso[4], +iso[5], +(iso[6] ?? 0)];
  else return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  // Two passes settle the offset across a DST change.
  let utc = wall - zoneOffsetMinutes(zone, wall) * 60_000;
  utc = wall - zoneOffsetMinutes(zone, utc) * 60_000;
  return new Date(utc).toISOString().replace(/\.000Z$/, "Z");
}

/** Throws for an unknown IANA zone name. */
export function assertTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new q.InputError(`unknown timezone '${zone}' (use an IANA name such as Asia/Kolkata)`);
  }
}

/**
 * ISO-8601 with an explicit offset. A naive time is read in `timezone` when one is configured, and rejected
 * otherwise rather than guessed as UTC.
 */
export function parseTimestamp(
  value: string | null | undefined,
  fallback: string,
  fieldName = "submitted_at",
  timezone: string | null = null,
): string {
  const v = (value ?? "").trim();
  if (!v) return fallback;
  if (Timestamp.safeParse(v).success) return v;
  const zoned = timezone ? zonedToIso(v, timezone) : null;
  if (zoned) return zoned;
  throw new q.InputError(
    timezone
      ? `${fieldName} '${v}' is not a recognized date and time (e.g. 10/14/2026 12:26:21 or 2026-10-01T10:00:00Z)`
      : `${fieldName} must include a timezone offset (e.g. 2026-10-01T10:00:00Z), or set timezone in intake.yaml`,
  );
}

/** The track for a row: a column read as-is, or a rule mapping another column's value to a track. */
export function trackOf(
  mapping: IntakeMapping["track"],
  cell: (column: string) => string | null,
): string | null {
  if (mapping === null) return null;
  if (typeof mapping === "string") return cell(mapping);
  const value = (cell(mapping.column) ?? "").trim().toLowerCase();
  for (const [match, track] of Object.entries(mapping.values))
    if (match.trim().toLowerCase() === value) return track;
  return mapping.default;
}

/** A live demo link: http(s) URLs only (anything else is dropped, not an import error). */
export function liveDemoOf(value: string | null): string | null {
  if (!value || !URL_RE.test(value)) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export function importCsv(
  db: DB,
  hackathonId: string,
  csvPath: string,
  mapping: IntakeMapping,
  now: string,
): ImportReport {
  const deadline = q.getHackathon(db, hackathonId).deadline;
  const report: ImportReport = {
    created: 0,
    updated: 0,
    unchanged: 0,
    ignoredLate: 0,
    ignoredOlder: 0,
    errors: [],
    late: [],
  };
  const rows = parseCsv(readFileSync(csvPath, "utf8"), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    info: true,
  }) as { record: Record<string, string>; info: { lines: number } }[];
  if (mapping.timezone) assertTimezone(mapping.timezone);
  const headers = new Set(rows.length ? Object.keys(rows[0].record) : readHeader(csvPath));
  const missing = [mapping.teamName, mapping.repoUrl].filter((c) => !headers.has(c));
  if (missing.length) throw new q.InputError(`CSV is missing required column(s): ${missing.join(", ")}`);

  for (const { record, info } of rows) {
    let sub: Submission;
    try {
      sub = rowToSubmission(hackathonId, record, mapping, dirname(resolve(csvPath)), now);
    } catch (e) {
      const team = (record[mapping.teamName] ?? "").trim();
      report.errors.push(
        `row ${info.lines}${team ? ` (${team})` : ""}: ${e instanceof Error ? firstIssue(e) : String(e)}`,
      );
      continue;
    }
    const outcome = q.upsertSubmission(db, sub, deadline);
    const field = {
      created: "created",
      updated: "updated",
      unchanged: "unchanged",
      ignored_late: "ignoredLate",
      ignored_older: "ignoredOlder",
    } as const;
    report[field[outcome]] += 1;
    if (outcome === "ignored_late") {
      report.late.push(
        `row ${info.lines} (${sub.teamName}): submitted ${sub.submittedAt}, after the deadline`,
      );
    }
  }
  return report;
}

export interface AddFields {
  teamName: string;
  repoUrl: string;
  deck?: string | null;
  video?: string | null;
  track?: string | null;
  externalId?: string | null;
}

export function addSubmission(db: DB, hackathonId: string, fields: AddFields, now: string): q.UpsertOutcome {
  const deadline = q.getHackathon(db, hackathonId).deadline;
  const sub = SubmissionSchema.parse({
    id: q.newSubmissionId(),
    hackathonId,
    externalId: fields.externalId ?? null,
    teamName: fields.teamName,
    track: fields.track ?? null,
    repoUrl: canonicalRepoUrl(fields.repoUrl),
    repoRef: repoRefOf(fields.repoUrl),
    deck: artifactFromCell("deck", fields.deck, process.cwd()),
    video: artifactFromCell("video", fields.video, process.cwd()),
    submittedAt: now,
  });
  return q.upsertSubmission(db, sub, deadline);
}

function rowToSubmission(
  hackathonId: string,
  row: Record<string, string>,
  m: IntakeMapping,
  baseDir: string,
  now: string,
): Submission {
  const cell = (column: string | null): string | null => (column ? (row[column] ?? "").trim() || null : null);
  const team = cell(m.teamName);
  const repo = cell(m.repoUrl);
  if (!team || !repo) throw new Error("team_name and repo_url are required");
  const answers: Record<string, string> = {};
  for (const [key, column] of Object.entries(m.answers)) {
    const value = cell(column);
    if (value) answers[key] = value;
  }
  return SubmissionSchema.parse({
    id: q.newSubmissionId(),
    hackathonId,
    externalId: cell(m.externalId),
    teamName: team,
    track: trackOf(m.track, cell),
    repoUrl: canonicalRepoUrl(repo),
    repoRef: repoRefOf(repo),
    deck: artifactFromCell("deck", cell(m.deck), baseDir, { confineToBase: true }),
    video: artifactFromCell("video", cell(m.video), baseDir, { confineToBase: true }),
    liveDemoUrl: liveDemoOf(cell(m.liveDemo)),
    answers,
    submittedAt: parseTimestamp(cell(m.submittedAt), now, "submitted_at", m.timezone),
  });
}

function readHeader(csvPath: string): string[] {
  const first = readFileSync(csvPath, "utf8").replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  return first.split(",").map((h) => h.trim());
}

function firstIssue(e: Error): string {
  const issues = (e as { issues?: { message: string }[] }).issues;
  return issues?.length ? issues[0].message : e.message;
}
