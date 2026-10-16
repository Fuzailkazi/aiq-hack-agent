/** One admin token, sent as `Authorization: Bearer <token>` or held in an HttpOnly session cookie (for <img>/<video>). */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "hackeval_session";
const PUBLIC = new Set(["GET /api/health", "POST /api/session"]);
/** @fastify/static's wildcard route for the built UI (no data: the UI fetches everything through /api). */
const STATIC_ROUTE = "/*";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison (hashing first makes the lengths equal). */
export const tokenMatches = (given: string | undefined, expected: string): boolean =>
  given !== undefined && timingSafeEqual(digest(given), digest(expected));

/**
 * Deny by default, decided by the route the router matched (it percent-decodes, so the raw URL cannot be trusted):
 * every registered route needs the token except the public ones and the static UI files.
 */
export function authHook(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions.url;
    if (route === undefined || route === STATIC_ROUTE || PUBLIC.has(`${req.method} ${route}`)) return;
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (tokenMatches(bearer, token) || tokenMatches(req.cookies[SESSION_COOKIE], token)) return;
    return reply.code(401).send({ error: "unauthorized" });
  };
}
