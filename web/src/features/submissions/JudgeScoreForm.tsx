/**
 * A judge's own score: points per criterion next to what the AI gave, kept beside the AI score (never replacing it).
 * Each judge has one score per team; saving again replaces it. The leaderboard ranks by the judges' average.
 */
import { Banner, Button, FormField } from "@shared/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type Rubric, type SubmissionDetail, unwrap } from "../../api/client";
import { inputClass, textareaClass } from "../../shared/fields";
import { recall, remember } from "../../shared/storage";

const round = (n: number) => Math.round(n * 100) / 100;

export function JudgeScoreForm({ detail, rubric }: { detail: SubmissionDetail; rubric: Rubric }) {
  const id = detail.submission.id;
  const evaluation = detail.evaluation;
  const scores = evaluation?.judgeScores ?? [];
  const penalties = evaluation?.calibration?.penalties ?? [];
  const deducted = penalties.reduce((sum, p) => sum + p.points, 0);
  /** What the AI's level is worth in points, as a reference for the judge. */
  const aiPoints = (criterionId: string): number | null => {
    const c = rubric.criteria.find((x) => x.id === criterionId);
    const sc = evaluation?.scorecard?.scores.find((x) => x.criterionId === criterionId);
    if (!c || !sc || sc.notAssessed) return null;
    return round((c.weight * sc.level) / (c.levels.length - 1));
  };

  const [reviewer, setReviewer] = useState(recall("hackeval.reviewer"));
  const mine = scores.find((s) => s.reviewer.toLowerCase() === reviewer.trim().toLowerCase());
  const [points, setPoints] = useState<Record<string, string>>(() =>
    Object.fromEntries(rubric.criteria.map((c) => [c.id, mine ? String(mine.points[c.id] ?? "") : ""])),
  );
  const [notes, setNotes] = useState(mine?.notes ?? "");
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PUT("/api/submissions/{id}/judge-score", {
          params: { path: { id } },
          body: {
            reviewer: reviewer.trim(),
            points: Object.fromEntries(Object.entries(points).map(([k, v]) => [k, Number(v)])),
            notes,
          },
        }),
      ),
    onSuccess: () => {
      remember("hackeval.reviewer", reviewer.trim());
      void queryClient.invalidateQueries();
    },
  });

  const filled = rubric.criteria.every(
    (c) => points[c.id]?.trim() !== "" && Number.isFinite(Number(points[c.id])),
  );
  const weights = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  const awarded = rubric.criteria.reduce((sum, c) => sum + (Number(points[c.id]) || 0), 0);
  const preview = Math.max(0, round((100 * awarded) / weights - deducted));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const useAi = () =>
    setPoints(Object.fromEntries(rubric.criteria.map((c) => [c.id, String(aiPoints(c.id) ?? "")])));

  return (
    <div className="flex flex-col gap-4.5">
      {scores.length > 0 && (
        <ul className="text-aq-sm flex flex-col gap-1" data-testid="judge-scores">
          {scores.map((s) => (
            <li key={s.reviewer} className="text-aq-ink-soft flex justify-between gap-4">
              <span>
                {s.reviewer}
                {s.notes && <span className="text-aq-ink-muted"> · {s.notes}</span>}
              </span>
              <span className="text-aq-ink font-mono">{s.total.toFixed(1)}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-col gap-4.5" onSubmit={onSubmit} aria-label="your score">
        <table className="text-aq-sm w-full">
          <thead>
            <tr className="text-aq-caption tracking-aq-widest text-aq-ink-muted text-left uppercase">
              <th className="pb-2 font-medium">Criterion</th>
              <th className="pb-2 text-right font-medium">AI</th>
              <th className="pb-2 pl-3 text-right font-medium">Your points</th>
            </tr>
          </thead>
          <tbody>
            {rubric.criteria.map((c) => {
              const ai = aiPoints(c.id);
              return (
                <tr key={c.id} className="border-aq-border border-t">
                  <td className="text-aq-ink-soft py-2">
                    <label htmlFor={`pts-${c.id}`}>{c.name}</label>
                  </td>
                  <td className="text-aq-ink-muted py-2 text-right font-mono">
                    {ai === null ? "not judged" : `${ai} / ${c.weight}`}
                  </td>
                  <td className="py-2 pl-3">
                    <span className="flex items-center justify-end gap-2">
                      <input
                        id={`pts-${c.id}`}
                        type="number"
                        min={0}
                        max={c.weight}
                        step="any"
                        className={`${inputClass} w-24 text-right font-mono`}
                        value={points[c.id] ?? ""}
                        onChange={(e) => setPoints({ ...points, [c.id]: e.target.value })}
                        required
                      />
                      <span className="text-aq-ink-muted font-mono">/ {c.weight}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="text-aq-sm text-aq-ink-soft flex flex-wrap items-center justify-between gap-3">
          <span>
            Your score: <span className="text-aq-ink font-mono">{filled ? preview.toFixed(1) : "—"}</span> /
            100
            {deducted > 0 && (
              <span className="text-aq-ink-muted"> (after the same −{deducted} in deductions)</span>
            )}
          </span>
          {evaluation?.scorecard && (
            <Button type="button" variant="secondary" size="sm" onClick={useAi}>
              Start from the AI's points
            </Button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Your name" htmlFor="judge-name" required>
            <input
              id="judge-name"
              className={inputClass}
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              required
            />
          </FormField>
          <FormField label="Notes" htmlFor="judge-notes">
            <textarea
              id="judge-notes"
              rows={1}
              className={textareaClass}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
        </div>
        {save.isError && <Banner tone="bad">{save.error.message}</Banner>}
        {save.isSuccess && <Banner tone="good">Saved: your score is {save.data.total.toFixed(1)}.</Banner>}
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={!reviewer.trim() || !filled}
          >
            {mine ? "Update your score" : "Save your score"}
          </Button>
        </div>
      </form>
    </div>
  );
}
