/**
 * Sign in with Google, restricted to an email allowlist. There is no shared token: Google proves who the person is,
 * the server checks the verified email against HACKEVAL_ALLOWED_EMAILS, and issues a signed HttpOnly session cookie
 * (so slide images and video load too).
 *
 * Flow: GET /api/auth/google -> Google (OAuth 2.0 code flow with PKCE and a state value) -> GET
 * /api/auth/google/callback -> code exchanged server-side (with the client secret, over TLS) for an ID token ->
 * issuer, audience, expiry and email_verified checked -> allowlist checked -> session cookie -> redirect to the UI.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "hackeval_session";
export const OAUTH_COOKIE = "hackeval_oauth";
export const SESSION_TTL_S = 12 * 3600;
const OAUTH_TTL_S = 600;
const PUBLIC = new Set([
  "GET /api/health",
  "GET /api/auth/google",
  "GET /api/auth/google/callback",
  "GET /api/auth/config",
]);
/** @fastify/static's wildcard route for the built UI (no data: the UI fetches everything through /api). */
const STATIC_ROUTE = "/*";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Lowercased emails allowed in. */
  allowedEmails: Set<string>;
  /** HMAC key for session and OAuth-state cookies. */
  sessionSecret: string;
  /** Where the browser reaches this server, e.g. http://127.0.0.1:8000; the callback lives under it. */
  publicUrl: string;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const mac = (secret: string, body: string) => b64url(createHmac("sha256", secret).update(body).digest());

function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** `<base64url(JSON)>.<HMAC>`; returns the payload when the signature is valid and it has not expired. */
export function sign(secret: string, payload: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${mac(secret, body)}`;
}

export function verify<T extends { exp: number }>(
  secret: string,
  value: string | undefined,
  now = Date.now(),
): T | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), mac(secret, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    return typeof payload.exp === "number" && payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

export const sessionCookie = (secret: string, email: string, now = Date.now()) =>
  sign(secret, { email, exp: Math.floor(now / 1000) + SESSION_TTL_S });

export const sessionEmail = (secret: string, value: string | undefined): string | null =>
  verify<{ email: string; exp: number }>(secret, value)?.email ?? null;

export const parseAllowlist = (raw: string): Set<string> =>
  new Set(
    raw
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

/**
 * Deny by default, decided by the route the router matched (it percent-decodes, so the raw URL cannot be trusted):
 * every registered route needs a valid session except the public ones and the static UI files.
 */
export function authHook(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions.url;
    if (route === undefined || route === STATIC_ROUTE || PUBLIC.has(`${req.method} ${route}`)) return;
    if (sessionEmail(secret, req.cookies[SESSION_COOKIE])) return;
    return reply.code(401).send({ error: "unauthorized" });
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase());
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
export const LOCAL_ONLY_USER = "local mode (no sign-in)";

export const callbackUrl = (cfg: GoogleAuthConfig) =>
  `${cfg.publicUrl.replace(/\/+$/, "")}/api/auth/google/callback`;

/** Start: a fresh state and PKCE verifier, kept in a short-lived signed cookie, and the Google consent URL. */
export function startGoogleSignIn(cfg: GoogleAuthConfig, now = Date.now()): { url: string; cookie: string } {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(cfg),
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return {
    url: `${GOOGLE_AUTH_URL}?${params}`,
    cookie: sign(cfg.sessionSecret, { state, verifier, exp: Math.floor(now / 1000) + OAUTH_TTL_S }),
  };
}

export class SignInRejected extends Error {}

/** Claims from an ID token's payload. The token comes straight from Google's token endpoint over TLS. */
function idTokenClaims(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1];
  if (!part) throw new SignInRejected("malformed ID token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Finish: check state, exchange the code, validate the ID token, and return the allowed email. */
export async function finishGoogleSignIn(
  cfg: GoogleAuthConfig,
  query: { code?: string; state?: string; error?: string },
  oauthCookie: string | undefined,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  if (query.error) throw new SignInRejected(`Google sign-in was cancelled (${query.error})`);
  const pending = verify<{ state: string; verifier: string; exp: number }>(
    cfg.sessionSecret,
    oauthCookie,
    now,
  );
  if (!pending || !query.state || !safeEqual(pending.state, query.state))
    throw new SignInRejected("sign-in expired or was started elsewhere; try again");
  if (!query.code) throw new SignInRejected("Google did not return a code");
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: query.code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: callbackUrl(cfg),
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  if (!response.ok) throw new SignInRejected(`Google rejected the sign-in (HTTP ${response.status})`);
  const { id_token: idToken } = (await response.json()) as { id_token?: string };
  if (!idToken) throw new SignInRejected("Google returned no ID token");
  const claims = idTokenClaims(idToken);
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw new SignInRejected("ID token is not from Google");
  if (claims.aud !== cfg.clientId) throw new SignInRejected("ID token is for another app");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now)
    throw new SignInRejected("ID token expired");
  const email = String(claims.email ?? "").toLowerCase();
  if (!email || claims.email_verified !== true)
    throw new SignInRejected("Google account has no verified email");
  if (!cfg.allowedEmails.has(email)) throw new SignInRejected(`${email} is not allowed to use this app`);
  return email;
}
