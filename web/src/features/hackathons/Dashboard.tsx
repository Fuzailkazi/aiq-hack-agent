import { IconCpu, IconGauge, IconPlay, IconScroll, IconUpload } from "@shared/icons";
import { Banner, Button, Chip, FormField, ListRow, PageState } from "@shared/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, type Status, unwrap } from "../../api/client";
import { codeAreaClass, fileClass } from "../../shared/fields";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { StatCell, StatGrid } from "../../shared/StatCell";
import { STATUS } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { RunPanel } from "./RunPanel";
import { useHackathon } from "./useHackathon";

const SHOWN: Status[] = ["finalized", "needs_review", "gate_review", "needs_attention", "disqualified"];
const compact = (n: number) => n.toLocaleString();

export function Dashboard() {
  const hid = useParams().hid ?? "";
  const detail = useHackathon(hid);
  const navigate = useNavigate();
  const [yaml, setYaml] = useState("");
  const queryClient = useQueryClient();
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
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return (
    <AppShell crumbs={crumbs} hid={hid} section="dashboard">
      <PageHeader
        title={hackathon.name}
        subtitle={
          hackathon.deadline
            ? `Submissions close ${new Date(hackathon.deadline).toLocaleString()}`
            : "No deadline set"
        }
        actions={
          <Button variant="secondary" leading={IconUpload} onClick={() => navigate(`/h/${hid}/import`)}>
            Add submissions
          </Button>
        }
      />
      <div className="flex flex-col gap-5.5">
        <Panel title="Submissions" icon={IconGauge}>
          <StatGrid>
            <StatCell label="Total" value={total} />
            {SHOWN.map((s) => (
              <StatCell key={s} label={STATUS[s].label} value={byStatus[s] ?? 0} />
            ))}
          </StatGrid>
        </Panel>

        <Panel title="Run the pipeline" icon={IconPlay} tone="accent">
          {rubric ? (
            <RunPanel hid={hid} />
          ) : (
            <Banner tone="info">Activate a rubric below before running the pipeline.</Banner>
          )}
        </Panel>

        <div className="grid items-start gap-5.5 lg:grid-cols-2">
          <Panel title="Model usage" icon={IconCpu} tone="info">
            <div className="grid grid-cols-2 gap-5.5">
              <StatCell label="LLM calls" value={usage.usage.llmCalls} format={compact} />
              <StatCell label="Jev calls" value={usage.usage.jevCalls} format={compact} />
              <StatCell label="Tokens in" value={usage.usage.inputTokens} format={compact} />
              <StatCell label="Tokens out" value={usage.usage.outputTokens} format={compact} />
            </div>
            <div className="mt-4.5">
              {usage.usage.llmCalls + usage.usage.jevCalls === 0 ? (
                <p className="text-aq-sm text-aq-ink-muted">No model calls yet.</p>
              ) : usage.estimatedCostUsd !== null ? (
                <Banner tone="good">
                  Estimated ${usage.estimatedCostUsd.toFixed(2)} (${usage.costPerSubmissionUsd?.toFixed(4)}{" "}
                  per submission)
                </Banner>
              ) : usage.unpriced.length ? (
                <Banner tone="info">
                  Add prices for {usage.unpriced.join(", ")} in config/models.yaml to see cost.
                </Banner>
              ) : null}
            </div>
          </Panel>

          <Panel title="Rubric" icon={IconScroll} tone="neutral" count={rubric?.criteria.length}>
            {rubric ? (
              <div className="divide-aq-border mb-4.5 divide-y">
                {rubric.criteria.map((c) => (
                  <ListRow
                    key={c.id}
                    asCard={false}
                    density="compact"
                    title={c.name}
                    meta={`${c.sources.join(", ")} · ${c.levels.length} levels`}
                    trailing={<Chip size="sm">weight {c.weight}</Chip>}
                  />
                ))}
              </div>
            ) : (
              <p className="text-aq-sm text-aq-ink-muted mb-4.5">No active rubric.</p>
            )}
            <div className="flex flex-col gap-3">
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
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
