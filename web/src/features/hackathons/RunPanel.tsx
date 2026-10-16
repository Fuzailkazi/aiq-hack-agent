/** Start a pipeline run and follow it until it finishes. */
import { IconPlay, IconRefresh } from "@shared/icons";
import { Banner, Button, StatusBadge } from "@shared/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type RunJob, unwrap } from "../../api/client";

export function RunPanel({ hid }: { hid: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: async (body: { phase: "gate" | "score" | "all"; retry?: boolean }) =>
      unwrap(await api.POST("/api/hackathons/{hid}/runs", { params: { path: { hid } }, body })),
    onSuccess: (job) => setRunId(job.id),
  });
  const run = useQuery({
    queryKey: ["run", runId],
    enabled: runId !== null,
    queryFn: async (): Promise<RunJob> => {
      const job = unwrap(await api.GET("/api/runs/{runId}", { params: { path: { runId: runId ?? "" } } }));
      if (job.state !== "running") void queryClient.invalidateQueries({ queryKey: ["hackathon", hid] });
      return job;
    },
    refetchInterval: (q) => (q.state.data?.state === "running" || !q.state.data ? 1000 : false),
  });
  const job = run.data;
  const running = job?.state === "running" || start.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          leading={IconPlay}
          loading={running}
          onClick={() => start.mutate({ phase: "all" })}
        >
          Run everything
        </Button>
        <Button variant="secondary" disabled={running} onClick={() => start.mutate({ phase: "gate" })}>
          Gate only
        </Button>
        <Button variant="secondary" disabled={running} onClick={() => start.mutate({ phase: "score" })}>
          Score only
        </Button>
        <Button
          variant="tertiary"
          leading={IconRefresh}
          disabled={running}
          onClick={() => start.mutate({ phase: "all", retry: true })}
        >
          Retry errors
        </Button>
      </div>
      {start.isError && <Banner tone="bad">{start.error.message}</Banner>}
      {job && (
        <div className="flex flex-wrap items-center gap-2.5">
          {job.state === "running" && <StatusBadge tone="info" label="Running" shimmer />}
          {job.state === "done" && <StatusBadge tone="good" label="Run done" />}
          {job.state === "failed" && <StatusBadge tone="bad" label="Run failed" />}
          {job.report && (
            <span className="text-aq-sm text-aq-ink-muted">
              processed {job.report.processed}
              {Object.entries(job.report.byStatus).map(([s, n]) => ` · ${s.replace("_", " ")} ${n}`)}
            </span>
          )}
        </div>
      )}
      {job?.error && <Banner tone="bad">{job.error}</Banner>}
      {job?.report?.errors.length ? (
        <Banner tone="warn">
          <ul className="flex flex-col gap-1">
            {job.report.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  );
}
