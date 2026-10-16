/** Runs an ADK Workflow once per submission, each run in its own in-memory session. */
import { InMemoryRunner, type Workflow } from "@google/adk";

const APP_NAME = "hackeval";
const USER_ID = "pipeline";

export class WorkflowRunner {
  private readonly runner: InMemoryRunner;

  constructor(workflow: Workflow) {
    this.runner = new InMemoryRunner({ agent: workflow, appName: APP_NAME });
  }

  /** Run with `state` as the initial session state and return the final state. Node errors are rethrown. */
  async run(state: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessions = this.runner.sessionService;
    const session = await sessions.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: toJson(state),
    });
    try {
      const events = this.runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: "run" }] },
      });
      for await (const _event of events) {
        // Draining the stream drives the workflow; results land in session state.
      }
      const final = await sessions.getSession({ appName: APP_NAME, userId: USER_ID, sessionId: session.id });
      if (!final) throw new Error(`session ${session.id} vanished during the run`);
      return { ...final.state };
    } finally {
      await sessions.deleteSession({ appName: APP_NAME, userId: USER_ID, sessionId: session.id });
    }
  }
}

/** Session state must be plain JSON. */
const toJson = (value: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(value));
