/** Hackathon overview: where every team stands, the provisional ranking per track, and what needs a person. */
import {
  IconAlert,
  IconArrowRight,
  IconChart,
  IconCpu,
  IconPlay,
  IconScroll,
  IconUpload,
} from "@shared/icons";
import { Banner, Button, Chip, Collapsible, FormField, PageState } from "@shared/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, unwrap } from "../../api/client";
import { codeAreaClass, fileClass } from "../../shared/fields";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { ScoreBar, trackLabel } from "../../shared/Score";
import { StatCell } from "../../shared/StatCell";
import { StatusPill } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { FormSyncPanel } from "./FormSyncPanel";
import { RunPanel } from "./RunPanel";
import { useHackathon } from "./useHackathon";

const compact = (n: number) => n.toLocaleString();
const PROBLEMS = new Set(["needs_attention", "error", "gate_review", "disqualified"]);

function deadlineText(deadline: string | null, now = Date.now()): string {
  if (!deadline) return "No deadline set";
  const at = new Date(deadline);
  const when = at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const left = at.getTime() - now;
  if (left <= 0) return `Submissions closed ${when}`;
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  return `Submissions close ${when} · ${days ? `${days}d ` : ""}${hours}h left`;
}

export function Dashboard() {
  const hid = useParams().hid ?? "";
  const detail = useHackathon(hid);
  const navigate = useNavigate();
  const [yaml, setYaml] = useState("");
  const [rubricOpen, setRubricOpen] = useState(false);
  const queryClient = useQueryClient();
  const subs = useQuery({
    queryKey: ["hackathon", hid, "submissions"],
    queryFn: async () =>
      unwrap(await api.GET("/api/hackathons/{hid}/submissions", { params: { path: { hid }, query: {} } })),
  });
  const upload = useMutation({
    mutationFn: async () =>
      unwrap(await api.PUT("/api/hackathons/{hid}/rubric", { params: { path: { hid } }, body: { yaml } })),
    onSuccess: () => {
      setYaml("");
      void queryClient.invalidateQueries();
    },
  });
  const crumbs = [{ label: "Hackathons", to: "/" }, { label: detail.data?.hackathon.name ?? hid }];

  if (detail.isError)
    return (
      <AppShell crumbs={crumbs} hid={hid} section="dashboard">
        <PageState state="error" headline="Could not load this hackathon" body={detail.error.message} />
      </AppShell>
    );
  if (!detail.data)
    return (
      <AppShell crumbs={crumbs} hid={hid} section="dashboard">
        <PageState state="loading" headline="Loading" />
      </AppShell>
    );
  const { hackathon, rubric, byStatus, usage } = detail.data;
  const rows = subs.data ?? [];
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const passedGate = rows.filter((r) => r.checks.find((c) => c.id === "sdk")?.state === "pass").length;
  const scored = rows.filter((r) => r.autoScore !== null).length;
  const problems = rows.filter((r) => PROBLEMS.has(r.status));
  const tracks = [...new Set([...(rubric?.tracks ?? []), ...rows.map((r) => r.track ?? "")])].filter(Boolean);
  const weightSum = rubric?.criteria.reduce((a, c) => a + c.weight, 0) ?? 1;

  return (
    <AppShell crumbs={crumbs} hid={hid} section="dashboard">
      <PageHeader
        title={hackathon.name}
        subtitle={deadlineText(hackathon.deadline)}
        actions={
          <Button variant="secondary" leading={IconUpload} onClick={() => navigate(`/h/${hid}/import`)}>
            Import submissions
          </Button>
        }
      />
      <div className="flex flex-col gap-5.5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[
            { label: "Submissions", value: total, hint: "imported from the form" },
            { label: "Passed SDK gate", value: passedGate, hint: "ArmorIQ installed and called" },
            { label: "Scored by AI", value: scored, hint: `of ${passedGate} eligible` },
            { label: "Awaiting a judge", value: byStatus.needs_review ?? 0, hint: "confirm or adjust" },
            { label: "Finalized", value: byStatus.finalized ?? 0, hint: "on the leaderboard" },
            {
              label: "Need attention",
              value: problems.length,
              hint: `${byStatus.disqualified ?? 0} disqualified`,
            },
          ].map((k) => (
            <div
              key={k.label}
              className="bg-aq-surface border-aq-border shadow-aq-card rounded-lg border p-4"
            >
              <StatCell label={k.label} value={k.value} hint={k.hint} />
            </div>
          ))}
        </div>

        <div className="grid items-start gap-5.5 lg:grid-cols-2">
          {(tracks.length ? tracks : [""]).map((track) => {
            const ranked = rows
              .filter((r) => (r.track ?? "") === track && r.autoScore !== null && r.status !== "disqualified")
              .sort((a, b) => (b.finalScore ?? b.autoScore ?? 0) - (a.finalScore ?? a.autoScore ?? 0))
              .slice(0, 5);
            return (
              <Panel
                key={track}
                title={track ? `${trackLabel(track)} track` : "Ranking"}
                icon={IconChart}
                tone={track === "elevenlabs" ? "info" : "accent"}
                count={rows.filter((r) => (r.track ?? "") === track).length}
                action="Leaderboard"
                onAction={() => navigate(`/h/${hid}/leaderboard`)}
                flush
              >
                {ranked.length ? (
                  <ol className="divide-aq-border divide-y">
                    {ranked.map((r, i) => (
                      <li key={r.id}>
                        <Link
                          to={`/s/${r.id}`}
                          className="hover:bg-aq-zebra flex items-center gap-3 px-4.5 py-3 transition-colors"
                        >
                          <span
                            className={`text-aq-sm flex size-7 shrink-0 items-center justify-center rounded-md font-mono font-semibold ${i === 0 ? "bg-aq-accent text-aq-ink-on" : "bg-aq-zebra text-aq-ink"}`}
                          >
                            {i + 1}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="text-aq-sm text-aq-ink truncate font-semibold">
                              {r.projectName ?? r.teamName}
                            </span>
                            <span className="text-aq-xs text-aq-ink-muted truncate">{r.teamName.trim()}</span>
                          </span>
                          <ScoreBar
                            value={r.finalScore ?? r.autoScore}
                            tone={r.finalScore !== null ? "good" : "accent"}
                            size="sm"
                          />
                        </Link>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-aq-sm text-aq-ink-muted px-4.5 py-4">
                    No scored teams in this track yet.
                  </p>
                )}
                <p className="text-aq-xs text-aq-ink-faint border-aq-border border-t px-4.5 py-2.5">
                  Provisional: AI scores until a judge confirms them.
                </p>
              </Panel>
            );
          })}
        </div>

        <div className="grid items-start gap-5.5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-5.5">
            <Panel
              title="Run the judging pipeline"
              icon={IconPlay}
              tone="accent"
              count={rows.filter((r) => r.status === "scoring" || r.status === "stale").length}
            >
              <p className="text-aq-sm text-aq-ink-muted mb-4">
                1. SDK gate: disqualifies teams without ArmorIQ (new teams are checked automatically). 2. AI
                scoring, one team at a time: watches the video, checks the live demo, reads the code and the
                form, then cuts points for missing requirements. 3. A judge confirms every score.
              </p>
              {rubric ? (
                <RunPanel hid={hid} />
              ) : (
                <Banner tone="info">Activate a rubric before running the pipeline.</Banner>
              )}
            </Panel>

            <Panel
              title="Needs attention"
              icon={IconAlert}
              tone="warn"
              count={problems.length}
              action={problems.length ? "Review queue" : undefined}
              onAction={() => navigate(`/h/${hid}/review`)}
              flush
            >
              {problems.length ? (
                <ul className="divide-aq-border divide-y">
                  {problems.map((r) => (
                    <li key={r.id}>
                      <Link
                        to={`/s/${r.id}`}
                        className="hover:bg-aq-zebra flex items-start gap-3 px-4.5 py-3 transition-colors"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-aq-sm text-aq-ink font-semibold">
                            {r.projectName ?? r.teamName}
                          </span>
                          <span className="text-aq-xs text-aq-ink-muted line-clamp-2">{r.reasons[0]}</span>
                        </span>
                        <StatusPill status={r.status} />
                        <span className="text-aq-ink-faint mt-0.5">
                          <IconArrowRight size={14} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-aq-sm text-aq-ink-muted px-4.5 py-4">Nothing needs attention.</p>
              )}
            </Panel>
          </div>

          <div className="flex flex-col gap-5.5">
            <FormSyncPanel hid={hid} />

            <Panel title="Rubric" icon={IconScroll} count={rubric?.criteria.length}>
              {rubric ? (
                <ul className="mb-4 flex flex-col gap-3">
                  {rubric.criteria.map((c) => {
                    const pts = Math.round((100 * c.weight) / weightSum);
                    return (
                      <li key={c.id} className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-3">
                          <span className="text-aq-sm text-aq-ink font-medium">{c.name}</span>
                          <Chip size="sm">{pts} pts</Chip>
                        </span>
                        <span className="bg-aq-zebra h-1 overflow-hidden rounded-full" aria-hidden="true">
                          <span className="bg-aq-accent block h-full" style={{ width: `${pts}%` }} />
                        </span>
                        <span className="text-aq-xs text-aq-ink-muted">{c.description}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-aq-sm text-aq-ink-muted mb-4">No active rubric.</p>
              )}
              <Button variant="tertiary" size="sm" onClick={() => setRubricOpen((o) => !o)}>
                {rubricOpen ? "Hide rubric upload" : "Replace the rubric"}
              </Button>
              <Collapsible open={rubricOpen}>
                <div className="mt-3 flex flex-col gap-3">
                  <FormField
                    label="Upload a rubric YAML"
                    htmlFor="rubric-file"
                    helper="A new version marks scored results stale so they are re-scored."
                  >
                    <input
                      id="rubric-file"
                      type="file"
                      accept=".yaml,.yml"
                      className={fileClass}
                      onChange={async (e) => setYaml((await e.target.files?.[0]?.text()) ?? "")}
                    />
                  </FormField>
                  <FormField label="Or paste it" htmlFor="rubric-yaml">
                    <textarea
                      id="rubric-yaml"
                      rows={5}
                      className={codeAreaClass}
                      value={yaml}
                      onChange={(e) => setYaml(e.target.value)}
                    />
                  </FormField>
                  {upload.isError && <Banner tone="bad">{upload.error.message}</Banner>}
                  {upload.isSuccess && (
                    <Banner tone="good">
                      Activated {upload.data.id} v{upload.data.version}
                      {upload.data.staled ? ` — ${upload.data.staled} result(s) marked stale` : ""}
                    </Banner>
                  )}
                  <div>
                    <Button
                      variant="secondary"
                      disabled={!yaml}
                      loading={upload.isPending}
                      onClick={() => upload.mutate()}
                    >
                      Activate rubric
                    </Button>
                  </div>
                </div>
              </Collapsible>
            </Panel>

            <Panel title="AI usage" icon={IconCpu} tone="info">
              <p className="text-aq-sm text-aq-ink-soft">
                {usage.usage.llmCalls + usage.usage.jevCalls === 0
                  ? "No model calls yet."
                  : `${compact(usage.usage.llmCalls)} AI calls · ${compact(usage.usage.inputTokens + usage.usage.outputTokens)} tokens`}
                {usage.estimatedCostUsd !== null && usage.usage.llmCalls > 0
                  ? ` · about $${usage.estimatedCostUsd.toFixed(2)}`
                  : ""}
              </p>
              {usage.unpriced.length > 0 && usage.usage.llmCalls + usage.usage.jevCalls > 0 && (
                <p className="text-aq-xs text-aq-ink-muted mt-1">
                  Add prices for {usage.unpriced.join(", ")} in config/models.yaml to see cost.
                </p>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
