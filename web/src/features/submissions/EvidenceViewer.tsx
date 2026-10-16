/** What the agents saw: slides (images + text), the video with its timestamped transcript, and repo usage sites. */
import { ListRow, PageState, SegmentedControl } from "@shared/ui";
import { useEffect, useRef, useState } from "react";
import type { Evaluation } from "../../api/client";
import { type Focus, mmss } from "../../shared/citations";

type Tab = "deck" | "video" | "repo";
const ring = (on: boolean) => (on ? "ring-aq-accent ring-2" : "");

export function EvidenceViewer({
  submissionId,
  evaluation,
  focus,
}: {
  submissionId: string;
  evaluation: Evaluation;
  focus: Focus;
}) {
  const media = evaluation.media;
  const [tab, setTab] = useState<Tab>(media?.deck ? "deck" : media?.video ? "video" : "repo");
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus.kind === "slide") setTab("deck");
    if (focus.kind === "code") setTab("repo");
    if (focus.kind === "time") {
      setTab("video");
      if (video.current) {
        video.current.currentTime = focus.seconds;
        void video.current.play?.()?.catch(() => {});
      }
    }
  }, [focus]);
  useEffect(() => {
    container.current?.querySelector("[data-focused='true']")?.scrollIntoView?.({ block: "nearest" });
  });
  const seek = (seconds: number) => {
    if (video.current) video.current.currentTime = seconds;
  };

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        ariaLabel="Evidence source"
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        options={[
          { value: "deck", label: "Deck" },
          { value: "video", label: "Video" },
          { value: "repo", label: "Repository" },
        ]}
      />
      <div className="flex max-h-screen flex-col gap-3 overflow-y-auto pr-1" ref={container}>
        {tab === "deck" &&
          (media?.deck ? (
            media.deck.slides.map((s) => {
              const on = focus.kind === "slide" && focus.index === s.index;
              return (
                <div
                  key={s.index}
                  data-testid={`slide-${s.index}`}
                  data-focused={on}
                  className={`border-aq-border bg-aq-surface rounded-lg border p-3 ${ring(on)}`}
                >
                  <div className="text-aq-caption tracking-aq-widest text-aq-ink-muted mb-2 font-medium uppercase">
                    Slide {s.index}
                  </div>
                  {s.imagePath && (
                    <img
                      className="border-aq-border mb-2 w-full rounded-md border"
                      src={`/api/submissions/${submissionId}/slides/${s.index}`}
                      alt={`Slide ${s.index}`}
                    />
                  )}
                  <p className="text-aq-sm text-aq-ink-soft whitespace-pre-wrap">{s.text}</p>
                  {s.notes && (
                    <p className="text-aq-xs text-aq-ink-muted mt-2 whitespace-pre-wrap">Notes: {s.notes}</p>
                  )}
                </div>
              );
            })
          ) : (
            <PageState state="empty" headline="No deck" />
          ))}
        {tab === "video" &&
          (media?.video ? (
            <>
              {/* biome-ignore lint/a11y/useMediaCaption: the transcript below is the caption track */}
              <video
                ref={video}
                controls
                preload="metadata"
                className="bg-aq-ink-panel w-full rounded-lg"
                src={`/api/submissions/${submissionId}/video`}
              />
              <div className="flex flex-col">
                {media.video.transcript.map((seg) => {
                  const on = focus.kind === "time" && seg.startS <= focus.seconds && focus.seconds < seg.endS;
                  return (
                    <button
                      key={seg.startS}
                      type="button"
                      data-focused={on}
                      onClick={() => seek(seg.startS)}
                      className={`hover:bg-aq-zebra text-aq-sm text-aq-ink-soft flex gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${on ? "bg-aq-accent-soft text-aq-accent-strong" : ""}`}
                    >
                      <span className="text-aq-ink-muted shrink-0 font-mono">{mmss(seg.startS)}</span>
                      <span>{seg.text}</span>
                    </button>
                  );
                })}
              </div>
              {!media.video.hasSpeech && <p className="text-aq-sm text-aq-ink-muted">No speech detected.</p>}
            </>
          ) : (
            <PageState state="empty" headline="No video" />
          ))}
        {tab === "repo" &&
          (evaluation.evidence ? (
            <>
              <div className="border-aq-border divide-aq-border divide-y rounded-lg border">
                {evaluation.evidence.installs.map((i) => (
                  <ListRow
                    key={`${i.path}:${i.package}`}
                    asCard={false}
                    density="compact"
                    title={i.package}
                    meta={<span className="font-mono">{i.path}</span>}
                    trailing={<span className="text-aq-xs text-aq-ink-muted">{i.kind}</span>}
                  />
                ))}
                {!evaluation.evidence.installs.length && (
                  <p className="text-aq-sm text-aq-ink-muted p-3">No install declarations found.</p>
                )}
              </div>
              {evaluation.evidence.usageSites.map((u) => {
                const on = focus.kind === "code" && focus.path === u.path && focus.line === u.line;
                return (
                  <div
                    key={`${u.path}:${u.line}:${u.symbol}`}
                    data-focused={on}
                    className={`border-aq-border rounded-lg border p-3 ${ring(on)}`}
                  >
                    <div className="text-aq-xs text-aq-ink-muted flex justify-between gap-3">
                      <span className="text-aq-ink font-mono">
                        {u.path}:{u.line}
                      </span>
                      <span>
                        {u.kind} {u.symbol}
                        {u.inTest ? " (test)" : ""}
                      </span>
                    </div>
                    <pre className="bg-aq-zebra text-aq-xs text-aq-ink mt-2 overflow-x-auto rounded-md p-3 font-mono">
                      {u.snippet}
                    </pre>
                  </div>
                );
              })}
              {evaluation.evidence.unresolved.length > 0 && (
                <p className="text-aq-xs text-aq-ink-muted">
                  Scanner could not resolve: {evaluation.evidence.unresolved.join("; ")}
                </p>
              )}
            </>
          ) : (
            <PageState state="empty" headline="No repository evidence" />
          ))}
      </div>
    </div>
  );
}
