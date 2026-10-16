/**
 * Calibrate routing against humans (design M8): replay the stored LLM levels and Jev outputs against a gold set of
 * human-scored submissions. No model is called; only routing thresholds change. The 0.85 confidence bar stays fixed.
 */
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { Policy, RoutingPolicy } from "./config";
import type { CriterionCalibration } from "./schemas/calibration";
import { levelsById } from "./schemas/findings";
import { type Criterion, type Rubric, weightedScore } from "./schemas/rubric";
import { decideRoute, recompute } from "./stages/route";
import type { DB } from "./store/db";
import * as q from "./store/queries";

export interface GoldRow {
  submissionId: string;
  /** criterion id → human level index (criteria left blank are not compared) */
  levels: Record<string, number>;
}

export interface Replay {
  submissionId: string;
  llmLevels: Record<string, number>;
  criteria: CriterionCalibration[];
  flags: Record<string, number>;
  gateFlags: string[];
}

export interface Metrics {
  goldScored: number;
  accepted: number;
  reviewRate: number;
  /** Share of (accepted submission × criterion) pairs where the LLM is within ±1 level of the humans. */
  acceptedWithin1: number | null;
  allWithin1: number | null;
  exact: number | null;
  /** Mean |auto score − human score| (0–100) over gold rows that label every criterion. */
  meanAbsScoreDiff: number | null;
}

export interface Targets {
  targetWithin1: number;
  maxReviewRate: number;
}

export interface SweepRow {
  policy: RoutingPolicy;
  metrics: Metrics;
  meetsTargets: boolean;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function parseLevel(c: Criterion, value: string): number | null {
  const byLabel = c.levels.findIndex((l) => l.label.toLowerCase() === value.toLowerCase());
  if (byLabel >= 0) return byLabel;
  if (/^\d+$/.test(value) && Number(value) < c.levels.length) return Number(value);
  return null;
}

/** Gold CSV: `submission_id` (our id or the organizer's external id) plus one column per criterion id (labels). */
export function loadGold(
  db: DB,
  hackathonId: string,
  csvPath: string,
  rubric: Rubric,
): { rows: GoldRow[]; errors: string[] } {
  const records = parse(readFileSync(csvPath, "utf8"), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];
  const ids = new Map<string, string>();
  for (const { submission } of q.currentSubmissions(db, hackathonId)) {
    ids.set(submission.id, submission.id);
    if (submission.externalId) ids.set(submission.externalId, submission.id);
  }
  const rows: GoldRow[] = [];
  const errors: string[] = [];
  records.forEach((record, i) => {
    const line = `row ${i + 2}`;
    const ref = record.submission_id ?? "";
    const submissionId = ids.get(ref);
    if (!submissionId) {
      errors.push(`${line}: unknown submission '${ref}'`);
      return;
    }
    const levels: Record<string, number> = {};
    for (const c of rubric.criteria) {
      const value = record[c.id];
      if (!value) continue;
      const level = parseLevel(c, value);
      if (level === null) {
        errors.push(
          `${line}: ${c.id}: unknown level '${value}' (expected ${c.levels.map((l) => l.label).join(", ")})`,
        );
        return;
      }
      levels[c.id] = level;
    }
    rows.push({ submissionId, levels });
  });
  return { rows, errors };
}

/** Every submission scored under this rubric version, with what routing needs. */
export function loadReplays(db: DB, hackathonId: string, rubric: Rubric): Replay[] {
  const replays: Replay[] = [];
  for (const { submission } of q.currentSubmissions(db, hackathonId)) {
    const ev = q.getEvaluation(db, submission.id);
    if (!ev?.scorecard || !ev.calibration) continue;
    if (ev.rubricId !== rubric.id || ev.rubricVersion !== rubric.version) continue;
    replays.push({
      submissionId: submission.id,
      llmLevels: levelsById(ev.scorecard),
      criteria: ev.calibration.criteria,
      flags: ev.calibration.flags,
      gateFlags: ev.gate?.flags ?? [],
    });
  }
  return replays;
}

const accepts = (r: Replay, rubric: Rubric, policy: RoutingPolicy): boolean =>
  decideRoute(recompute(r.criteria, policy), rubric, policy, r.flags, r.gateFlags).route === "accept";

export function evaluatePolicy(
  replays: Replay[],
  gold: GoldRow[],
  rubric: Rubric,
  policy: RoutingPolicy,
): Metrics {
  const byId = new Map(replays.map((r) => [r.submissionId, r]));
  let accepted = 0;
  let scored = 0;
  const pairs = { acceptedOk: 0, acceptedAll: 0, ok: 0, exact: 0, all: 0 };
  const diffs: number[] = [];
  for (const g of gold) {
    const r = byId.get(g.submissionId);
    if (!r) continue;
    scored += 1;
    const ok = accepts(r, rubric, policy);
    if (ok) accepted += 1;
    for (const [id, human] of Object.entries(g.levels)) {
      const llm = r.llmLevels[id];
      if (llm === undefined) continue;
      const within = Math.abs(llm - human) <= 1;
      pairs.all += 1;
      if (within) pairs.ok += 1;
      if (llm === human) pairs.exact += 1;
      if (ok) {
        pairs.acceptedAll += 1;
        if (within) pairs.acceptedOk += 1;
      }
    }
    if (rubric.criteria.every((c) => c.id in g.levels))
      diffs.push(Math.abs(weightedScore(rubric, r.llmLevels) - weightedScore(rubric, g.levels)));
  }
  const share = (n: number, d: number) => (d ? round4(n / d) : null);
  return {
    goldScored: scored,
    accepted,
    reviewRate: scored ? round4((scored - accepted) / scored) : 0,
    acceptedWithin1: share(pairs.acceptedOk, pairs.acceptedAll),
    allWithin1: share(pairs.ok, pairs.all),
    exact: share(pairs.exact, pairs.all),
    meanAbsScoreDiff: diffs.length ? round4(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
  };
}

const GRID = {
  levelTolerance: [0, 1],
  minSufficiency: [0.4, 0.5, 0.6, 0.7, 0.8],
  minCriterionAgreement: [0.3, 0.4, 0.5, 0.6, 0.7],
};

const meets = (m: Metrics, t: Targets) =>
  m.goldScored > 0 && (m.acceptedWithin1 ?? 1) >= t.targetWithin1 && m.reviewRate <= t.maxReviewRate;

/** Grid over the tunable thresholds (confidence bar fixed); recommend the lowest review rate that meets targets,
 *  breaking ties toward the strictest policy (lower tolerance, higher sufficiency and agreement floors). */
export function sweep(
  replays: Replay[],
  gold: GoldRow[],
  rubric: Rubric,
  base: RoutingPolicy,
  targets: Targets,
): { rows: SweepRow[]; recommended: SweepRow | null } {
  const rows: SweepRow[] = [];
  for (const levelTolerance of GRID.levelTolerance)
    for (const minSufficiency of GRID.minSufficiency)
      for (const minCriterionAgreement of GRID.minCriterionAgreement) {
        const policy = { ...base, levelTolerance, minSufficiency, minCriterionAgreement };
        const metrics = evaluatePolicy(replays, gold, rubric, policy);
        rows.push({ policy, metrics, meetsTargets: meets(metrics, targets) });
      }
  const strictness = (p: RoutingPolicy) => [-p.levelTolerance, p.minSufficiency, p.minCriterionAgreement];
  const recommended =
    rows
      .filter((r) => r.meetsTargets)
      .sort((a, b) => {
        if (a.metrics.reviewRate !== b.metrics.reviewRate) return a.metrics.reviewRate - b.metrics.reviewRate;
        const [sa, sb] = [strictness(a.policy), strictness(b.policy)];
        for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
        return 0;
      })[0] ?? null;
  return { rows, recommended };
}

export interface CalibrationReport {
  gold: number;
  allScored: number;
  /** Review rate over every scored submission (no labels needed), under the current policy. */
  reviewRateAll: number;
  current: Metrics;
  targets: Targets;
  recommended: SweepRow | null;
  sweep: SweepRow[];
  errors: string[];
}

export function calibrationReport(
  db: DB,
  hackathonId: string,
  csvPath: string,
  rubric: Rubric,
  policy: Policy,
  targets: Targets = { targetWithin1: 0.9, maxReviewRate: 0.3 },
): CalibrationReport {
  const { rows, errors } = loadGold(db, hackathonId, csvPath, rubric);
  const replays = loadReplays(db, hackathonId, rubric);
  const accepted = replays.filter((r) => accepts(r, rubric, policy.routing)).length;
  const { rows: grid, recommended } = sweep(replays, rows, rubric, policy.routing, targets);
  return {
    gold: rows.length,
    allScored: replays.length,
    reviewRateAll: replays.length ? round4((replays.length - accepted) / replays.length) : 0,
    current: evaluatePolicy(replays, rows, rubric, policy.routing),
    targets,
    recommended,
    sweep: grid,
    errors,
  };
}
