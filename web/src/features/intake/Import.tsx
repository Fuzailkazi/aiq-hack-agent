import { IconFile, IconPlus } from "@shared/icons";
import { Banner, Button, FormField } from "@shared/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useParams } from "react-router";
import { api, asForm, unwrap } from "../../api/client";
import { fileClass, inputClass } from "../../shared/fields";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { AppShell } from "../../shell/AppShell";
import { useHackathon } from "../hackathons/useHackathon";

export function Import() {
  const hid = useParams().hid ?? "";
  const hackathon = useHackathon(hid);
  const queryClient = useQueryClient();

  const [csv, setCsv] = useState<File | null>(null);
  const importCsv = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      if (csv) form.append("file", csv);
      return unwrap(
        await api.POST("/api/hackathons/{hid}/import", {
          params: { path: { hid } },
          body: form as never,
          ...asForm,
        }),
      );
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const [fields, setFields] = useState({ teamName: "", repoUrl: "", track: "", deckUrl: "", videoUrl: "" });
  const [deck, setDeck] = useState<File | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) if (v.trim()) form.append(k, v.trim());
      if (deck) form.append("deck", deck);
      if (video) form.append("video", video);
      return unwrap(
        await api.POST("/api/hackathons/{hid}/submissions", {
          params: { path: { hid } },
          body: form as never,
          ...asForm,
        }),
      );
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) =>
    setFields({ ...fields, [k]: e.target.value });
  const report = importCsv.data;

  return (
    <AppShell
      crumbs={[
        { label: "Hackathons", to: "/" },
        { label: hackathon.data?.hackathon.name ?? hid, to: `/h/${hid}` },
        { label: "Import" },
      ]}
      hid={hid}
      section="import"
    >
      <PageHeader
        title="Add submissions"
        subtitle="Import the organizer CSV, or add a single team by hand."
      />
      <div className="grid items-start gap-5.5 lg:grid-cols-2">
        <Panel title="Import a CSV" icon={IconFile} tone="info">
          <form
            className="flex flex-col gap-4.5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              importCsv.mutate();
            }}
          >
            <FormField label="CSV file" htmlFor="csv" helper="Columns are mapped by config/intake.yaml.">
              <input
                id="csv"
                type="file"
                accept=".csv,text/csv"
                className={fileClass}
                onChange={(e) => setCsv(e.target.files?.[0] ?? null)}
              />
            </FormField>
            {importCsv.isError && <Banner tone="bad">{importCsv.error.message}</Banner>}
            {report && (
              <Banner tone={report.errors.length ? "warn" : "good"}>
                Created {report.created}, updated {report.updated}, unchanged {report.unchanged}, late{" "}
                {report.ignoredLate}.
                {[...report.errors, ...report.late].map((line) => (
                  <span key={line} className="mt-1 block">
                    {line}
                  </span>
                ))}
              </Banner>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={!csv} loading={importCsv.isPending}>
                Import
              </Button>
            </div>
          </form>
        </Panel>

        <Panel title="Add one submission" icon={IconPlus} tone="neutral">
          <form
            className="flex flex-col gap-4.5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <FormField label="Team name" htmlFor="team" required>
              <input
                id="team"
                className={inputClass}
                value={fields.teamName}
                onChange={set("teamName")}
                required
              />
            </FormField>
            <FormField
              label="Repository URL"
              htmlFor="repo"
              helper="A /tree/<branch> link scans that branch."
              required
            >
              <input
                id="repo"
                className={inputClass}
                value={fields.repoUrl}
                onChange={set("repoUrl")}
                required
                placeholder="https://github.com/team/project"
              />
            </FormField>
            <FormField label="Track" htmlFor="track">
              <input id="track" className={inputClass} value={fields.track} onChange={set("track")} />
            </FormField>
            <div className="grid gap-4.5 sm:grid-cols-2">
              <FormField label="Deck file" htmlFor="deck-file">
                <input
                  id="deck-file"
                  type="file"
                  accept=".pdf,.pptx"
                  className={fileClass}
                  onChange={(e) => setDeck(e.target.files?.[0] ?? null)}
                />
              </FormField>
              <FormField label="…or deck link" htmlFor="deck-url">
                <input
                  id="deck-url"
                  className={inputClass}
                  value={fields.deckUrl}
                  onChange={set("deckUrl")}
                  placeholder="https://…"
                />
              </FormField>
              <FormField label="Video file" htmlFor="video-file">
                <input
                  id="video-file"
                  type="file"
                  accept="video/*"
                  className={fileClass}
                  onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
                />
              </FormField>
              <FormField label="…or video link" htmlFor="video-url">
                <input
                  id="video-url"
                  className={inputClass}
                  value={fields.videoUrl}
                  onChange={set("videoUrl")}
                  placeholder="https://youtu.be/…"
                />
              </FormField>
            </div>
            {add.isError && <Banner tone="bad">{add.error.message}</Banner>}
            {add.data && <Banner tone="good">Result: {add.data.outcome}</Banner>}
            <div>
              <Button type="submit" variant="secondary" loading={add.isPending}>
                Add submission
              </Button>
            </div>
          </form>
        </Panel>
      </div>
    </AppShell>
  );
}
