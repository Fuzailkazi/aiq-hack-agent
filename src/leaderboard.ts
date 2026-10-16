/** Leaderboard over finalized submissions (a human override beats the auto score). */
import type { DB } from "./store/db";
import * as q from "./store/queries";

export interface LeaderboardRow {
  rank: number;
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
      submissionId: record.submission.id,
      teamName: record.submission.teamName,
      finalScore: evaluation.finalScore,
      autoScore: evaluation.autoScore,
      overridden: evaluation.reviews.some((r) => r.decision === "override"),
    });
  }
  entries.sort(
    (a, b) => b.finalScore - a.finalScore || a.teamName.toLowerCase().localeCompare(b.teamName.toLowerCase()),
  );
  const rows: LeaderboardRow[] = [];
  entries.forEach((entry, i) => {
    const previous = rows.at(-1);
    // Competition ranking: equal scores share a rank (1, 2, 2, 4).
    const rank = previous && previous.finalScore === entry.finalScore ? previous.rank : i + 1;
    rows.push({ rank, ...entry });
  });
  return rows;
}

export function leaderboardCsv(rows: LeaderboardRow[]): string {
  const header = ["rank", "submission_id", "team_name", "final_score", "auto_score", "overridden"];
  const lines = rows.map((r) =>
    [r.rank, r.submissionId, r.teamName, r.finalScore, r.autoScore ?? "", r.overridden ? "True" : "False"]
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
