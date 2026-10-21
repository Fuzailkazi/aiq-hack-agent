/** ADK Workflow for scoring a gate-passed submission. Wiring only: the logic lives in the injected deps. */
import { FunctionNode, JoinNode, START, Workflow } from "@google/adk";
import { PrescreenResultSchema } from "../schemas/evaluation";
import {
  type ArmorIQEvidence,
  ArmorIQEvidenceSchema,
  type MediaDigest,
  MediaDigestSchema,
} from "../schemas/evidence";
import {
  type ArtifactFindings,
  ArtifactFindingsSchema,
  type Scorecard,
  ScorecardSchema,
} from "../schemas/findings";
import { forSource, type Source } from "../schemas/rubric";
import { type Submission, SubmissionSchema } from "../schemas/submission";
import type { PipelineDeps } from "./deps";
import { nodeEvent } from "./events";
import {
  fallbackScorecard,
  markNotAssessed,
  scoringWarnings,
  shortCause,
  unavailableFindings,
} from "./resilience";

/**
 * Analyst node name -> the artifact it judges. Node names are also the JoinNode output keys. Cheapest and most
 * reliable first (code, then form, deck and finally the video), so a quota that runs out mid-team costs the least.
 */
export const ANALYSTS: Record<string, Source> = {
  integration_analyst: "repo",
  form_analyst: "form",
  deck_analyst: "deck",
  video_analyst: "video",
};

type State = { get(key: string): unknown };
const submissionOf = (s: State): Submission => SubmissionSchema.parse(s.get("submission"));
const mediaOf = (s: State): MediaDigest => MediaDigestSchema.parse(s.get("media"));
const evidenceOf = (s: State): ArmorIQEvidence | null => {
  const raw = s.get("evidence");
  return raw ? ArmorIQEvidenceSchema.parse(raw) : null;
};

export function buildScoringWorkflow(deps: PipelineDeps): Workflow {
  const ingestMedia = new FunctionNode("ingest_media", async (ctx) => {
    const media = await deps.ingestMedia(submissionOf(ctx.state));
    // An artifact that cannot be fetched no longer stops scoring: its analyst reports it unavailable instead.
    return nodeEvent({ state: { media } });
  });

  const jevPrescreen = new FunctionNode("jev_prescreen", async (ctx) => {
    const prescreen = await deps.prescreen(submissionOf(ctx.state), mediaOf(ctx.state));
    return nodeEvent({ state: { prescreen } });
  });

  const analyst = (name: string, source: Source) =>
    new FunctionNode(name, async (ctx): Promise<ArtifactFindings> => {
      if ((source === "repo" || source === "form") && !forSource(deps.rubric, source).length) {
        return ArtifactFindingsSchema.parse({
          source,
          summary: `The rubric has no ${source}-sourced criteria.`,
        });
      }
      const media = mediaOf(ctx.state);
      const fetchProblem = media.unreachable[source];
      if (fetchProblem) return unavailableFindings(deps.rubric, source, fetchProblem);
      try {
        return await deps.analyze(source, submissionOf(ctx.state), media, evidenceOf(ctx.state));
      } catch (e) {
        return unavailableFindings(
          deps.rubric,
          source,
          shortCause(e instanceof Error ? e.message : String(e)),
        );
      }
    });
  const analysts = Object.entries(ANALYSTS).map(([name, source]) => analyst(name, source));

  const joinFindings = new JoinNode({ name: "join_findings" });

  const synthesis = new FunctionNode("synthesis", async (ctx, input) => {
    const joined = input as Record<string, unknown>;
    const findings = Object.keys(ANALYSTS).map((name) => ArtifactFindingsSchema.parse(joined[name]));
    let card: Scorecard;
    let synthesisError: string | null = null;
    try {
      card = await deps.synthesize(submissionOf(ctx.state), findings, evidenceOf(ctx.state));
    } catch (e) {
      // Keep the team's score from the individual reviews; only give up when nothing at all could be judged.
      synthesisError = shortCause(e instanceof Error ? e.message : String(e));
      card = fallbackScorecard(deps.rubric, findings);
      if (card.scores.every((s) => s.notAssessed)) throw e;
    }
    const scorecard = markNotAssessed(deps.rubric, card, findings);
    if (scorecard.scores.every((s) => s.notAssessed))
      throw new Error(
        findings.find((f) => f.unavailable)?.unavailable ?? "no criterion could be judged for this team",
      );
    const warnings = scoringWarnings(deps.rubric, findings, scorecard, synthesisError);
    return nodeEvent({ state: { findings, scorecard, warnings } });
  });

  const jevCalibrate = new FunctionNode("jev_calibrate", async (ctx) => {
    const calibration = await deps.calibrate(
      submissionOf(ctx.state),
      ScorecardSchema.parse(ctx.state.get("scorecard")),
      mediaOf(ctx.state),
      PrescreenResultSchema.parse(ctx.state.get("prescreen")),
      evidenceOf(ctx.state),
      (ctx.state.get("gateFlags") as string[] | undefined) ?? [],
    );
    return nodeEvent({ state: { calibration } });
  });

  const scoringDone = new FunctionNode("scoring_done", async () => nodeEvent({ output: "scoring_done" }));

  return new Workflow({
    name: "scoring_workflow",
    edges: [
      [START, ingestMedia, jevPrescreen],
      [jevPrescreen, analysts, joinFindings, synthesis, jevCalibrate, scoringDone],
    ],
  });
}
