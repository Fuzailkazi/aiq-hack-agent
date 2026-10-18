/**
 * Keep a hackathon in step with its Google Form: download the linked responses sheet as CSV, import it (idempotent:
 * unchanged rows stay unchanged, edits become new revisions), and gate what is new. Scoring stays manual unless
 * HACKEVAL_AUTO_SCORE is on, because it spends model quota.
 *
 * Access is a Google service account (a robot identity) that the sheet is shared with as a viewer, so the sheet,
 * which holds names and emails, never has to be public.
 */
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IntakeMapping } from "./config";
import { type ImportReport, importCsv } from "./intake";
import type { Settings } from "./settings";
import type { DB } from "./store/db";

export const SHEETS_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const ServiceAccountSchema = z.object({
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.string().default(TOKEN_URL),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

export function loadServiceAccount(path: string): ServiceAccount {
  try {
    return ServiceAccountSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    throw new Error(
      `could not read the service account key at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** OAuth access token for a service account (JWT bearer grant, RS256). */
export async function serviceAccountToken(
  sa: ServiceAccount,
  scope: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat, exp: iat + 3600 }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key);
  const response = await fetchImpl(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
  });
  if (!response.ok) throw new Error(`Google refused the service account (HTTP ${response.status})`);
  const { access_token: token } = (await response.json()) as { access_token?: string };
  if (!token) throw new Error("Google returned no access token for the service account");
  return token;
}

/** The sheet's first tab as CSV (a form's responses tab). */
export async function fetchSheetCsv(
  sheetId: string,
  sa: ServiceAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const token = await serviceAccountToken(sa, SHEETS_SCOPE, fetchImpl);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sheetId)}/export?mimeType=text/csv`;
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404 || response.status === 403)
    throw new Error(
      `the service account ${sa.client_email} cannot open the sheet; share the sheet with it as a viewer`,
    );
  if (!response.ok) throw new Error(`downloading the sheet failed (HTTP ${response.status})`);
  return response.text();
}

export interface SyncStatus {
  hackathonId: string;
  at: string;
  ok: boolean;
  created: number;
  updated: number;
  unchanged: number;
  /** Rows that could not be imported, with the team and the reason. */
  skipped: string[];
  error: string | null;
  /** The gate (or full) run started for new and changed teams, if any. */
  runId: string | null;
}

const statusPath = (workspace: string, hid: string) => join(workspace, "sync", `status-${hid}.json`);

export function readSyncStatus(workspace: string, hid: string): SyncStatus | null {
  try {
    return JSON.parse(readFileSync(statusPath(workspace, hid), "utf8")) as SyncStatus;
  } catch {
    return null;
  }
}

function writeSyncStatus(workspace: string, status: SyncStatus): void {
  const path = statusPath(workspace, status.hackathonId);
  mkdirSync(join(workspace, "sync"), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(status, null, 2));
  renameSync(`${path}.tmp`, path);
}

export interface SyncDeps {
  db: DB;
  settings: Settings;
  mapping: IntakeMapping;
  /** Starts a pipeline run for the hackathon; returns its id, or null when one is already running. */
  startRun?: (hackathonId: string, phase: "gate" | "all") => string | null;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

/** One sync: download, import, then gate (or fully run) whatever is new or changed. Never throws. */
export async function syncOnce(hackathonId: string, deps: SyncDeps): Promise<SyncStatus> {
  const { settings } = deps;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const base = { hackathonId, at, created: 0, updated: 0, unchanged: 0, skipped: [], runId: null };
  let status: SyncStatus;
  try {
    if (!settings.sheetId || !settings.serviceAccountFile)
      throw new Error("set HACKEVAL_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE to sync from the form");
    const csv = await fetchSheetCsv(
      settings.sheetId,
      loadServiceAccount(settings.serviceAccountFile),
      deps.fetchImpl,
    );
    const dir = join(settings.workspace, "sync");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `responses-${hackathonId}.csv`);
    writeFileSync(path, csv);
    const report: ImportReport = importCsv(deps.db, hackathonId, path, deps.mapping, at);
    const changed = report.created + report.updated;
    const runId =
      changed && deps.startRun ? deps.startRun(hackathonId, settings.autoScore ? "all" : "gate") : null;
    status = {
      ...base,
      ok: true,
      created: report.created,
      updated: report.updated,
      unchanged: report.unchanged,
      skipped: [...report.errors, ...report.late],
      error: null,
      runId,
    };
  } catch (e) {
    status = { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  writeSyncStatus(settings.workspace, status);
  return status;
}

/** Runs syncOnce on a timer (the server owns one per configured hackathon). */
export class SheetSync {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SyncStatus> | null = null;

  constructor(
    readonly hackathonId: string,
    private readonly deps: SyncDeps,
  ) {}

  /** Sync now; a sync already in flight is joined rather than doubled. */
  now(): Promise<SyncStatus> {
    this.running ??= syncOnce(this.hackathonId, this.deps).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMin: number): void {
    void this.now();
    this.timer = setInterval(() => void this.now(), Math.max(1, intervalMin) * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
