/** The stage functions a pipeline run depends on. Tests inject fakes; production wires the real stages. */
import type { Policy } from "../config";
import type { CalibrationResult } from "../schemas/calibration";
import type { GateResult, PrescreenResult, Usage } from "../schemas/evaluation";
import type { ArmorIQEvidence, MediaDigest, RepoAcquisition, RepoSnapshot } from "../schemas/evidence";
import type { ArtifactFindings, Scorecard } from "../schemas/findings";
import type { Rubric, Source } from "../schemas/rubric";
import type { Submission } from "../schemas/submission";
import type { Settings } from "../settings";

export interface PipelineDeps {
  rubric: Rubric;
  policy: Policy;
  // Gate phase
  acquireRepo(sub: Submission): Promise<RepoAcquisition>;
  scanArmoriq(repoPath: string): Promise<ArmorIQEvidence>;
  decideGate(evidence: ArmorIQEvidence, snapshot: RepoSnapshot): Promise<GateResult>;
  // Scoring phase
  ingestMedia(sub: Submission): Promise<MediaDigest>;
  prescreen(sub: Submission, media: MediaDigest): Promise<PrescreenResult>;
  analyze(
    source: Source,
    sub: Submission,
    media: MediaDigest,
    evidence: ArmorIQEvidence | null,
  ): Promise<ArtifactFindings>;
  synthesize(
    sub: Submission,
    findings: ArtifactFindings[],
    evidence: ArmorIQEvidence | null,
  ): Promise<Scorecard>;
  /** Per-submission LLM usage collected by the agents (optional; fakes omit it). */
  usage?: { pop(submissionId: string): Usage };
  calibrate(
    sub: Submission,
    card: Scorecard,
    media: MediaDigest,
    prescreen: PrescreenResult,
    evidence: ArmorIQEvidence | null,
    gateFlags: string[],
  ): Promise<CalibrationResult>;
}

/** Builds the stage implementations for one run (production wiring, or fakes in tests). */
export type BuildDeps = (settings: Settings, rubric: Rubric, deadline: string | null) => PipelineDeps;

export type Phase = "gate" | "score";
const STAGES: Record<Phase, (keyof PipelineDeps)[]> = {
  gate: ["acquireRepo", "scanArmoriq", "decideGate"],
  score: ["ingestMedia", "prescreen", "analyze", "synthesize", "calibrate"],
};

/** A pipeline stage has not been implemented yet (lands in a later milestone). */
export class StageNotReady extends Error {}

type NotReady = ((...args: unknown[]) => Promise<never>) & { notReady: string };

export function notReady(stage: string, milestone: string): NotReady {
  const fn = (async () => {
    throw new StageNotReady(`stage '${stage}' is not implemented yet (planned for ${milestone})`);
  }) as NotReady;
  fn.notReady = milestone;
  return fn;
}

export function missingStages(deps: PipelineDeps, phase: Phase): string[] {
  return STAGES[phase].filter(
    (name) => typeof deps[name] === "function" && "notReady" in (deps[name] as object),
  );
}
