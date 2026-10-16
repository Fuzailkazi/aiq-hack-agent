import { IconBuilding, IconPlus } from "@shared/icons";
import { Banner, Button, FormField, ListRow, OrgAvatar, PageState } from "@shared/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, unwrap } from "../../api/client";
import { inputClass } from "../../shared/fields";
import { PageHeader } from "../../shared/PageHeader";
import { Panel } from "../../shared/Panel";
import { AppShell } from "../../shell/AppShell";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function HackathonList() {
  const list = useQuery({
    queryKey: ["hackathons"],
    queryFn: async () => unwrap(await api.GET("/api/hackathons")),
  });
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [deadline, setDeadline] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/hackathons", {
          body: { id, name: name || undefined, deadline: deadline ? new Date(deadline).toISOString() : null },
        }),
      ),
    onSuccess: (h) => {
      void queryClient.invalidateQueries({ queryKey: ["hackathons"] });
      navigate(`/h/${h.id}`);
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <AppShell crumbs={[{ label: "Hackathons" }]}>
      <PageHeader
        title="Hackathons"
        subtitle="Each hackathon has its own rubric, submissions, review queue and leaderboard."
      />
      <div className="grid items-start gap-5.5 lg:grid-cols-5">
        <Panel
          title="All hackathons"
          icon={IconBuilding}
          count={list.data?.length}
          className="lg:col-span-3"
          flush
        >
          {list.isLoading ? (
            <PageState state="loading" headline="Loading hackathons" />
          ) : list.data?.length ? (
            <div className="divide-aq-border divide-y">
              {list.data.map((h) => (
                <ListRow
                  key={h.id}
                  asCard={false}
                  leading={<OrgAvatar org={{ initials: initials(h.name), color: "accent" }} size={28} />}
                  title={
                    <Link to={`/h/${h.id}`} className="hover:underline">
                      {h.name}
                    </Link>
                  }
                  meta={
                    h.activeRubricId
                      ? `Rubric ${h.activeRubricId} v${h.activeRubricVersion}`
                      : "No rubric yet"
                  }
                  trailing={
                    h.deadline ? (
                      <span className="text-aq-xs text-aq-ink-muted">
                        Deadline {new Date(h.deadline).toLocaleString()}
                      </span>
                    ) : null
                  }
                />
              ))}
            </div>
          ) : (
            <PageState state="empty" headline="No hackathons yet" body="Create one to import submissions." />
          )}
        </Panel>
        <Panel title="New hackathon" icon={IconPlus} tone="accent" className="lg:col-span-2">
          <form className="flex flex-col gap-4.5" onSubmit={onSubmit}>
            <FormField label="Id" htmlFor="h-id" helper="Letters, digits, - and _" required>
              <input
                id="h-id"
                className={inputClass}
                value={id}
                onChange={(e) => setId(e.target.value)}
                required
                pattern="[A-Za-z0-9][\w-]{0,63}"
              />
            </FormField>
            <FormField label="Name" htmlFor="h-name">
              <input
                id="h-name"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
            <FormField label="Submission deadline" htmlFor="h-deadline" helper="Your local time">
              <input
                id="h-deadline"
                type="datetime-local"
                className={inputClass}
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </FormField>
            {create.isError && <Banner tone="bad">{create.error.message}</Banner>}
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create hackathon
            </Button>
          </form>
        </Panel>
      </div>
    </AppShell>
  );
}
