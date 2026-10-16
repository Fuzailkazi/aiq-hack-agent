/** Typed API client (types generated from the server's OpenAPI document: `npm run api:spec` at the repo root). */
import createClient from "openapi-fetch";
import type { paths } from "./schema";

/** The session is an HttpOnly cookie set by POST /api/session, so every request is same-origin with credentials. */
export const api = createClient<paths>({
  baseUrl: globalThis.location?.origin ?? "",
  credentials: "same-origin",
});

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};
api.use({
  onResponse({ response }) {
    if (response.status === 401) onUnauthorized();
    return response;
  },
});

/** Turn an openapi-fetch result into data or a thrown Error carrying the server's message. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    const message = (result.error as { error?: string } | undefined)?.error;
    throw new Error(message ?? `request failed (${result.response.status})`);
  }
  return result.data;
}

/** Multipart bodies go through as-is (the browser sets the boundary). */
export const asForm = { bodySerializer: (body: unknown) => body as FormData };

type Json<P extends keyof paths, M extends "get" | "post" | "put", S extends number> = paths[P][M] extends {
  responses: { [K in S]: { content: { "application/json": infer T } } };
}
  ? T
  : never;

export type Hackathon = Json<"/api/hackathons", "get", 200>[number];
export type HackathonDetail = Json<"/api/hackathons/{hid}", "get", 200>;
export type SubmissionRow = Json<"/api/hackathons/{hid}/submissions", "get", 200>[number];
export type SubmissionDetail = Json<"/api/submissions/{id}", "get", 200>;
export type Evaluation = NonNullable<SubmissionDetail["evaluation"]>;
export type Rubric = NonNullable<HackathonDetail["rubric"]>;
export type QueueItem = Json<"/api/hackathons/{hid}/review-queue", "get", 200>[number];
export type LeaderboardRow = Json<"/api/hackathons/{hid}/leaderboard", "get", 200>[number];
export type RunJob = Json<"/api/runs/{runId}", "get", 200>;
export type Status = SubmissionRow["status"];
export type Citation = Evaluation["findings"][number]["findings"][number]["citations"][number];
