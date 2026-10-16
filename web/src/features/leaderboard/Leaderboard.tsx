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
        subtitle="Finalized results under the active rubric. A judge's override beats the auto score."
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
      <Panel title="Ranking" icon={IconChart} tone="good" count={rows.data?.length} flush>
        {rows.isLoading ? (
          <PageState state="loading" headline="Loading the leaderboard" />
        ) : rows.data?.length ? (
          <div className="divide-aq-border divide-y">
            {rows.data.map((r) => (
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
        ) : (
          <PageState state="empty" icon={IconChart} headline="No finalized submissions yet" />
        )}
      </Panel>
    </AppShell>
  );
}
