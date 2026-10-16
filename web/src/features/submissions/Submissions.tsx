import { IconRows } from "@shared/icons";
import { ListRow, ListToolbar, PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api, type Status, unwrap } from "../../api/client";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { pct, STATUS, StatusPill, score } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";

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
      (!q || s.teamName.toLowerCase().includes(q) || s.repoUrl.toLowerCase().includes(q)),
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
      <PageHeader title="Submissions" subtitle="Every team, where it is in the pipeline, and its scores." />
      <div className="mb-4">
        <ListToolbar
          tabs={{
            items: tabs,
            value: tab,
            onChange: (v) => setParams(v === "all" ? {} : { status: v }),
            ariaLabel: "Status",
          }}
          search={{ value: query, onChange: setQuery, placeholder: "Search team or repository" }}
          count={{ shown: shown.length, total: all.length, noun: "submissions" }}
        />
      </div>
      <Panel flush>
        {list.isLoading ? (
          <PageState state="loading" headline="Loading submissions" />
        ) : shown.length ? (
          <div className="divide-aq-border divide-y">
            {shown.map((s) => (
              <ListRow
                key={s.id}
                asCard={false}
                title={
                  <Link to={`/s/${s.id}`} className="hover:underline">
                    {s.teamName}
                  </Link>
                }
                meta={
                  <span className="font-mono">
                    {s.repoUrl.replace(/^https:\/\//, "")}
                    {s.track ? ` · ${s.track}` : ""}
                  </span>
                }
                trailing={
                  <span className="flex items-center gap-4">
                    {s.autoScore !== null && (
                      <span className="text-aq-xs text-aq-ink-muted hidden font-mono sm:inline">
                        auto {score(s.autoScore)} · final {score(s.finalScore)} · conf {pct(s.confidence)}
                      </span>
                    )}
                    <StatusPill status={s.status} />
                  </span>
                }
              />
            ))}
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
