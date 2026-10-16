/** The Fastify app: auth, OpenAPI, the JSON API under /api, media, and (when built) the React UI at /. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError, z } from "zod";
import { DEFAULT_LIMITS, type MediaLimits } from "../digest/media";
import { VERSION } from "../index";
import type { BuildDeps } from "../pipeline/deps";
import { buildProductionDeps } from "../pipeline/production";
import { ReviewError } from "../review";
import type { Settings } from "../settings";
import type { DB } from "../store/db";
import * as q from "../store/queries";
import { authHook, SESSION_COOKIE, tokenMatches } from "./auth";
import type { ApiContext } from "./context";
import { RunJobs } from "./jobs";
import { hackathonRoutes } from "./routes/hackathons";
import { mediaRoutes } from "./routes/media";
import { runRoutes } from "./routes/runs";
import { submissionRoutes } from "./routes/submissions";

export interface AppOptions {
  settings: Settings;
  db: DB;
  buildDeps?: BuildDeps;
  /** Directory of the built React UI (web/dist); served at / when it exists. */
  webDist?: string | null;
  /** Upload size limits (tests shrink them). */
  limits?: MediaLimits;
  logger?: boolean;
}

function statusFor(err: unknown): number {
  if (err instanceof q.NotFoundError) return 404;
  if (err instanceof q.StatusConflict || err instanceof q.AlreadyExists) return 409;
  if (err instanceof ReviewError) return err.httpStatus;
  if (err instanceof q.InputError || err instanceof ZodError) return 400;
  const code = (err as FastifyError).statusCode;
  return code && code >= 400 && code < 500 ? code : 500;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { settings, db } = opts;
  const token = settings.adminToken;
  if (!token)
    throw new Error("set HACKEVAL_ADMIN_TOKEN to serve the API (the UI and API always require auth)");
  const webDist =
    opts.webDist && existsSync(resolve(opts.webDist, "index.html")) ? resolve(opts.webDist) : null;

  const limits = opts.limits ?? DEFAULT_LIMITS;
  const app = Fastify({ logger: opts.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Math.max(limits.deckMaxBytes, limits.videoMaxBytes),
      files: 2,
      fields: 20,
    },
  });
  await app.register(fastifySwagger, {
    openapi: {
      info: { title: "hackeval API", version: VERSION },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  // One @fastify/static registration: it serves the UI when built, and provides reply.sendFile for media.
  await app.register(fastifyStatic, {
    root: webDist ?? resolve(settings.workspace),
    serve: Boolean(webDist),
  });

  app.addHook("onRequest", authHook(token));
  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err))
      return reply.code(400).send({ error: "invalid request", issues: err.validation });
    const status = statusFor(err);
    if (status >= 500) {
      req.log.error(err);
      return reply.code(500).send({ error: "internal error" });
    }
    const issues = err instanceof ZodError ? err.issues : undefined;
    return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), issues });
  });

  const jobs = new RunJobs(db, settings, opts.buildDeps ?? buildProductionDeps);
  const ctx: ApiContext = { db, settings, jobs, limits };

  app.get("/api/health", { schema: { hide: true } }, async () => ({ ok: true, version: VERSION }));
  app.post("/api/session", { schema: { body: z.object({ token: z.string() }) } }, async (req, reply) => {
    if (!tokenMatches(req.body.token, token)) return reply.code(401).send({ error: "unauthorized" });
    return reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: req.protocol === "https",
      })
      .code(204)
      .send();
  });
  app.delete("/api/session", {}, async (_req, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: "/" }).code(204).send(),
  );

  await app.register(hackathonRoutes(ctx));
  await app.register(submissionRoutes(ctx));
  await app.register(runRoutes(ctx));
  await app.register(mediaRoutes(ctx));
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.setNotFoundHandler((req, reply) => {
    if (webDist && req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not found" });
  });
  app.addHook("onClose", async () => jobs.drain());
  return app;
}
