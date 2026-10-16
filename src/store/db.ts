/** SQLite database (WAL). Records are stored as JSON of the Zod schemas plus a few indexed columns. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hackathons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deadline TEXT,
  active_rubric_id TEXT,
  active_rubric_version TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rubrics (
  hackathon_id TEXT NOT NULL REFERENCES hackathons(id),
  rubric_id TEXT NOT NULL,
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (hackathon_id, rubric_id, version)
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  hackathon_id TEXT NOT NULL REFERENCES hackathons(id),
  natural_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (hackathon_id, natural_key, revision)
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions (hackathon_id, status);
CREATE TABLE IF NOT EXISTS evaluations (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  body TEXT NOT NULL
);
-- A run's lease on a submission it is processing (CLI and server may run at once); renewed while held.
CREATE TABLE IF NOT EXISTS claims (
  submission_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
