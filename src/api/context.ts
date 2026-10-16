/** What every route module needs. */
import type { MediaLimits } from "../digest/media";
import type { Settings } from "../settings";
import type { DB } from "../store/db";
import type { RunJobs } from "./jobs";

export interface ApiContext {
  db: DB;
  settings: Settings;
  jobs: RunJobs;
  limits: MediaLimits;
}

export const nowIso = (): string => new Date().toISOString();
