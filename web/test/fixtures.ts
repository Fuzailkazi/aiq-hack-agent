/** API payloads shaped like the server's (only the fields the UI reads). */
export const RUBRIC = {
  id: "example",
  version: "1",
  tracks: [],
  criteria: [
    {
      id: "problem",
      name: "Problem & solution",
      description: "d",
      weight: 0.5,
      sources: ["deck", "video"],
      levels: ["Missing", "Vague", "Clear", "Compelling"].map((label) => ({
        label,
        description: `${label} desc`,
      })),
    },
    {
      id: "demo",
      name: "Demo",
      description: "d",
      weight: 0.5,
      sources: ["video"],
      levels: ["Missing", "Mockup", "Partial", "End-to-end"].map((label) => ({
        label,
        description: `${label} desc`,
      })),
    },
  ],
};

export const HACKATHON = {
  hackathon: { id: "h", name: "Hack", deadline: null, activeRubricId: "example", activeRubricVersion: "1" },
  rubric: RUBRIC,
  byStatus: { finalized: 2, needs_review: 1 },
  usage: {
    submissions: 3,
    usage: { llmCalls: 9, inputTokens: 12000, outputTokens: 3000, jevCalls: 24, byModel: {} },
    estimatedCostUsd: null,
    costPerSubmissionUsd: null,
    unpriced: ["gpt-5-mini"],
  },
};

export function submission(status = "needs_review") {
  return {
    submission: {
      id: "s1",
      hackathonId: "h",
      externalId: null,
      teamName: "GuardRail",
      track: null,
      repoUrl: "https://github.com/o/guardrail",
      deck: null,
      video: null,
      liveDemoUrl: null,
      answers: {} as Record<string, string>,
      submittedAt: "2026-10-01T00:00:00Z",
      revision: 1,
    },
    status,
    reasons: status === "needs_review" ? ["demo: agreement 0.10 < 0.50"] : [],
    checks: [{ id: "sdk", label: "ArmorIQ SDK", state: "pass", detail: "Installed and called" }] as {
      id: string;
      label: string;
      state: "pass" | "fail" | "warn" | "pending";
      detail: string;
    }[],
    calibration: null,
    evaluation: {
      submissionId: "s1",
      status,
      rubricId: "example",
      rubricVersion: "1",
      gate: {
        status: "pass",
        checks: {},
        reasons: ["SDK installed and called"],
        flags: [],
        jev: [],
        feedbackMd: null,
      },
      mediaUnreachable: {},
      error: null,
      autoScore: 50,
      finalScore: null,
      reviews: [],
      findings: [],
      evidence: {
        installs: [
          {
            path: "requirements.txt",
            kind: "manifest",
            ecosystem: "pypi",
            package: "armoriq-sdk",
            versionSpec: null,
          },
        ],
        usageSites: [
          {
            path: "app/guard.py",
            line: 12,
            symbol: "invoke",
            kind: "call",
            snippet: "client.invoke(plan)",
            inTest: false,
            typeOnly: false,
          },
        ],
        unresolved: [],
        envSignals: [],
        configFiles: [],
        secretExposed: false,
        redactedKeys: [],
      },
      media: {
        deck: {
          sourceFormat: "pdf",
          slideCount: 3,
          imagesSampled: false,
          renderError: null,
          slides: [
            { index: 1, text: "Title slide", notes: "", imagePath: "/ws/cache/slide-001.png" },
            { index: 2, text: "The problem: agents act without checks", notes: "", imagePath: null },
            { index: 3, text: "Architecture", notes: "", imagePath: null },
          ],
        },
        video: {
          durationS: 60,
          hasSpeech: true,
          keyframes: [],
          transcript: [
            { startS: 0, endS: 30, text: "Hi, we are GuardRail" },
            { startS: 30, endS: 45, text: "Here the guard blocks a tool call" },
          ],
        },
        unreachable: {},
      },
      scorecard: {
        scores: [
          {
            criterionId: "problem",
            levelLabel: "Clear",
            level: 2,
            rationale: "States the problem crisply",
            citations: [
              { source: "deck", ref: "slide 2" },
              { source: "video", ref: "00:31-00:40" },
            ],
          },
          {
            criterionId: "demo",
            levelLabel: "Mockup",
            level: 1,
            rationale: "Screens only",
            citations: [{ source: "repo", ref: "app/guard.py:12" }],
          },
        ],
        strengths: [],
        weaknesses: [],
        inconsistencies: [],
        feedbackMd: "Great problem framing.",
      },
      calibration: {
        criteria: [
          {
            criterionId: "problem",
            llmLevel: 2,
            jevScore: 2,
            jevProbs: [0, 0.1, 0.8, 0.1],
            agreement: 0.8,
            sufficiency: 0.9,
            levelGap: 0,
          },
          {
            criterionId: "demo",
            llmLevel: 1,
            jevScore: 2.6,
            jevProbs: [0, 0.1, 0.2, 0.7],
            agreement: 0.1,
            sufficiency: 0.7,
            levelGap: 1.6,
          },
        ],
        autoScore: 50,
        confidence: 0.45,
        route: "review",
        reasons: ["demo: agreement 0.10 < 0.50"],
        discrepancyNotes: ["demo: LLM level 1 vs Jev expected level 2.60"],
        flags: {},
      },
      usage: { llmCalls: 3, inputTokens: 100, outputTokens: 10, jevCalls: 3, byModel: {} },
    },
  };
}
