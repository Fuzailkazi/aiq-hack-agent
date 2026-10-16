/** Every test talks to a fake API: `mockApi({ "GET /api/x": body | (req) => Response })`. */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

type Handler = object | ((req: Request) => Response | object | Promise<Response | object>);
let routes: Record<string, Handler> = {};
export const calls: { method: string; path: string; body: unknown }[] = [];

export function mockApi(r: Record<string, Handler>) {
  routes = r;
  calls.length = 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;
  const text = req.method === "GET" ? "" : await req.clone().text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // multipart or plain text
  }
  calls.push({ method: req.method, path: url.pathname + url.search, body });
  const handler = routes[key];
  if (!handler) return json({ error: `no mock for ${key}` }, 404);
  const out = typeof handler === "function" ? await handler(req) : handler;
  return out instanceof Response ? out : json(out);
}) as typeof fetch;

// jsdom lacks these browser APIs; the design-system primitives (Tooltip, Popover, media queries) touch them.
globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => cleanup());
