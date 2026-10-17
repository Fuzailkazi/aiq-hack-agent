import { describe, expect, it } from "vitest";
import { checkLiveDemo, isPrivateAddress, pageText } from "../../src/acquire/liveDemo";
import { buildAnalystParts, formSummary } from "../../src/agents/messages";
import { youtubeWatchUrl } from "../../src/digest/media";
import { MediaDigestSchema } from "../../src/schemas/evidence";
import { SubmissionSchema } from "../../src/schemas/submission";

const publicDns = async () => ["93.184.216.34"];

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const route = routes[url];
    if (!route) throw new TypeError(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch;
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

describe("private address detection", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.100.1.1", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:10.0.0.1", true],
    ["93.184.216.34", false],
    ["2606:4700::1111", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("live demo check", () => {
  it("loads the page and keeps its title and visible text", async () => {
    const check = await checkLiveDemo("https://demo.example.app/", {
      resolve: publicDns,
      fetchImpl: fakeFetch({
        "https://demo.example.app/": () =>
          html(
            "<html><head><title>SecureFlow &amp; Co</title><style>.x{}</style></head><body><script>evil()</script><h1>Scan your repo</h1></body></html>",
          ),
      }),
    });
    expect(check).toMatchObject({
      reachable: true,
      status: 200,
      title: "SecureFlow & Co",
      excerpt: "SecureFlow & Co Scan your repo",
      error: null,
    });
  });

  it("follows redirects but refuses one that lands on a private address", async () => {
    const check = await checkLiveDemo("https://demo.example.app/", {
      resolve: async (host) => (host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
      fetchImpl: fakeFetch({
        "https://demo.example.app/": () =>
          new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } }),
      }),
    });
    expect(check).toMatchObject({ reachable: false, error: "refused: host resolves to a private address" });
  });

  it("refuses localhost, IP literals in private ranges and non-http schemes without fetching", async () => {
    const never = fakeFetch({});
    for (const url of ["http://localhost:3000", "http://169.254.169.254/latest", "file:///etc/passwd"]) {
      const check = await checkLiveDemo(url, { resolve: publicDns, fetchImpl: never });
      expect(check.reachable).toBe(false);
      expect(check.error).toMatch(/^refused/);
    }
  });

  it("retries a cold start, and reports a demo that stays down", async () => {
    let calls = 0;
    const waking = await checkLiveDemo("https://demo.example.app/", {
      resolve: publicDns,
      retryDelayS: 0,
      fetchImpl: fakeFetch({
        "https://demo.example.app/": () =>
          ++calls < 3 ? html("<title>Application loading</title>", 503) : html("<title>Up</title>"),
      }),
    });
    expect(waking).toMatchObject({ reachable: true, status: 200, title: "Up" });
    expect(calls).toBe(3);
    const down = await checkLiveDemo("https://demo.example.app/", {
      resolve: publicDns,
      retries: 1,
      retryDelayS: 0,
      fetchImpl: fakeFetch({ "https://demo.example.app/": () => html("<title>502</title>", 502) }),
    });
    expect(down).toMatchObject({ reachable: false, status: 502 });
    expect(down.error).toMatch(/^HTTP 502 \(still failing after 1 retries/);
  });

  it("treats an API endpoint that refuses GET as online but not a page", async () => {
    const check = await checkLiveDemo("https://api.example.app/mcp", {
      resolve: publicDns,
      fetchImpl: fakeFetch({ "https://api.example.app/mcp": () => new Response(null, { status: 405 }) }),
    });
    expect(check).toMatchObject({ reachable: true, status: 405 });
    expect(check.error).toMatch(/not a browsable page/);
  });

  it("reports HTTP errors and network failures as unreachable", async () => {
    const gone = await checkLiveDemo("https://demo.example.app/", {
      resolve: publicDns,
      fetchImpl: fakeFetch({ "https://demo.example.app/": () => html("<title>404</title>", 404) }),
    });
    expect(gone).toMatchObject({ reachable: false, status: 404, error: "HTTP 404" });
    const offline = await checkLiveDemo("https://gone.example.app/", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(offline).toMatchObject({ reachable: false, error: "refused: host does not resolve" });
  });

  it("caps page text", () => {
    expect(pageText(`<p>${"a".repeat(5000)}</p>`, 100).excerpt).toHaveLength(100);
  });
});

describe("YouTube links", () => {
  it.each([
    ["https://youtu.be/27dJLkX0d2k", "https://www.youtube.com/watch?v=27dJLkX0d2k"],
    ["https://youtu.be/kBIId121ftI?si=ZFxCT_E-T74ImqSR", "https://www.youtube.com/watch?v=kBIId121ftI"],
    ["https://www.youtube.com/watch?v=abcdefghijk&t=10", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["https://m.youtube.com/shorts/abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["https://www.loom.com/share/abc", null],
    ["https://youtube.com.evil.example/watch?v=abcdefghijk", null],
  ])("%s", (url, expected) => {
    expect(youtubeWatchUrl(url)).toBe(expected);
  });
});

describe("analyst messages", () => {
  const sub = SubmissionSchema.parse({
    id: "s",
    hackathonId: "h",
    teamName: "Dune",
    repoUrl: "https://github.com/o/r",
    liveDemoUrl: "https://demo.example.app/",
    answers: { howArmoriq: "We call invokeWithPolicy.", armortoolsPro: "Yes" },
    submittedAt: "2026-10-14T06:56:21Z",
  });

  it("hands a remote video to the model as a file link", () => {
    const media = MediaDigestSchema.parse({
      video: {
        durationS: 0,
        hasSpeech: true,
        transcript: [],
        keyframes: [],
        remoteUri: "https://www.youtube.com/watch?v=abcdefghijk",
      },
    });
    const parts = buildAnalystParts("video", sub, media, null);
    expect(parts.at(-1)).toEqual({
      fileData: { fileUri: "https://www.youtube.com/watch?v=abcdefghijk", mimeType: "video/*" },
    });
  });

  it("gives the form analyst the answers and the live demo check, fenced", () => {
    const media = MediaDigestSchema.parse({
      liveDemo: { url: "https://demo.example.app/", reachable: false, status: 502, error: "HTTP 502" },
    });
    const summary = formSummary(sub, media);
    expect(summary).toContain("[howArmoriq]\nWe call invokeWithPolicy.");
    expect(summary).toContain("- reachable: no (HTTP 502)");
    const parts = buildAnalystParts("form", sub, media, null);
    expect(parts[1].text).toMatch(/^<<<SUBMISSION_CONTENT/);
  });
});
