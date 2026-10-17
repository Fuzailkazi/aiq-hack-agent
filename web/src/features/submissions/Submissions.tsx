import { IconRows } from "@shared/icons";
import { Chip, ListToolbar, PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api, type Status, unwrap } from "../../api/client";
import { CheckDots } from "../../shared/Checks";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { ScoreBar, trackLabel } from "../../shared/Score";
import { STATUS, StatusPill } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";

const GRID = "md:grid-cols-[minmax(0,2.2fr)_7rem_8rem_9rem_minmax(0,1.6fr)] md:items-center md:gap-x-5";

export function Submissions() {
  const hid = useParams().hid ?? "";
  const hackathon = useHackathon(hid);
  const [params, setParams] = useSearchParams();
  const tab = params.get("status") || "all";
  const [query, setQuery] = useState("");
  const list = useQuery({
    queryKey: ["hackathon", hid, "submissions"],
    queryFn: async () =>
      unwrap(await api.GET("/api/hackathons/{hid}/submissions", { params: { path: { hid }, query: {} } })),
  });
  const all = list.data ?? [];
  const counts: Record<string, number> = {};
  for (const s of all) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const tabs = [
    { key: "all", label: "All", count: all.length },
    ...(Object.keys(STATUS) as Status[])
      .filter((s) => counts[s])
      .map((s) => ({ key: s, label: STATUS[s].label, count: counts[s] })),
  ];
  const q = query.trim().toLowerCase();
  const shown = all.filter(
    (s) =>
      (tab === "all" || s.status === tab) &&
      (!q ||
        s.teamName.toLowerCase().includes(q) ||
        (s.projectName ?? "").toLowerCase().includes(q) ||
        s.repoUrl.toLowerCase().includes(q)),
  );

  return (
    <AppShell
      crumbs={[
        { label: "Hackathons", to: "/" },
        { label: hackathon.data?.hackathon.name ?? hid, to: `/h/${hid}` },
        { label: "Submissions" },
      ]}
      hid={hid}
      section="submissions"
    >
      <PageHeader
        title="Submissions"
        subtitle="Every team, whether it meets the requirements, its AI score, and what happens next."
      />
      <div className="mb-4">
        <ListToolbar
          tabs={{
            items: tabs,
            value: tab,
            onChange: (v) => setParams(v === "all" ? {} : { status: v }),
            ariaLabel: "Status",
          }}
          search={{ value: query, onChange: setQuery, placeholder: "Search project, team or repository" }}
          count={{ shown: shown.length, total: all.length, noun: "submissions" }}
        />
      </div>
      <Panel flush>
        {list.isLoading ? (
          <PageState state="loading" headline="Loading submissions" />
        ) : shown.length ? (
          <div>
            <div
              aria-hidden="true"
              className={`${GRID} border-aq-border text-aq-caption tracking-aq-widest text-aq-ink-muted hidden border-b px-4.5 py-2.5 font-medium uppercase md:grid`}
            >
              <span>Project</span>
              <span>Track</span>
              <span>Requirements</span>
              <span>AI score</span>
              <span>Status</span>
            </div>
            <div className="divide-aq-border divide-y">
              {shown.map((s) => (
                <Link
                  key={s.id}
                  to={`/s/${s.id}`}
                  className={`${GRID} hover:bg-aq-zebra grid gap-y-2 px-4.5 py-3.5 transition-colors`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-aq-md text-aq-ink truncate font-semibold">
                      {s.projectName ?? s.teamName}
                    </span>
                    <span className="text-aq-xs text-aq-ink-muted truncate">
                      {s.projectName ? `${s.teamName.trim()} · ` : ""}
                      {s.repoUrl.replace(/^https:\/\/(www\.)?github\.com\//, "")}
                    </span>
                  </span>
                  <span>
                    <Chip size="sm" tone={s.track === "elevenlabs" ? "info" : "neutral"}>
                      {trackLabel(s.track)}
                    </Chip>
                  </span>
                  <span>
                    <CheckDots checks={s.checks} />
                  </span>
                  <span>
                    {s.finalScore !== null ? (
                      <ScoreBar value={s.finalScore} tone="good" size="sm" />
                    ) : s.autoScore !== null ? (
                      <ScoreBar value={s.autoScore} size="sm" />
                    ) : (
                      <span className="text-aq-xs text-aq-ink-faint">Not scored</span>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col items-start gap-1">
                    <StatusPill status={s.status} />
                    {s.reasons.length > 0 && (
                      <span
                        className={`text-aq-xs line-clamp-2 ${STATUS[s.status].tone === "bad" ? "text-aq-bad" : "text-aq-ink-muted"}`}
                        data-testid={`reason-${s.id}`}
                      >
                        {s.reasons[0]}
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <PageState
            state="empty"
            icon={IconRows}
            headline="Nothing here"
            body="No submissions match this view."
          />
        )}
      </Panel>
    </AppShell>
  );
}
