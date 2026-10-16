/** ADK Workflow for scoring a gate-passed submission. Wiring only: the logic lives in the injected deps. */
import { FunctionNode, JoinNode, START, Workflow } from "@google/adk";
import { PrescreenResultSchema } from "../schemas/evaluation";
import {
  type ArmorIQEvidence,
  ArmorIQEvidenceSchema,
  type MediaDigest,
  MediaDigestSchema,
} from "../schemas/evidence";
import { type ArtifactFindings, ArtifactFindingsSchema, ScorecardSchema } from "../schemas/findings";
import { hasRepoCriteria, type Source } from "../schemas/rubric";
import { type Submission, SubmissionSchema } from "../schemas/submission";
import type { PipelineDeps } from "./deps";
import { nodeEvent } from "./events";

/** Analyst node name -> the artifact it judges. Node names are also the JoinNode output keys. */
export const ANALYSTS: Record<string, Source> = {
  deck_analyst: "deck",
  video_analyst: "video",
  integration_analyst: "repo",
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
    return nodeEvent({
      state: { media },
      route: Object.keys(media.unreachable).length ? "unreachable" : "ok",
    });
  });

  const jevPrescreen = new FunctionNode("jev_prescreen", async (ctx) => {
    const prescreen = await deps.prescreen(submissionOf(ctx.state), mediaOf(ctx.state));
    return nodeEvent({ state: { prescreen } });
  });

  const analyst = (name: string, source: Source) =>
    new FunctionNode(name, async (ctx): Promise<ArtifactFindings> => {
      if (source === "repo" && !hasRepoCriteria(deps.rubric)) {
        return ArtifactFindingsSchema.parse({
          source: "repo",
          summary: "The rubric has no repo-sourced criteria.",
        });
      }
      return deps.analyze(source, submissionOf(ctx.state), mediaOf(ctx.state), evidenceOf(ctx.state));
    });
  const analysts = Object.entries(ANALYSTS).map(([name, source]) => analyst(name, source));

  const joinFindings = new JoinNode({ name: "join_findings" });

  const synthesis = new FunctionNode("synthesis", async (ctx, input) => {
    const joined = input as Record<string, unknown>;
    const findings = Object.keys(ANALYSTS).map((name) => ArtifactFindingsSchema.parse(joined[name]));
    const scorecard = await deps.synthesize(submissionOf(ctx.state), findings, evidenceOf(ctx.state));
    return nodeEvent({ state: { findings, scorecard } });
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
      [START, ingestMedia, { ok: jevPrescreen, unreachable: scoringDone }],
      [jevPrescreen, analysts, joinFindings, synthesis, jevCalibrate, scoringDone],
    ],
  });
}
