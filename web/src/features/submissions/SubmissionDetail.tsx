import { IconAlert, IconFile, IconHistory, IconScroll, IconShieldCheck, IconUpload } from "@shared/icons";
import { Banner, Chip, ListRow, PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { api, unwrap } from "../../api/client";
import type { Focus } from "../../shared/citations";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { StatCell } from "../../shared/StatCell";
import { StatusPill } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";
import { AttachForm } from "./AttachForm";
import { EvidenceViewer } from "./EvidenceViewer";
import { DECISIONS, ReviewForm } from "./ReviewForm";
import { ScorecardTable } from "./ScorecardTable";

const GATE_TONE = { pass: "good", fail: "bad", review: "warn", needs_attention: "warn" } as const;
const CHECK_LABEL: Record<string, string> = {
  sdkInstalled: "SDK installed",
  sdkCalledInAppCode: "SDK called in app code",
  envApiKeyPresent: "API key in env (optional)",
};

export function SubmissionDetail() {
  const id = useParams().id ?? "";
  const detail = useQuery({
    queryKey: ["submission", id],
    queryFn: async () => unwrap(await api.GET("/api/submissions/{id}", { params: { path: { id } } })),
  });
  const hid = detail.data?.submission.hackathonId ?? "";
  const hackathon = useHackathon(hid);
  const [focus, setFocus] = useState<Focus>({ kind: "none" });
  const crumbs = [
    { label: "Hackathons", to: "/" },
    { label: hackathon.data?.hackathon.name ?? hid, to: `/h/${hid}` },
    { label: "Submissions", to: `/h/${hid}/submissions` },
    { label: detail.data?.submission.teamName ?? "…" },
  ];

  if (detail.isError)
    return (
      <AppShell crumbs={crumbs}>
        <PageState state="error" headline="Could not load this submission" body={detail.error.message} />
      </AppShell>
    );
  if (!detail.data)
    return (
      <AppShell crumbs={crumbs}>
        <PageState state="loading" headline="Loading" />
      </AppShell>
    );

  const { submission, status, evaluation } = detail.data;
  const rubric = hackathon.data?.rubric ?? null;
  const gate = evaluation?.gate;
  const calibration = evaluation?.calibration;
  const reviewable = (DECISIONS[status] ?? []).length > 0;
  const unreachable = Object.entries(evaluation?.mediaUnreachable ?? {});

  return (
    <AppShell crumbs={crumbs} hid={hid} section="submissions">
      <PageHeader
        title={
          <>
            {submission.teamName} <StatusPill status={status} />
          </>
        }
        subtitle={
          <>
            <a
              className="font-mono hover:underline"
              href={submission.repoUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {submission.repoUrl.replace(/^https:\/\//, "")}
            </a>
            {submission.repoRef && ` · ${submission.repoRef}`}
            {submission.track && ` · track ${submission.track}`}
          </>
        }
      />
      <div className="flex flex-col gap-5.5">
        {evaluation?.scorecard && (
          <Panel>
            <div className="grid grid-cols-3 gap-5.5">
              <StatCell label="Auto score" value={evaluation.autoScore} format={(n) => n.toFixed(2)} />
              <StatCell label="Final score" value={evaluation.finalScore} format={(n) => n.toFixed(2)} />
              <StatCell
                label="Confidence"
                value={calibration ? Math.round(calibration.confidence * 100) : null}
                format={(n) => `${n}%`}
                hint="0.85 needed to auto-accept"
              />
            </div>
          </Panel>
        )}

        {reviewable && (
          <Panel title="Decision" icon={IconAlert} tone="warn">
            <div className="flex flex-col gap-4.5">
              {status === "needs_review" && calibration?.reasons.length ? (
                <Banner tone="warn">
                  <ul className="flex flex-col gap-1">
                    {calibration.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              {unreachable.length > 0 && (
                <Banner tone="warn">
                  {unreachable.map(([k, v]) => (
                    <span key={k} className="block">
                      {k}: {v}
                    </span>
                  ))}
                </Banner>
              )}
              {evaluation?.error && <Banner tone="bad">{evaluation.error}</Banner>}
              <ReviewForm detail={detail.data} rubric={rubric} />
            </div>
          </Panel>
        )}

        {status === "needs_attention" && (
          <Panel title="Attach files" icon={IconUpload} tone="info">
            <AttachForm id={submission.id} />
          </Panel>
        )}

        {gate && (
          <Panel
            title={`ArmorIQ gate: ${gate.status.replace("_", " ")}`}
            icon={IconShieldCheck}
            tone={GATE_TONE[gate.status]}
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(gate.checks).map(([k, ok]) => (
                  <Chip key={k} size="sm" tone={ok ? "good" : k === "envApiKeyPresent" ? "neutral" : "bad"}>
                    {`${ok ? "✓" : "✗"} ${CHECK_LABEL[k] ?? k}`}
                  </Chip>
                ))}
              </div>
              <ul className="text-aq-sm text-aq-ink-soft flex list-disc flex-col gap-1 pl-4.5">
                {gate.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {gate.flags.map((f) => (
                <Banner key={f} tone="warn">
                  {f}
                </Banner>
              ))}
              {gate.feedbackMd && (
                <pre className="bg-aq-zebra text-aq-sm text-aq-ink-soft rounded-md p-3 font-sans whitespace-pre-wrap">
                  {gate.feedbackMd}
                </pre>
              )}
            </div>
          </Panel>
        )}

        {evaluation?.scorecard && rubric && (
          <div className="grid gap-5.5 xl:grid-cols-5">
            <Panel title="Scorecard" icon={IconScroll} tone="accent" className="xl:col-span-3">
              {evaluation.rubricVersion && evaluation.rubricVersion !== rubric.version && (
                <div className="mb-3">
                  <Banner tone="warn">
                    Scored under rubric v{evaluation.rubricVersion}; the active rubric is v{rubric.version}.
                  </Banner>
                </div>
              )}
              <ScorecardTable rubric={rubric} evaluation={evaluation} onFocus={setFocus} />
              {calibration?.discrepancyNotes.length ? (
                <div className="mt-4.5">
                  <div className="text-aq-caption tracking-aq-widest text-aq-ink-muted mb-2 font-medium uppercase">
                    Where the LLM and Jev disagree
                  </div>
                  <ul className="text-aq-sm text-aq-ink-soft flex flex-col gap-1">
                    {calibration.discrepancyNotes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {evaluation.scorecard.feedbackMd && (
                <div className="mt-4.5">
                  <div className="text-aq-caption tracking-aq-widest text-aq-ink-muted mb-2 font-medium uppercase">
                    Feedback for the team
                  </div>
                  <p className="text-aq-sm text-aq-ink-soft whitespace-pre-wrap">
                    {evaluation.scorecard.feedbackMd}
                  </p>
                </div>
              )}
            </Panel>
            <Panel title="Evidence" icon={IconFile} tone="info" className="xl:col-span-2">
              <EvidenceViewer
                submissionId={submission.id}
                evaluation={evaluation}
                focus={focus}
                answers={submission.answers}
              />
            </Panel>
          </div>
        )}

        {evaluation && evaluation.reviews.length > 0 && (
          <Panel title="Review history" icon={IconHistory} count={evaluation.reviews.length} flush>
            <div className="divide-aq-border divide-y">
              {evaluation.reviews.map((r) => (
                <ListRow
                  key={`${r.at}-${r.decision}`}
                  asCard={false}
                  title={`${r.reviewer}: ${r.decision}`}
                  meta={[
                    new Date(r.at).toLocaleString(),
                    Object.entries(r.overrides)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", "),
                    r.notes,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))}
            </div>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
