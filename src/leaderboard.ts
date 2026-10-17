/**
 * Leaderboard over finalized submissions (a human override beats the auto score). Each track (e.g. the ElevenLabs
 * prize) is ranked on its own; submissions without a track form one group.
 */
import type { DB } from "./store/db";
import * as q from "./store/queries";

export interface LeaderboardRow {
  /** Rank within the row's track. */
  rank: number;
  track: string | null;
  submissionId: string;
  teamName: string;
  finalScore: number;
  autoScore: number | null;
  overridden: boolean;
}

export function buildLeaderboard(db: DB, hackathonId: string): LeaderboardRow[] {
  const entries: Omit<LeaderboardRow, "rank">[] = [];
  // The leaderboard is per rubric version: only results scored under the active one are ranked.
  const { activeRubricId, activeRubricVersion } = q.getHackathon(db, hackathonId);
  for (const record of q.currentSubmissions(db, hackathonId, ["finalized"])) {
    const evaluation = q.getEvaluation(db, record.submission.id);
    if (!evaluation || evaluation.finalScore === null) continue;
    if (evaluation.rubricId !== activeRubricId || evaluation.rubricVersion !== activeRubricVersion) continue;
    entries.push({
      track: record.submission.track,
      submissionId: record.submission.id,
      teamName: record.submission.teamName,
      finalScore: evaluation.finalScore,
      autoScore: evaluation.autoScore,
      overridden: evaluation.reviews.some((r) => r.decision === "override"),
    });
  }
  entries.sort(
    (a, b) =>
      (a.track ?? "").localeCompare(b.track ?? "") ||
      b.finalScore - a.finalScore ||
      a.teamName.toLowerCase().localeCompare(b.teamName.toLowerCase()),
  );
  const rows: LeaderboardRow[] = [];
  let position = 0;
  for (const entry of entries) {
    const previous = rows.at(-1);
    const sameTrack = previous !== undefined && previous.track === entry.track;
    position = sameTrack ? position + 1 : 1;
    // Competition ranking within a track: equal scores share a rank (1, 2, 2, 4).
    const rank = sameTrack && previous.finalScore === entry.finalScore ? previous.rank : position;
    rows.push({ rank, ...entry });
  }
  return rows;
}

export function leaderboardCsv(rows: LeaderboardRow[]): string {
  const header = ["rank", "submission_id", "team_name", "final_score", "auto_score", "overridden", "track"];
  const lines = rows.map((r) =>
    [
      r.rank,
      r.submissionId,
      r.teamName,
      r.finalScore,
      r.autoScore ?? "",
      r.overridden ? "True" : "False",
      r.track ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header.join(","), ...lines].join("\n")}\n`;
}

/** Quote when needed, and prefix text a spreadsheet would run as a formula (CSV injection via team names). */
function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
