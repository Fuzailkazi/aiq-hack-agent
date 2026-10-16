/** A judge's decision. Which decisions exist depends on why the submission is waiting. */
import { Banner, Button, FormField, SegmentedControl } from "@shared/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type Rubric, type Status, type SubmissionDetail, unwrap } from "../../api/client";
import { inputClass, textareaClass } from "../../shared/fields";
import { STATUS } from "../../shared/status";
import { recall, remember } from "../../shared/storage";

type Decision = "accept" | "override" | "disqualify" | "reinstate" | "requeue";
const LABEL: Record<Decision, string> = {
  accept: "Accept",
  override: "Override",
  disqualify: "Disqualify",
  reinstate: "Reinstate",
  requeue: "Requeue",
};

export const DECISIONS: Partial<Record<Status, Decision[]>> = {
  needs_review: ["accept", "override", "disqualify"],
  gate_review: ["reinstate", "disqualify"],
  disqualified: ["reinstate"],
  needs_attention: ["requeue"],
  error: ["requeue"],
};

export function ReviewForm({ detail, rubric }: { detail: SubmissionDetail; rubric: Rubric | null }) {
  const id = detail.submission.id;
  const options = DECISIONS[detail.status] ?? [];
  const current = Object.fromEntries(
    (detail.evaluation?.scorecard?.scores ?? []).map((s) => [s.criterionId, s.levelLabel]),
  );
  const [decision, setDecision] = useState<Decision>(options[0] ?? "accept");
  const [reviewer, setReviewer] = useState(recall("hackeval.reviewer"));
  const [notes, setNotes] = useState("");
  const [levels, setLevels] = useState<Record<string, string>>(current);
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: async () => {
      const overrides =
        decision === "override"
          ? Object.fromEntries(Object.entries(levels).filter(([k, v]) => v !== current[k]))
          : undefined;
      return unwrap(
        await api.POST("/api/submissions/{id}/decision", {
          params: { path: { id } },
          body: { decision, reviewer: reviewer.trim(), notes, overrides },
        }),
      );
    },
    onSuccess: () => {
      remember("hackeval.reviewer", reviewer.trim());
      void queryClient.invalidateQueries();
    },
  });

  if (!options.length) return null;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };
  return (
    <form className="flex flex-col gap-4.5" onSubmit={onSubmit} aria-label="review decision">
      <SegmentedControl
        size="md"
        ariaLabel="Decision"
        value={decision}
        onChange={(v) => setDecision(v as Decision)}
        options={options.map((d) => ({ value: d, label: LABEL[d] }))}
      />
      {decision === "override" && rubric && (
        <div className="grid gap-3 sm:grid-cols-2">
          {rubric.criteria.map((c) => (
            <FormField key={c.id} label={c.name} htmlFor={`lvl-${c.id}`}>
              <select
                id={`lvl-${c.id}`}
                className={inputClass}
                value={levels[c.id] ?? ""}
                onChange={(e) => setLevels({ ...levels, [c.id]: e.target.value })}
              >
                {c.levels.map((l) => (
                  <option key={l.label} value={l.label}>
                    {l.label} — {l.description}
                  </option>
                ))}
              </select>
            </FormField>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Your name" htmlFor="reviewer" required>
          <input
            id="reviewer"
            className={inputClass}
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Notes" htmlFor="notes">
          <textarea
            id="notes"
            rows={1}
            className={textareaClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>
      </div>
      {submit.isError && <Banner tone="bad">{submit.error.message}</Banner>}
      {submit.isSuccess && (
        <Banner tone="good">
          Decision recorded: {STATUS[submit.data.from].label} → {STATUS[submit.data.to].label}
        </Banner>
      )}
      <div>
        <Button type="submit" variant="primary" loading={submit.isPending} disabled={!reviewer.trim()}>
          Record decision
        </Button>
      </div>
    </form>
  );
}
