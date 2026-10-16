/** Hackathons, rubric activation, the review queue and the leaderboard. */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { buildLeaderboard, leaderboardCsv } from "../../leaderboard";
import { RubricSchema } from "../../schemas/rubric";
import { reviewQueue } from "../../service";
import { modelsOf } from "../../settings";
import * as q from "../../store/queries";
import { usageReport } from "../../usage";
import type { ApiContext } from "../context";
import {
  CreateHackathonSchema,
  HackathonDetailSchema,
  HackathonSchema,
  HidParams,
  LeaderboardRowSchema,
  QueueItemSchema,
  RubricActivatedSchema,
  RubricUploadSchema,
} from "../schemas";

export const hackathonRoutes =
  ({ db, settings }: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get("/api/hackathons", { schema: { response: { 200: z.array(HackathonSchema) } } }, async () =>
      q.listHackathons(db),
    );

    app.post(
      "/api/hackathons",
      { schema: { body: CreateHackathonSchema, response: { 201: HackathonSchema } } },
      async (req, reply) => {
        const { id, name, deadline } = req.body;
        return reply.code(201).send(q.createHackathon(db, id, name ?? id, deadline ?? null));
      },
    );

    app.get(
      "/api/hackathons/:hid",
      { schema: { params: HidParams, response: { 200: HackathonDetailSchema } } },
      async (req) => {
        const hackathon = q.getHackathon(db, req.params.hid);
        const rubric = hackathon.activeRubricId ? q.activeRubric(db, hackathon.id) : null;
        return {
          hackathon,
          rubric,
          byStatus: q.statusCounts(db, hackathon.id),
          usage: usageReport(db, hackathon.id, modelsOf(settings)),
        };
      },
    );

    app.put(
      "/api/hackathons/:hid/rubric",
      { schema: { params: HidParams, body: RubricUploadSchema, response: { 200: RubricActivatedSchema } } },
      async (req) => {
        let raw: unknown;
        try {
          raw = parseYaml(req.body.yaml);
        } catch (e) {
          throw new q.InputError(`rubric is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
        }
        const rubric = RubricSchema.parse(raw);
        const staled = q.activateRubric(db, req.params.hid, rubric);
        return { id: rubric.id, version: rubric.version, staled };
      },
    );

    app.get(
      "/api/hackathons/:hid/review-queue",
      { schema: { params: HidParams, response: { 200: z.array(QueueItemSchema) } } },
      async (req) => reviewQueue(db, q.getHackathon(db, req.params.hid).id),
    );

    app.get(
      "/api/hackathons/:hid/leaderboard",
      { schema: { params: HidParams, response: { 200: z.array(LeaderboardRowSchema) } } },
      async (req) => buildLeaderboard(db, q.getHackathon(db, req.params.hid).id),
    );

    app.get("/api/hackathons/:hid/leaderboard.csv", { schema: { params: HidParams } }, async (req, reply) => {
      const id = q.getHackathon(db, req.params.hid).id;
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="leaderboard-${id}.csv"`)
        .send(leaderboardCsv(buildLeaderboard(db, id)));
    });
  };
