import { IconCheckCircle, IconEye } from "@shared/icons";
import { ListRow, PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, unwrap } from "../../api/client";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { StatusPill } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";

export function ReviewQueue() {
  const hid = useParams().hid ?? "";
  const hackathon = useHackathon(hid);
  const queue = useQuery({
    queryKey: ["hackathon", hid, "queue"],
    queryFn: async () =>
      unwrap(await api.GET("/api/hackathons/{hid}/review-queue", { params: { path: { hid } } })),
  });
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
        subtitle="Submissions waiting for a judge, with the reasons they are waiting."
      />
      <Panel title="Waiting for a judge" icon={IconEye} tone="warn" count={queue.data?.length} flush>
        {queue.isLoading ? (
          <PageState state="loading" headline="Loading the queue" />
        ) : queue.data?.length ? (
          <div className="divide-aq-border divide-y">
            {queue.data.map((item) => (
              <ListRow
                key={item.id}
                asCard={false}
                title={
                  <Link to={`/s/${item.id}`} className="hover:underline">
                    {item.teamName}
                  </Link>
                }
                meta={
                  <span className="flex flex-col gap-0.5 whitespace-normal">
                    {item.reasons.map((r) => (
                      <span key={r}>{r}</span>
                    ))}
                  </span>
                }
                trailing={<StatusPill status={item.status} />}
              />
            ))}
          </div>
        ) : (
          <PageState
            state="empty"
            icon={IconCheckCircle}
            headline="Nothing waiting"
            body="Every submission has a decision."
          />
        )}
      </Panel>
    </AppShell>
  );
}
