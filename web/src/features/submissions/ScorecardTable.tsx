/**
 * Per criterion: the AI's level (score of record) with the points it earns, clickable citations, and, when a Jev
 * second opinion ran, Jev's independent distribution and agreement.
 */
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
  const hasJev = (evaluation.calibration?.criteria ?? []).some((c) => c.jevProbs !== null);
  const weightSum = rubric.criteria.reduce((a, c) => a + c.weight, 0) || 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-aq-border border-b">
            <th className={TH}>Criterion</th>
            <th className={TH}>AI level</th>
            <th className={TH}>Points</th>
            {hasJev && (
              <>
                <th className={TH}>Jev</th>
                <th className={TH}>Agreement</th>
                <th className={TH}>Evidence</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rubric.criteria.map((c) => {
            const s = scores.find((x) => x.criterionId === c.id);
            const cal = calibration.get(c.id);
            const max = (100 * c.weight) / weightSum;
            const earned = s ? (max * s.level) / (c.levels.length - 1) : null;
            return (
              <tr key={c.id} className="border-aq-border border-b align-top last:border-b-0">
                <td className="px-3 py-3">
                  <div className="text-aq-sm text-aq-ink font-semibold">{c.name}</div>
                  <div className="text-aq-xs text-aq-ink-muted">{c.description}</div>
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
                <td className="px-3 py-3 whitespace-nowrap">
                  <span className="text-aq-sm text-aq-ink font-mono font-medium">
                    {earned === null ? "—" : earned.toFixed(1)}
                  </span>
                  <span className="text-aq-xs text-aq-ink-muted font-mono"> / {max.toFixed(0)}</span>
                </td>
                {hasJev && (
                  <>
                    <td className="w-24 px-3 py-3">
                      {cal?.jevProbs && s ? (
                        <JevBar
                          probs={cal.jevProbs}
                          llmLevel={s.level}
                          labels={c.levels.map((l) => l.label)}
                        />
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
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
