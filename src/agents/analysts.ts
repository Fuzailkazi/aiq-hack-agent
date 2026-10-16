/** Stage 2: the deck, video and repo-integration analysts and the synthesis judge, as ADK LlmAgents. */
import { LlmAgent } from "@google/adk";
import type { Role } from "../config";
import { redactDeep } from "../digest/armoriq/secrets";
import type { ArmorIQEvidence, MediaDigest } from "../schemas/evidence";
import type { ArtifactFindings, Scorecard } from "../schemas/findings";
import { forSource, type Rubric, type Source } from "../schemas/rubric";
import type { Submission } from "../schemas/submission";
import { UsageMeter } from "../usage";
import { buildAnalystParts, buildSynthesisParts } from "./messages";
import type { Model } from "./models";
import { analystOutputSchema, synthesisOutputSchema, toArtifactFindings, toScorecard } from "./outputSchemas";
import { type PromptName, renderPrompt, rubricText } from "./prompts";
import { OUTPUT_KEY, StructuredRunner } from "./run";

const PROMPTS: Record<Source, PromptName> = {
  deck: "deck_analyst",
  video: "video_analyst",
  repo: "integration_analyst",
};
const ROLES: Record<Source, Role> = { deck: "deck", video: "video", repo: "integration" };

/** A callable instruction bypasses ADK's {state} templating, so rubric text with braces is safe. */
const instruction = (text: string) => () => text;

export function makeAnalyst(source: Source, rubric: Rubric, model: Model): LlmAgent {
  return new LlmAgent({
    name: PROMPTS[source],
    model,
    instruction: instruction(renderPrompt(PROMPTS[source], rubricText(forSource(rubric, source)))),
    outputSchema: analystOutputSchema(rubric, source),
    outputKey: OUTPUT_KEY,
  });
}

export function makeSynthesizer(rubric: Rubric, model: Model): LlmAgent {
  return new LlmAgent({
    name: "synthesis",
    model,
    instruction: instruction(renderPrompt("synthesis", rubricText(rubric.criteria))),
    outputSchema: synthesisOutputSchema(rubric),
    outputKey: OUTPUT_KEY,
  });
}

/** PipelineDeps.analyze: one ADK agent per artifact source. Absent artifacts never cost an LLM call. */
export class AdkAnalyze {
  private readonly runners = new Map<Source, StructuredRunner>();

  constructor(
    private readonly rubric: Rubric,
    private readonly modelFor: (role: Role) => Model,
    readonly meter: UsageMeter = new UsageMeter(),
  ) {}

  private runner(source: Source): StructuredRunner {
    let runner = this.runners.get(source);
    if (!runner) {
      runner = new StructuredRunner(makeAnalyst(source, this.rubric, this.modelFor(ROLES[source])));
      this.runners.set(source, runner);
    }
    return runner;
  }

  async analyze(
    source: Source,
    sub: Submission,
    media: MediaDigest,
    evidence: ArmorIQEvidence | null,
  ): Promise<ArtifactFindings> {
    const criteria = forSource(this.rubric, source);
    if (!criteria.length)
      return {
        source,
        summary: "No rubric criteria use this artifact.",
        findings: [],
        claims: [],
        redFlags: [],
      };
    const absent = { deck: media.deck === null, video: media.video === null, repo: evidence === null }[
      source
    ];
    if (absent) {
      return {
        source,
        summary: `No ${source} was submitted.`,
        findings: criteria.map((c) => ({
          criterionId: c.id,
          observations: [],
          citations: [],
          absent: true,
          provisionalLabel: null,
        })),
        claims: [],
        redFlags: [],
      };
    }
    const { data, usage } = await this.runner(source).run(buildAnalystParts(source, sub, media, evidence));
    this.meter.add(sub.id, usage);
    return redactDeep(toArtifactFindings(source, this.rubric, data));
  }
}

/** PipelineDeps.synthesize: analyst findings + repo evidence -> the final scorecard. */
export class AdkSynthesize {
  private readonly runner: StructuredRunner;

  constructor(
    private readonly rubric: Rubric,
    model: Model,
    readonly meter: UsageMeter = new UsageMeter(),
  ) {
    this.runner = new StructuredRunner(makeSynthesizer(rubric, model));
  }

  async synthesize(
    sub: Submission,
    findings: ArtifactFindings[],
    evidence: ArmorIQEvidence | null,
  ): Promise<Scorecard> {
    const { data, usage } = await this.runner.run(buildSynthesisParts(sub, findings, evidence));
    this.meter.add(sub.id, usage);
    return redactDeep(toScorecard(this.rubric, data));
  }
}
