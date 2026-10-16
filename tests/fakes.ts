/** Test doubles: a scripted Jev client (more fakes are added as the pipeline grows). */
import type { JevClient, JevQuestion } from "../src/jev/client";
import type { JevDecision } from "../src/schemas/jev";

/** Answers from scripted values; records every (state, questions) call. Unscripted Nouls answer 0.5. */
export class FakeJevClient implements JevClient {
  readonly calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
  constructor(
    private readonly nouls: Record<string, number> = {},
    private readonly choices: Record<string, string> = {},
    private readonly scores: Record<string, number> = {},
  ) {}

  async decide(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevDecision>> {
    this.calls.push({ state, questions });
    const out: Record<string, JevDecision> = {};
    for (const [id, q] of Object.entries(questions)) {
      const base = { questionId: id, model: "fake-jev", requestId: null };
      if (q.type === "noul") {
        const p = this.nouls[id] ?? 0.5;
        out[id] = {
          ...base,
          type: "noul",
          value: p,
          probabilities: { yes: p, no: 1 - p },
          confidence: Math.max(p, 1 - p),
        };
      } else if (q.type === "choice") {
        const pick = this.choices[id] ?? Object.keys(q.criteria)[0];
        out[id] = { ...base, type: "choice", value: pick, probabilities: { [pick]: 1 }, confidence: 1 };
      } else {
        const s = this.scores[id] ?? 0;
        out[id] = {
          ...base,
          type: "score",
          value: s,
          probabilities: { [String(Math.round(s))]: 1 },
          confidence: 1,
        };
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted pipeline: behaviour per submission, looked up by repo URL.

import type { Policy } from "../src/config";
import type { PipelineDeps } from "../src/pipeline/deps";
import { CalibrationResultSchema, CriterionCalibrationSchema } from "../src/schemas/calibration";
import { GateResultSchema, type GateStatus, PrescreenResultSchema } from "../src/schemas/evaluation";
import { ArmorIQEvidenceSchema, MediaDigestSchema, RepoSnapshotSchema } from "../src/schemas/evidence";
import { ArtifactFindingsSchema, levelsById, ScorecardSchema } from "../src/schemas/findings";
import { forSource, type Rubric, weightedScore } from "../src/schemas/rubric";
import { decideRoute, recompute } from "../src/stages/route";

export interface Scripted {
  gate?: GateStatus;
  mediaUnreachable?: boolean;
  route?: "accept" | "review";
  /** Level index for every criterion; -1 = top level. */
  level?: number;
  /** Name of a stage that should throw. */
  crashIn?: string;
  /** Flags the gate attaches to a pass (e.g. commits after the deadline). */
  gateFlags?: string[];
}

export function fakeDeps(rubric: Rubric, policy: Policy, script: Record<string, Scripted>): PipelineDeps {
  const scripted = (url: string, stage: string): Required<Scripted> => {
    const s = {
      gate: "pass",
      mediaUnreachable: false,
      route: "accept",
      level: -1,
      crashIn: "",
      gateFlags: [],
      ...script[url],
    } as Required<Scripted>;
    if (s.crashIn === stage) throw new Error(`scripted crash in ${stage}`);
    return s;
  };
  return {
    rubric,
    policy,
    async acquireRepo(sub) {
      if (scripted(sub.repoUrl, "acquireRepo").gate === "needs_attention") {
        return { snapshot: null, path: null, unreachableReason: "repository not found or private" };
      }
      const snapshot = RepoSnapshotSchema.parse({
        url: sub.repoUrl,
        commitSha: "0".repeat(40),
        committerDate: "2026-10-01T00:00:00Z",
        fileCount: 3,
      });
      return { snapshot, path: `/fake/${sub.id}`, unreachableReason: null };
    },
    async scanArmoriq() {
      return ArmorIQEvidenceSchema.parse({});
    },
    async decideGate(_evidence, snapshot) {
      const s = scripted(snapshot.url, "decideGate");
      return GateResultSchema.parse({
        status: s.gate,
        reasons: [`scripted ${s.gate}`],
        flags: s.gateFlags,
        feedbackMd: s.gate === "fail" ? "scripted DQ" : null,
      });
    },
    async ingestMedia(sub) {
      if (scripted(sub.repoUrl, "ingestMedia").mediaUnreachable) {
        return MediaDigestSchema.parse({
          unreachable: { video: "link returned a login page instead of a video" },
        });
      }
      return MediaDigestSchema.parse({
        deck: { sourceFormat: "pdf", slideCount: 1, slides: [{ index: 1, text: "Our pitch" }] },
        video: {
          durationS: 60,
          hasSpeech: true,
          transcript: [{ startS: 0, endS: 5, text: "Hello judges" }],
          keyframes: [],
        },
      });
    },
    async prescreen(sub) {
      scripted(sub.repoUrl, "prescreen");
      return PrescreenResultSchema.parse({ flags: { deck_is_real_pitch: 0.9 } });
    },
    async analyze(source, sub) {
      scripted(sub.repoUrl, "analyze");
      return ArtifactFindingsSchema.parse({
        source,
        summary: `${source} looks fine`,
        findings: forSource(rubric, source).map((c) => ({ criterionId: c.id, observations: ["scripted"] })),
      });
    },
    async synthesize(sub) {
      const s = scripted(sub.repoUrl, "synthesize");
      return ScorecardSchema.parse({
        scores: rubric.criteria.map((c) => {
          const level = (s.level + c.levels.length) % c.levels.length;
          return { criterionId: c.id, levelLabel: c.levels[level].label, level, rationale: "scripted" };
        }),
      });
    },
    /** Real routing math over a scripted Jev: agreeing (accept) or evenly spread (review) probabilities. */
    async calibrate(sub, card, _media, pre, _evidence, gateFlags) {
      const s = scripted(sub.repoUrl, "calibrate");
      const raw = card.scores.map((score) => {
        const n = rubric.criteria.find((c) => c.id === score.criterionId)?.levels.length ?? 2;
        const probs = Array.from({ length: n }, (_, i) =>
          s.route === "accept" ? Number(i === score.level) : 1 / n,
        );
        return CriterionCalibrationSchema.parse({
          criterionId: score.criterionId,
          llmLevel: score.level,
          jevScore: probs.reduce((sum, p, i) => sum + p * i, 0),
          jevProbs: probs,
          sufficiency: 0.9,
        });
      });
      const criteria = recompute(raw, policy.routing);
      const decision = decideRoute(criteria, rubric, policy.routing, pre.flags, gateFlags);
      return CalibrationResultSchema.parse({
        criteria,
        autoScore: weightedScore(rubric, levelsById(card)),
        confidence: decision.confidence,
        route: decision.route,
        reasons: decision.reasons,
        discrepancyNotes: decision.notes,
        flags: pre.flags,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Offline LLM for ADK agents.

import { BaseLlm, type LlmRequest, type LlmResponse } from "@google/adk";

/** Replies with queued strings (or a function of the request) and records every request. */
export class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly replies: string[] = [],
    private readonly replyFn?: (request: LlmRequest) => string,
  ) {
    super({ model: "scripted" });
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const text = this.replyFn ? this.replyFn(request) : (this.replies.shift() ?? "");
    yield {
      content: { role: "model", parts: [{ text }] },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    } as LlmResponse;
  }

  override async connect(): Promise<never> {
    throw new Error("ScriptedLlm does not support live connections");
  }
}

/** Valid structured output for whichever agent a request is for, read off its response schema (level index 2). */
export const schemaReply =
  (rubric: Rubric) =>
  (request: LlmRequest): string => {
    const schema = request.config?.responseSchema as { properties: Record<string, { properties?: object }> };
    const label = (id: string) => rubric.criteria.find((c) => c.id === id)?.levels[2].label;
    if (schema.properties.scores) {
      return JSON.stringify({
        scores: Object.fromEntries(
          rubric.criteria.map((c) => [c.id, { level: label(c.id), rationale: "r", citations: [] }]),
        ),
        strengths: [],
        weaknesses: [],
        inconsistencies: [],
        feedbackMd: "ok",
      });
    }
    const ids = Object.keys(schema.properties.findings.properties ?? {});
    return JSON.stringify({
      summary: "s",
      claims: [],
      redFlags: [],
      findings: Object.fromEntries(
        ids.map((id) => [id, { observations: ["o"], citations: [], provisionalLevel: label(id) }]),
      ),
    });
  };

/** A ScriptedLlm that takes `delayMs` per call and records the peak number of calls in flight. */
export class SlowLlm extends ScriptedLlm {
  inFlight = 0;
  peak = 0;
  constructor(
    replyFn: (request: LlmRequest) => string,
    private readonly delayMs = 30,
  ) {
    super([], replyFn);
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight -= 1;
    yield* super.generateContentAsync(request);
  }
}
