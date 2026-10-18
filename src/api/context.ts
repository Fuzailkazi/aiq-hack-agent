/** What every route module needs. */
import type { MediaLimits } from "../digest/media";
import type { Settings } from "../settings";
import type { DB } from "../store/db";
import type { SheetSync } from "../sync";
import type { RunJobs } from "./jobs";

export interface ApiContext {
  db: DB;
  settings: Settings;
  jobs: RunJobs;
  limits: MediaLimits;
  /** The form sync, when HACKEVAL_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_FILE and HACKEVAL_HACKATHON are set. */
  sync: SheetSync | null;
}

export const nowIso = (): string => new Date().toISOString();
