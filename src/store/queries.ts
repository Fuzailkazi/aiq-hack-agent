/** Data access. better-sqlite3 is synchronous, so every function is a plain call (and thus atomic per call). */
import { randomUUID } from "node:crypto";
import {
  type Evaluation,
  EvaluationSchema,
  type HumanReviewInput,
  HumanReviewSchema,
  type Status,
} from "../schemas/evaluation";
import { type Rubric, RubricSchema } from "../schemas/rubric";
import {
  type ArtifactRef,
  contentKey,
  naturalKey,
  type Submission,
  SubmissionSchema,
  Timestamp,
} from "../schemas/submission";
import type { DB } from "./db";

export type UpsertOutcome = "created" | "updated" | "unchanged" | "ignored_late" | "ignored_older";

export interface Hackathon {
  id: string;
  name: string;
  deadline: string | null;
  activeRubricId: string | null;
  activeRubricVersion: string | null;
}

export interface SubmissionRecord {
  submission: Submission;
  status: Status;
}

/** The submission's status changed underneath us (e.g. superseded by a re-import during a run). */
/** Invalid input from the caller (HTTP 400). */
export class InputError extends Error {}
/** The thing being created already exists (HTTP 409). */
export class AlreadyExists extends Error {}
export class StatusConflict extends Error {}
export class NotFoundError extends Error {}

const now = (): string => new Date().toISOString();
const time = (iso: string): number => Date.parse(iso);

export function createHackathon(db: DB, id: string, name: string, deadline: string | null): Hackathon {
  if (deadline !== null && !Timestamp.safeParse(deadline).success) {
    throw new InputError("deadline must include a timezone offset (e.g. 2026-10-20T23:59:00Z)");
  }
  if (db.prepare("SELECT 1 FROM hackathons WHERE id = ?").get(id))
    throw new AlreadyExists(`hackathon '${id}' already exists`);
  db.prepare("INSERT INTO hackathons (id, name, deadline, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    deadline,
    now(),
  );
  return getHackathon(db, id);
}

export function getHackathon(db: DB, id: string): Hackathon {
  const row = db.prepare("SELECT * FROM hackathons WHERE id = ?").get(id) as
    | Record<string, string | null>
    | undefined;
  if (!row) throw new NotFoundError(`unknown hackathon '${id}'; run \`hackeval init\` first`);
  return {
    id: row.id as string,
    name: row.name as string,
    deadline: row.deadline,
    activeRubricId: row.active_rubric_id,
    activeRubricVersion: row.active_rubric_version,
  };
}

export function listHackathons(db: DB): Hackathon[] {
  const ids = db.prepare("SELECT id FROM hackathons ORDER BY created_at").all() as { id: string }[];
  return ids.map((r) => getHackathon(db, r.id));
}

/** Store a rubric version. Versions are immutable: same (id, version) with different content is an error. */
export function storeRubric(db: DB, hackathonId: string, rubric: Rubric): void {
  const body = JSON.stringify(RubricSchema.parse(rubric));
  const existing = db
    .prepare("SELECT body FROM rubrics WHERE hackathon_id = ? AND rubric_id = ? AND version = ?")
    .get(hackathonId, rubric.id, rubric.version) as { body: string } | undefined;
  if (existing) {
    if (existing.body !== body) {
      throw new AlreadyExists(
        `rubric ${rubric.id} v${rubric.version} already exists with different content; bump \`version\``,
      );
    }
    return;
  }
  db.prepare(
    "INSERT INTO rubrics (hackathon_id, rubric_id, version, body, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(hackathonId, rubric.id, rubric.version, body, now());
}

/** Make a rubric version active. Scored results under any other version become `stale` (re-scored from cache). */
export function activateRubric(db: DB, hackathonId: string, rubric: Rubric): number {
  getHackathon(db, hackathonId);
  return db.transaction(() => {
    storeRubric(db, hackathonId, rubric);
    db.prepare("UPDATE hackathons SET active_rubric_id = ?, active_rubric_version = ? WHERE id = ?").run(
      rubric.id,
      rubric.version,
      hackathonId,
    );
    const scored = db
      .prepare(
        "SELECT s.id, e.body FROM submissions s JOIN evaluations e ON e.submission_id = s.id WHERE s.hackathon_id = ? AND s.status IN ('finalized', 'needs_review')",
      )
      .all(hackathonId) as { id: string; body: string }[];
    let staled = 0;
    for (const row of scored) {
      const { rubricId, rubricVersion } = JSON.parse(row.body) as {
        rubricId?: string;
        rubricVersion?: string;
      };
      if (rubricId === rubric.id && rubricVersion === rubric.version) continue;
      setStatus(db, row.id, "stale");
      staled += 1;
    }
    return staled;
  })();
}

export function getRubric(db: DB, hackathonId: string, rubricId: string, version: string): Rubric | null {
  const row = db
    .prepare("SELECT body FROM rubrics WHERE hackathon_id = ? AND rubric_id = ? AND version = ?")
    .get(hackathonId, rubricId, version) as { body: string } | undefined;
  return row ? RubricSchema.parse(JSON.parse(row.body)) : null;
}

export function activeRubric(db: DB, hackathonId: string): Rubric {
  const h = getHackathon(db, hackathonId);
  if (!h.activeRubricId || !h.activeRubricVersion) {
    throw new NotFoundError(
      `hackathon '${hackathonId}' has no active rubric; run \`hackeval rubric activate\``,
    );
  }
  const row = db
    .prepare("SELECT body FROM rubrics WHERE hackathon_id = ? AND rubric_id = ? AND version = ?")
    .get(hackathonId, h.activeRubricId, h.activeRubricVersion) as { body: string };
  return RubricSchema.parse(JSON.parse(row.body));
}

export const newSubmissionId = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

export function upsertSubmission(db: DB, sub: Submission, deadline: string | null): UpsertOutcome {
  if (deadline !== null && time(sub.submittedAt) > time(deadline)) return "ignored_late";
  const key = naturalKey(sub);
  const current = db
    .prepare(
      "SELECT id, revision, body FROM submissions WHERE hackathon_id = ? AND natural_key = ? AND status != 'superseded' ORDER BY revision DESC LIMIT 1",
    )
    .get(sub.hackathonId, key) as { id: string; revision: number; body: string } | undefined;
  if (!current) {
    insertSubmission(db, { ...sub, revision: 1 }, key);
    return "created";
  }
  const existing = SubmissionSchema.parse(JSON.parse(current.body));
  if (contentKey(existing) === contentKey(sub)) return "unchanged";
  if (time(sub.submittedAt) < time(existing.submittedAt)) return "ignored_older";
  db.transaction(() => {
    setStatus(db, current.id, "superseded");
    insertSubmission(db, { ...sub, revision: current.revision + 1 }, key);
  })();
  return "updated";
}

function insertSubmission(db: DB, sub: Submission, key: string): void {
  db.prepare(
    "INSERT INTO submissions (id, hackathon_id, natural_key, revision, body, submitted_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
  ).run(sub.id, sub.hackathonId, key, sub.revision, JSON.stringify(sub), sub.submittedAt, now(), now());
}

export function getSubmission(db: DB, id: string): SubmissionRecord {
  const row = db.prepare("SELECT body, status FROM submissions WHERE id = ?").get(id) as
    | { body: string; status: Status }
    | undefined;
  if (!row) throw new NotFoundError(`unknown submission '${id}'`);
  return { submission: SubmissionSchema.parse(JSON.parse(row.body)), status: row.status };
}

export function currentSubmissions(db: DB, hackathonId: string, statuses?: Status[]): SubmissionRecord[] {
  let sql = "SELECT body, status FROM submissions WHERE hackathon_id = ? AND status != 'superseded'";
  const params: string[] = [hackathonId];
  if (statuses?.length) {
    sql += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }
  const rows = db.prepare(`${sql} ORDER BY rowid`).all(...params) as { body: string; status: Status }[];
  return rows.map((r) => ({ submission: SubmissionSchema.parse(JSON.parse(r.body)), status: r.status }));
}

export function setStatus(db: DB, id: string, status: Status): void {
  const result = db
    .prepare("UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now(), id);
  if (result.changes === 0) throw new NotFoundError(`unknown submission '${id}'`);
}

/** Replace the deck or video of the current revision (organizer attach / link fix). */
export function updateArtifact(db: DB, id: string, ref: ArtifactRef): void {
  const { submission } = getSubmission(db, id);
  const updated = { ...submission, [ref.kind]: ref };
  db.prepare("UPDATE submissions SET body = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(updated),
    now(),
    id,
  );
}

/** Persist an evaluation and its status. With expectedStatus, only if the current status still matches. */
export function saveEvaluation(db: DB, evaluation: Evaluation, expectedStatus?: Status): void {
  db.transaction(() => {
    if (expectedStatus !== undefined) {
      const current = getSubmission(db, evaluation.submissionId).status;
      if (current !== expectedStatus) {
        throw new StatusConflict(
          `${evaluation.submissionId}: expected status '${expectedStatus}', found '${current}'`,
        );
      }
    }
    const { status, reviews, ...body } = EvaluationSchema.parse(evaluation);
    db.prepare(
      "INSERT INTO evaluations (submission_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
    ).run(evaluation.submissionId, JSON.stringify(body), now());
    setStatus(db, evaluation.submissionId, status);
  })();
}

export function getEvaluation(db: DB, id: string): Evaluation | null {
  const row = db.prepare("SELECT body FROM evaluations WHERE submission_id = ?").get(id) as
    | { body: string }
    | undefined;
  if (!row) return null;
  const reviews = (
    db.prepare("SELECT body FROM reviews WHERE submission_id = ? ORDER BY id").all(id) as { body: string }[]
  ).map((r) => HumanReviewSchema.parse(JSON.parse(r.body)));
  return EvaluationSchema.parse({ ...JSON.parse(row.body), status: getSubmission(db, id).status, reviews });
}

export function addReview(db: DB, id: string, review: HumanReviewInput): void {
  db.prepare("INSERT INTO reviews (submission_id, body) VALUES (?, ?)").run(
    id,
    JSON.stringify(HumanReviewSchema.parse(review)),
  );
}

export function statusCounts(db: DB, hackathonId: string): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) AS n FROM submissions WHERE hackathon_id = ? AND status != 'superseded' GROUP BY status",
    )
    .all(hackathonId) as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Take (or renew) a run's lease on a submission. False when another live run holds it. */
export function claimSubmission(db: DB, id: string, owner: string, ttlMs: number): boolean {
  const now = Date.now();
  return db.transaction(() => {
    db.prepare("DELETE FROM claims WHERE submission_id = ? AND expires_at < ?").run(id, now);
    const held = db.prepare("SELECT owner FROM claims WHERE submission_id = ?").get(id) as
      | { owner: string }
      | undefined;
    if (held && held.owner !== owner) return false;
    db.prepare(
      "INSERT INTO claims (submission_id, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET expires_at = excluded.expires_at",
    ).run(id, owner, now + ttlMs);
    return true;
  })();
}

export function renewClaims(db: DB, owner: string, ttlMs: number): void {
  db.prepare("UPDATE claims SET expires_at = ? WHERE owner = ?").run(Date.now() + ttlMs, owner);
}

export function releaseClaim(db: DB, id: string, owner: string): void {
  db.prepare("DELETE FROM claims WHERE submission_id = ? AND owner = ?").run(id, owner);
}
