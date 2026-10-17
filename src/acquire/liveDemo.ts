/**
 * Check a team's live demo URL: does it load, and what does the landing page say? One GET per hop, no login, no
 * interaction. Team-supplied URLs are fetched from the organizer's machine, so private and internal addresses are
 * refused at every redirect hop (a DNS answer that changes between check and fetch is out of scope).
 *
 * Free hosts (Render, Railway, ...) answer 502/503/504 while a sleeping app cold-starts, so those are retried. A
 * server that answers 401/403/405 is online but not a browsable page (e.g. an MCP or API endpoint): reachable, with a
 * note in `error`.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LiveDemoCheck } from "../schemas/evidence";

export type Resolver = (host: string) => Promise<string[]>;

export interface LiveDemoOptions {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  timeoutS?: number;
  maxBytes?: number;
  maxRedirects?: number;
  excerptChars?: number;
  /** Retries after a 502/503/504 (cold start), waiting retryDelayS between attempts. */
  retries?: number;
  retryDelayS?: number;
}

const COLD_START = new Set([502, 503, 504]);
const ONLINE_NOT_A_PAGE = new Set([401, 403, 405]);

const systemResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Private(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    /^fe[89ab]/.test(v6) ||
    v6.startsWith("ff")
  );
}

async function refusal(url: URL, resolve: Resolver): Promise<string | null> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return `unsupported scheme ${url.protocol}`;
  if (url.username || url.password) return "URL contains credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return "private host";
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return "host does not resolve";
  }
  if (!addresses.length) return "host does not resolve";
  if (addresses.some(isPrivateAddress)) return "host resolves to a private address";
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** The <title> and visible text of an HTML page (scripts, styles and tags removed). */
export function pageText(html: string, maxChars: number): { title: string; excerpt: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, excerpt: text.slice(0, maxChars) };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

export async function checkLiveDemo(rawUrl: string, opts: LiveDemoOptions = {}): Promise<LiveDemoCheck> {
  const retries = opts.retries ?? 3;
  let check = await checkOnce(rawUrl, opts);
  for (let i = 0; i < retries && check.status !== null && COLD_START.has(check.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, (opts.retryDelayS ?? 20) * 1000));
    check = await checkOnce(rawUrl, opts);
  }
  if (check.status !== null && COLD_START.has(check.status))
    check.error = `${check.error} (still failing after ${retries} retries; the app may be asleep or down)`;
  return check;
}

async function checkOnce(rawUrl: string, opts: LiveDemoOptions): Promise<LiveDemoCheck> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve = opts.resolve ?? systemResolve;
  const maxRedirects = opts.maxRedirects ?? 5;
  const base = { url: rawUrl, status: null, finalUrl: null, title: "", excerpt: "" };
  const fail = (error: string, extra: Partial<LiveDemoCheck> = {}): LiveDemoCheck => ({
    ...base,
    ...extra,
    reachable: false,
    error,
  });
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("not a valid URL");
  }
  const deadline = AbortSignal.timeout((opts.timeoutS ?? 20) * 1000);
  for (let hop = 0; ; hop++) {
    const refused = await refusal(url, resolve);
    if (refused) return fail(`refused: ${refused}`, { finalUrl: url.toString() });
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal: deadline,
        headers: { "user-agent": "hackeval-live-demo-check/1", accept: "text/html,*/*;q=0.8" },
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "network error";
      return fail(
        name === "TimeoutError" || name === "AbortError" ? "timed out" : `request failed (${name})`,
        {
          finalUrl: url.toString(),
        },
      );
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= maxRedirects) return fail("too many redirects", { status: response.status });
      try {
        url = new URL(location, url);
      } catch {
        return fail("invalid redirect", { status: response.status });
      }
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    const body =
      type.includes("html") || type.startsWith("text/")
        ? await readCapped(response, opts.maxBytes ?? 300_000)
        : "";
    if (!body) await response.body?.cancel();
    const { title, excerpt } = type.includes("html")
      ? pageText(body, opts.excerptChars ?? 1500)
      : { title: "", excerpt: body.slice(0, opts.excerptChars ?? 1500) };
    const extra = { status: response.status, finalUrl: url.toString(), title, excerpt };
    if (ONLINE_NOT_A_PAGE.has(response.status))
      return {
        ...base,
        ...extra,
        reachable: true,
        error: `server responded HTTP ${response.status}: online, but the URL is not a browsable page (e.g. an API or MCP endpoint, or a login wall)`,
      };
    if (!response.ok) return fail(`HTTP ${response.status}`, extra);
    return { ...base, ...extra, reachable: true, error: null };
  }
}
