/** Per criterion: the LLM's level (score of record), Jev's independent distribution, and clickable citations. */
import { IconClipboard, IconCode, IconFile, IconPlay } from "@shared/icons";
import { Chip } from "@shared/ui";
import type { Evaluation, Rubric } from "../../api/client";
import { type Focus, parseCitation } from "../../shared/citations";
import { pct } from "../../shared/status";
import { JevBar } from "./JevBar";

const tone = (x: number | null | undefined, floor: number) =>
  x === null || x === undefined ? "neutral" : x >= floor ? "good" : "bad";

const SOURCE_ICON = { deck: IconFile, video: IconPlay, repo: IconCode, form: IconClipboard } as const;

const TH = "text-aq-caption tracking-aq-widest text-aq-ink-muted px-3 py-2 text-left font-medium uppercase";

export function ScorecardTable({
  rubric,
  evaluation,
  onFocus,
}: {
  rubric: Rubric;
  evaluation: Evaluation;
  onFocus: (focus: Focus) => void;
}) {
  const scores = evaluation.scorecard?.scores ?? [];
  const calibration = new Map((evaluation.calibration?.criteria ?? []).map((c) => [c.criterionId, c]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-aq-border border-b">
            <th className={TH}>Criterion</th>
            <th className={TH}>LLM level</th>
            <th className={TH}>Jev</th>
            <th className={TH}>Agreement</th>
            <th className={TH}>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rubric.criteria.map((c) => {
            const s = scores.find((x) => x.criterionId === c.id);
            const cal = calibration.get(c.id);
            return (
              <tr key={c.id} className="border-aq-border border-b align-top last:border-b-0">
                <td className="px-3 py-3">
                  <div className="text-aq-sm text-aq-ink font-semibold">{c.name}</div>
                  <div className="text-aq-xs text-aq-ink-muted">weight {c.weight}</div>
                  {s && <p className="text-aq-xs text-aq-ink-soft mt-2 max-w-md">{s.rationale}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(s?.citations ?? []).map((citation) => (
                      <Chip
                        key={`${citation.source}:${citation.ref}`}
                        size="sm"
                        tone="info"
                        leading={SOURCE_ICON[citation.source]}
                        onClick={() => onFocus(parseCitation(citation))}
                      >
                        {`${citation.source}: ${citation.ref}`}
                      </Chip>
                    ))}
                  </div>
                </td>
                <td className="text-aq-sm text-aq-ink px-3 py-3 whitespace-nowrap">
                  {s ? `${s.levelLabel} (${s.level}/${c.levels.length - 1})` : "—"}
                </td>
                <td className="w-24 px-3 py-3">
                  {cal?.jevProbs && s ? (
                    <JevBar probs={cal.jevProbs} llmLevel={s.level} labels={c.levels.map((l) => l.label)} />
                  ) : (
                    <span className="text-aq-ink-faint">—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <Chip size="sm" tone={tone(cal?.agreement, 0.5)}>
                    {pct(cal?.agreement)}
                  </Chip>
                </td>
                <td className="px-3 py-3">
                  <Chip size="sm" tone={tone(cal?.sufficiency, 0.6)}>
                    {pct(cal?.sufficiency)}
                  </Chip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
