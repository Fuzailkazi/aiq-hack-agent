/**
 * Evidence media for the UI: slide images and keyframes from the stored digest, and the fetched video (with Range).
 * Clients name a submission and an index, never a path; every file must resolve inside the workspace.
 */
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import * as q from "../../store/queries";
import type { ApiContext } from "../context";
import { IdParams, MediaParams } from "../schemas";

const notFound = (what: string) => new q.NotFoundError(`${what} not found`);

export const mediaRoutes =
  ({ db, settings }: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const workspaceReal = (): string => realpathSync(resolve(settings.workspace));

    /** Send `path` only if its real location (symlinks resolved) is inside the workspace. */
    const sendInside = (reply: FastifyReply, path: string | null | undefined, what: string) => {
      if (!path) throw notFound(what);
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        throw notFound(what);
      }
      if (!real.startsWith(workspaceReal() + sep)) throw notFound(what);
      return reply.sendFile(basename(real), dirname(real));
    };

    const mediaOf = (id: string) => {
      q.getSubmission(db, id);
      return q.getEvaluation(db, id)?.media ?? null;
    };

    app.get("/api/submissions/:id/slides/:index", { schema: { params: MediaParams } }, async (req, reply) => {
      const slide = mediaOf(req.params.id)?.deck?.slides.find((s) => s.index === req.params.index);
      return sendInside(reply, slide?.imagePath, "slide image");
    });

    app.get(
      "/api/submissions/:id/keyframes/:index",
      { schema: { params: MediaParams } },
      async (req, reply) => {
        const frame = mediaOf(req.params.id)?.video?.keyframes[req.params.index];
        return sendInside(reply, frame?.imagePath, "keyframe");
      },
    );

    app.get("/api/submissions/:id/video", { schema: { params: IdParams } }, async (req, reply) => {
      const { submission } = q.getSubmission(db, req.params.id);
      const dir = join(resolve(settings.workspace), "media", submission.id);
      let name: string | undefined;
      try {
        name = readdirSync(dir).find((f) => /^video\.[a-z0-9]+$/.test(f));
      } catch {
        name = undefined;
      }
      return sendInside(reply, name && join(dir, name), "video");
    });
  };
