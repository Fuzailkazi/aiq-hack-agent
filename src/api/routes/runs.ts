/** Start a pipeline run in the background and poll it. */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import * as q from "../../store/queries";
import type { ApiContext } from "../context";
import { HidParams, RunJobSchema, StartRunSchema } from "../schemas";

export const runRoutes =
  ({ db, jobs }: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      "/api/hackathons/:hid/runs",
      { schema: { params: HidParams, body: StartRunSchema, response: { 202: RunJobSchema } } },
      async (req, reply) => {
        const hackathon = q.getHackathon(db, req.params.hid);
        if (!hackathon.activeRubricId)
          throw new q.StatusConflict(`hackathon '${hackathon.id}' has no active rubric; upload one first`);
        return reply.code(202).send(jobs.start(hackathon.id, req.body));
      },
    );

    app.get(
      "/api/runs/:runId",
      { schema: { params: z.object({ runId: z.string() }), response: { 200: RunJobSchema } } },
      async (req) => {
        const job = jobs.get(req.params.runId);
        if (!job) throw new q.NotFoundError(`unknown run '${req.params.runId}'`);
        return job;
      },
    );
  };
