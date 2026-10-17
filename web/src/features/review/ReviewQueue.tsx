/** Work for judges: scored teams to confirm (highest first), then teams blocked on something a person must fix. */
import { IconAlert, IconArrowRight, IconCheckCircle, IconEye } from "@shared/icons";
import { PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, unwrap } from "../../api/client";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { ScoreBar, trackLabel } from "../../shared/Score";
import { StatusPill } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";

const BLOCKED = new Set(["gate_review", "needs_attention", "error"]);

export function ReviewQueue() {
  const hid = useParams().hid ?? "";
  const hackathon = useHackathon(hid);
  const list = useQuery({
    queryKey: ["hackathon", hid, "submissions"],
    queryFn: async () =>
      unwrap(await api.GET("/api/hackathons/{hid}/submissions", { params: { path: { hid }, query: {} } })),
  });
  const rows = list.data ?? [];
  const ready = rows
    .filter((r) => r.status === "needs_review")
    .sort((a, b) => (b.autoScore ?? 0) - (a.autoScore ?? 0));
  const blocked = rows.filter((r) => BLOCKED.has(r.status));

  const row = (r: (typeof rows)[number], showScore: boolean) => (
    <li key={r.id}>
      <Link
        to={`/s/${r.id}`}
        className="hover:bg-aq-zebra flex items-center gap-4 px-4.5 py-3.5 transition-colors"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-aq-md text-aq-ink truncate font-semibold">{r.projectName ?? r.teamName}</span>
          <span className="text-aq-xs text-aq-ink-muted truncate">
            {r.teamName.trim()} · {trackLabel(r.track)}
            {!showScore && r.reasons[0] ? ` · ${r.reasons[0]}` : ""}
          </span>
        </span>
        {showScore && <ScoreBar value={r.autoScore} size="sm" />}
        <StatusPill status={r.status} />
        <span className="text-aq-ink-faint">
          <IconArrowRight size={14} />
        </span>
      </Link>
    </li>
  );

  return (
    <AppShell
      crumbs={[
        { label: "Hackathons", to: "/" },
        { label: hackathon.data?.hackathon.name ?? hid, to: `/h/${hid}` },
        { label: "Review queue" },
      ]}
      hid={hid}
      section="review"
    >
      <PageHeader
        title="Review queue"
        subtitle="Confirm or adjust the AI's scores, highest first. Blocked teams need a fix before they can be scored."
      />
      {list.isLoading ? (
        <PageState state="loading" headline="Loading the queue" />
      ) : (
        <div className="flex flex-col gap-5.5">
          <Panel title="Ready for a judge" icon={IconEye} tone="warn" count={ready.length} flush>
            {ready.length ? (
              <ul className="divide-aq-border divide-y">{ready.map((r) => row(r, true))}</ul>
            ) : (
              <PageState
                state="empty"
                icon={IconCheckCircle}
                headline="Nothing waiting"
                body="Every scored team has a decision."
              />
            )}
          </Panel>
          {blocked.length > 0 && (
            <Panel title="Blocked" icon={IconAlert} tone="bad" count={blocked.length} flush>
              <ul className="divide-aq-border divide-y">{blocked.map((r) => row(r, false))}</ul>
            </Panel>
          )}
        </div>
      )}
    </AppShell>
  );
}
