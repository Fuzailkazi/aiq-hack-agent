/** The Fastify app: auth, OpenAPI, the JSON API under /api, media, and (when built) the React UI at /. */

import { randomBytes } from "node:crypto";
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
import {
  authHook,
  finishGoogleSignIn,
  type GoogleAuthConfig,
  isLoopbackUrl,
  LOCAL_ONLY_USER,
  OAUTH_COOKIE,
  parseAllowlist,
  SESSION_COOKIE,
  SESSION_TTL_S,
  SignInRejected,
  sessionCookie,
  sessionEmail,
  startGoogleSignIn,
} from "./auth";
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
  /** Token-endpoint fetch for Google sign-in (tests fake Google). */
  googleFetch?: typeof fetch;
}

/** Google sign-in settings, or a clear error saying what to set. */
export function googleAuthConfig(settings: Settings): GoogleAuthConfig {
  if (!settings.googleClientId || !settings.googleClientSecret)
    throw new Error(
      "set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to serve the UI (sign in with Google; see docs/runbook.md)",
    );
  const allowedEmails = parseAllowlist(settings.allowedEmails);
  if (!allowedEmails.size) throw new Error("HACKEVAL_ALLOWED_EMAILS lists no one, so nobody could sign in");
  return {
    clientId: settings.googleClientId,
    clientSecret: settings.googleClientSecret,
    allowedEmails,
    // Without a configured secret, sessions simply end when the server restarts.
    sessionSecret: settings.sessionSecret ?? randomBytes(32).toString("hex"),
    publicUrl: settings.publicUrl,
  };
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
  if (settings.localOnly && !isLoopbackUrl(settings.publicUrl))
    throw new Error(
      `HACKEVAL_LOCAL_ONLY skips sign-in, so it only runs with a localhost HACKEVAL_PUBLIC_URL (got ${settings.publicUrl}); use Google sign-in instead`,
    );
  const google = settings.localOnly ? null : googleAuthConfig(settings);
  const secureCookies = settings.publicUrl.startsWith("https://");
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
      components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE } } },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  // One @fastify/static registration: it serves the UI when built, and provides reply.sendFile for media.
  await app.register(fastifyStatic, {
    root: webDist ?? resolve(settings.workspace),
    serve: Boolean(webDist),
  });

  if (google) app.addHook("onRequest", authHook(google.sessionSecret));
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
  const cookieBase = { httpOnly: true, path: "/", secure: secureCookies } as const;
  app.get("/api/auth/config", { schema: { hide: true } }, async () => ({
    provider: google ? "google" : "local",
    // Who to ask for access, without listing everyone.
    contact: google ? ([...google.allowedEmails][0] ?? null) : null,
  }));
  if (google) {
    app.get("/api/auth/google", { schema: { hide: true } }, async (_req, reply) => {
      const { url, cookie } = startGoogleSignIn(google);
      // Lax, not Strict: the cookie must come back on Google's top-level redirect to the callback.
      return reply
        .setCookie(OAUTH_COOKIE, cookie, { ...cookieBase, sameSite: "lax", maxAge: 600 })
        .redirect(url);
    });
    app.get(
      "/api/auth/google/callback",
      {
        schema: {
          hide: true,
          querystring: z.object({
            code: z.string().optional(),
            state: z.string().optional(),
            error: z.string().optional(),
          }),
        },
      },
      async (req, reply) => {
        reply.clearCookie(OAUTH_COOKIE, { path: "/" });
        try {
          const email = await finishGoogleSignIn(
            google,
            req.query,
            req.cookies[OAUTH_COOKIE],
            opts.googleFetch,
          );
          req.log.info({ email }, "signed in");
          return reply
            .setCookie(SESSION_COOKIE, sessionCookie(google.sessionSecret, email), {
              ...cookieBase,
              sameSite: "lax",
              maxAge: SESSION_TTL_S,
            })
            .redirect("/");
        } catch (e) {
          const message = e instanceof SignInRejected ? e.message : "sign-in failed";
          if (!(e instanceof SignInRejected)) req.log.error(e);
          return reply.redirect(`/?signin_error=${encodeURIComponent(message)}`);
        }
      },
    );
  }
  app.get(
    "/api/session",
    { schema: { response: { 200: z.object({ email: z.string() }) } } },
    async (req) => ({
      email: google
        ? (sessionEmail(google.sessionSecret, req.cookies[SESSION_COOKIE]) ?? "")
        : LOCAL_ONLY_USER,
    }),
  );
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
