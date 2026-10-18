/**
 * Start a pipeline run and follow it until it finishes. Scoring goes one team at a time ("Score next team", or
 * "Score this team" on a team's page) so judges can follow each result and model quota is spent deliberately.
 */
import { IconPlay } from "@shared/icons";
import { Banner, Button, StatusBadge } from "@shared/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type RunJob, unwrap } from "../../api/client";

export function RunPanel({ hid, submissionId }: { hid: string; submissionId?: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: async (body: {
      phase: "gate" | "score" | "all";
      retry?: boolean;
      only?: string[];
      limit?: number;
    }) => unwrap(await api.POST("/api/hackathons/{hid}/runs", { params: { path: { hid } }, body })),
    onSuccess: (job) => setRunId(job.id),
  });
  const run = useQuery({
    queryKey: ["run", runId],
    enabled: runId !== null,
    queryFn: async (): Promise<RunJob> => {
      const job = unwrap(await api.GET("/api/runs/{runId}", { params: { path: { runId: runId ?? "" } } }));
      if (job.state !== "running") {
        void queryClient.invalidateQueries({ queryKey: ["hackathon", hid] });
        if (submissionId) void queryClient.invalidateQueries({ queryKey: ["submission", submissionId] });
      }
      return job;
    },
    refetchInterval: (q) => (q.state.data?.state === "running" || !q.state.data ? 1000 : false),
  });
  const job = run.data;
  const running = job?.state === "running" || start.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {submissionId ? (
          <Button
            variant="primary"
            leading={IconPlay}
            loading={running}
            onClick={() => start.mutate({ phase: "score", only: [submissionId], retry: true })}
          >
            Score this team
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              leading={IconPlay}
              loading={running}
              onClick={() => start.mutate({ phase: "score", limit: 1 })}
            >
              Score next team
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => start.mutate({ phase: "gate" })}>
              Check new teams (SDK gate)
            </Button>
          </>
        )}
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
