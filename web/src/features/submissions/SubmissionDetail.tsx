import {
  IconAlert,
  IconChart,
  IconClipboardCheck,
  IconCode,
  IconFile,
  IconGlobe,
  IconHistory,
  IconLink,
  IconPlay,
  IconScroll,
  IconShieldCheck,
  IconUpload,
} from "@shared/icons";
import { Banner, Chip, ListRow, PageState } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { api, unwrap } from "../../api/client";
import { CheckList } from "../../shared/Checks";
import type { Focus } from "../../shared/citations";
import { Markdown } from "../../shared/Markdown";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { ScoreBar, trackLabel } from "../../shared/Score";
import { StatCell } from "../../shared/StatCell";
import { STATUS, StatusPill } from "../../shared/status";
import { AppShell } from "../../shell/AppShell";
import { RunPanel } from "../hackathons/RunPanel";
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
    { label: detail.data?.submission.answers.projectName ?? detail.data?.submission.teamName ?? "…" },
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
  const reasons = detail.data.reasons;
  const hasJev = (calibration?.criteria ?? []).some((c) => c.jevProbs !== null);
  const a = submission.answers;
  const links = [
    { label: "Repository", href: submission.repoUrl, icon: IconCode },
    submission.video && { label: "Demo video", href: submission.video.uri, icon: IconPlay },
    submission.liveDemoUrl && { label: "Live demo", href: submission.liveDemoUrl, icon: IconGlobe },
    a.xPost && { label: "X post", href: a.xPost, icon: IconLink },
    a.linkedinPost && { label: "LinkedIn post", href: a.linkedinPost, icon: IconLink },
  ].filter(
    (l): l is { label: string; href: string; icon: typeof IconCode } =>
      Boolean(l) && /^https?:\/\//.test((l as { href: string }).href),
  );

  return (
    <AppShell crumbs={crumbs} hid={hid} section="submissions">
      <PageHeader
        title={
          <>
            {submission.answers.projectName ?? submission.teamName} <StatusPill status={status} />
          </>
        }
        subtitle={
          <span className="flex flex-col gap-2.5">
            <span>
              {submission.answers.projectName ? `by ${submission.teamName.trim()} · ` : ""}
              {trackLabel(submission.track)} track · submitted{" "}
              {new Date(submission.submittedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {submission.repoRef && ` · branch ${submission.repoRef}`}
            </span>
            <span className="flex flex-wrap gap-1.5">
              {links.map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener">
                  <Chip size="sm" leading={l.icon}>
                    {l.label}
                  </Chip>
                </a>
              ))}
            </span>
          </span>
        }
      />
      <div className="flex flex-col gap-5.5">
        {reasons.length > 0 && (
          <Banner tone={STATUS[status].tone === "bad" ? "bad" : "warn"}>
            <span className="block font-medium">Why this is {STATUS[status].label.toLowerCase()}:</span>
            <ul className="flex flex-col gap-1" data-testid="status-reasons">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {status === "error" && evaluation?.error && (
              <span className="text-aq-xs text-aq-ink-muted mt-1 block font-mono">
                Technical detail: {evaluation.error.replace(/^Error:\s*/, "")}
              </span>
            )}
          </Banner>
        )}
        <div className="grid items-start gap-5.5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title="Score" icon={IconChart} tone="accent">
            {evaluation?.scorecard ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <StatCell
                    label={evaluation.finalScore !== null ? "Final score" : "AI score (provisional)"}
                    value={evaluation.finalScore ?? evaluation.autoScore}
                    format={(n) => n.toFixed(1)}
                    hint={
                      evaluation.finalScore !== null
                        ? "confirmed by a judge"
                        : "out of 100, until a judge confirms"
                    }
                  />
                  {evaluation.finalScore !== null && (
                    <StatCell label="AI score" value={evaluation.autoScore} format={(n) => n.toFixed(1)} />
                  )}
                  {hasJev && (
                    <StatCell
                      label="Confidence"
                      value={calibration ? Math.round(calibration.confidence * 100) : null}
                      format={(n) => `${n}%`}
                      hint="0.85 needed to auto-accept"
                    />
                  )}
                </div>
                {calibration?.rubricScore != null && (
                  <div className="text-aq-sm flex flex-col gap-1" data-testid="score-breakdown">
                    <span className="text-aq-ink-soft flex justify-between gap-4">
                      <span>Rubric score</span>
                      <span className="font-mono">{calibration.rubricScore.toFixed(1)}</span>
                    </span>
                    {calibration.penalties.map((p) => (
                      <span key={p.id} className="text-aq-bad flex justify-between gap-4">
                        <span>
                          {p.label} <span className="text-aq-ink-muted">({p.detail})</span>
                        </span>
                        <span className="font-mono">−{p.points}</span>
                      </span>
                    ))}
                    {calibration.penalties.length === 0 && (
                      <span className="text-aq-good">No deductions: every requirement was met.</span>
                    )}
                  </div>
                )}
                {rubric && (
                  <ul className="flex flex-col gap-2">
                    {rubric.criteria.map((c) => {
                      const sc = evaluation.scorecard?.scores.find((x) => x.criterionId === c.id);
                      const pct = sc ? (100 * sc.level) / (c.levels.length - 1) : null;
                      return (
                        <li key={c.id} className="flex items-center justify-between gap-4">
                          <span className="text-aq-sm text-aq-ink-soft min-w-0 truncate">
                            {c.name} <span className="text-aq-ink-faint">· {sc?.levelLabel ?? "—"}</span>
                          </span>
                          <ScoreBar
                            value={pct}
                            size="sm"
                            tone={pct !== null && pct >= 67 ? "good" : "accent"}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : status === "scoring" || status === "stale" || status === "error" ? (
              <div className="flex flex-col gap-3">
                <p className="text-aq-sm text-aq-ink-muted">
                  Not scored yet. Scoring this team watches its video, checks the live demo, reads the code
                  and the form, then cuts points for missing requirements.
                </p>
                <RunPanel hid={hid} submissionId={submission.id} />
              </div>
            ) : (
              <p className="text-aq-sm text-aq-ink-muted">
                {status === "disqualified"
                  ? "Not scored: the team did not pass the ArmorIQ SDK gate."
                  : "Not scored yet. Scores appear here once the AI has judged the video, demo, code and form."}
              </p>
            )}
          </Panel>
          <Panel title="Requirements" icon={IconClipboardCheck} tone="info">
            <CheckList checks={detail.data.checks} />
          </Panel>
        </div>

        {reviewable && (
          <Panel title="Decision" icon={IconAlert} tone="warn">
            <div className="flex flex-col gap-4.5">
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
                <div className="bg-aq-zebra rounded-md p-3">
                  <Markdown text={gate.feedbackMd} />
                </div>
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
              {hasJev && calibration?.discrepancyNotes.length ? (
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
                  <Markdown text={evaluation.scorecard.feedbackMd} />
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
