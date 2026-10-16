/** ADK Workflow for the ArmorIQ eligibility gate. Wiring only: the logic lives in the injected deps. */
import { FunctionNode, START, Workflow } from "@google/adk";
import { GateResultSchema } from "../schemas/evaluation";
import { RepoSnapshotSchema } from "../schemas/evidence";
import { SubmissionSchema } from "../schemas/submission";
import type { PipelineDeps } from "./deps";
import { nodeEvent } from "./events";

export function buildGateWorkflow(deps: PipelineDeps): Workflow {
  const acquireRepo = new FunctionNode("acquire_repo", async (ctx) => {
    const acquisition = await deps.acquireRepo(SubmissionSchema.parse(ctx.state.get("submission")));
    if (!acquisition.snapshot || !acquisition.path) {
      const reason = acquisition.unreachableReason ?? "unknown error";
      const gate = GateResultSchema.parse({
        status: "needs_attention",
        reasons: [`repository unreachable: ${reason}`],
      });
      return nodeEvent({ state: { gate }, route: "unreachable" });
    }
    return nodeEvent({
      state: { repo: acquisition.snapshot, repoPath: acquisition.path },
      route: "acquired",
    });
  });

  const armoriqGate = new FunctionNode("armoriq_gate", async (ctx) => {
    const evidence = await deps.scanArmoriq(String(ctx.state.get("repoPath")));
    const gate = await deps.decideGate(evidence, RepoSnapshotSchema.parse(ctx.state.get("repo")));
    return nodeEvent({ state: { evidence, gate } });
  });

  const gateDone = new FunctionNode("gate_done", async () => nodeEvent({ output: "gate_done" }));

  return new Workflow({
    name: "gate_workflow",
    edges: [
      [START, acquireRepo, { acquired: armoriqGate, unreachable: gateDone }],
      [armoriqGate, gateDone],
    ],
  });
}
