import { IconChart, IconDownload } from "@shared/icons";
import { Button, Chip, ListRow, PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, unwrap } from "../../api/client";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { score } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";

type Row = { track: string | null; submissionId: string };

/** Rows arrive sorted by track; each track (e.g. the ElevenLabs prize) is ranked and shown on its own. */
function byTrack<R extends Row>(rows: R[]): [string | null, R[]][] {
  const groups: [string | null, R[]][] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last[0] === row.track) last[1].push(row);
    else groups.push([row.track, [row]]);
  }
  return groups;
}

export function Leaderboard() {
  const hid = useParams().hid ?? "";
  const hackathon = useHackathon(hid);
  const rows = useQuery({
    queryKey: ["hackathon", hid, "leaderboard"],
    queryFn: async () =>
      unwrap(await api.GET("/api/hackathons/{hid}/leaderboard", { params: { path: { hid } } })),
  });
  return (
    <AppShell
      crumbs={[
        { label: "Hackathons", to: "/" },
        { label: hackathon.data?.hackathon.name ?? hid, to: `/h/${hid}` },
        { label: "Leaderboard" },
      ]}
      hid={hid}
      section="leaderboard"
    >
      <PageHeader
        title="Leaderboard"
        subtitle="Finalized results under the active rubric, ranked per track. A judge's override beats the auto score."
        actions={
          <Button
            variant="secondary"
            leading={IconDownload}
            onClick={() =>
              window.location.assign(`/api/hackathons/${encodeURIComponent(hid)}/leaderboard.csv`)
            }
          >
            Download CSV
          </Button>
        }
      />
      {rows.isLoading ? (
        <Panel title="Ranking" icon={IconChart} tone="good" flush>
          <PageState state="loading" headline="Loading the leaderboard" />
        </Panel>
      ) : rows.data?.length ? (
        byTrack(rows.data).map(([track, trackRows]) => (
          <Panel
            key={track ?? ""}
            title={track ? `Track: ${track}` : "Ranking"}
            icon={IconChart}
            tone="good"
            count={trackRows.length}
            flush
          >
            <div className="divide-aq-border divide-y">
              {trackRows.map((r) => (
                <ListRow
                  key={r.submissionId}
                  asCard={false}
                  leading={
                    <span className="bg-aq-zebra text-aq-ink text-aq-sm flex size-8 items-center justify-center rounded-md font-mono font-semibold">
                      {r.rank}
                    </span>
                  }
                  title={
                    <Link to={`/s/${r.submissionId}`} className="hover:underline">
                      {r.teamName}
                    </Link>
                  }
                  meta={`auto score ${score(r.autoScore)}`}
                  trailing={
                    <span className="flex items-center gap-3">
                      {r.overridden && (
                        <Chip size="sm" tone="info">
                          Judge override
                        </Chip>
                      )}
                      <span className="text-aq-stat tracking-aq-tight text-aq-ink font-mono font-medium">
                        {r.finalScore.toFixed(2)}
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          </Panel>
        ))
      ) : (
        <Panel title="Ranking" icon={IconChart} tone="good" flush>
          <PageState state="empty" icon={IconChart} headline="No finalized submissions yet" />
        </Panel>
      )}
    </AppShell>
  );
}
