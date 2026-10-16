import { zstdDecompressSync } from "node:zlib";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { TypeSafeJevClient } from "../../src/jev/client";
import { FakeJevClient } from "../fakes";

const fakeFetch = (seen: { body?: Record<string, unknown> }) => async (_url: unknown, init?: RequestInit) => {
  seen.body = JSON.parse(String(init?.body));
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        n: { type: "noul", noul: 0.9 },
        c: { type: "choice", choice: "b", confidence: 0.7, probabilities: { a: 0.2, b: 0.8 } },
        s: {
          type: "score",
          score: 1.43,
          confidence: 0.35,
          legend: { 0: "x", 1: "y", 2: "z" },
          probabilities: { 2: 0.43, 0: 0, 1: 0.57 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req_1" } },
  );
};

describe("TypeSafeJevClient", () => {
  it("normalizes noul, choice and score answers", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const sdk = new TypeSafeClient({ apiKey: "test", fetch: fakeFetch(seen) });
    const client = new TypeSafeJevClient("jev-1.13.0", 8, sdk);
    const out = await client.decide(
      { x: 1 },
      { n: noul("yes?"), c: choice("pick", { a: null, b: null }), s: score("lvl", ["x", "y", "z"]) },
    );
    expect(seen.body?.model).toBe("jev-1.13.0");
    expect(out.n).toMatchObject({ value: 0.9, confidence: 0.9, requestId: "req_1", type: "noul" });
    expect(out.n.probabilities?.yes).toBe(0.9);
    expect(out.c).toMatchObject({ value: "b", confidence: 0.7 });
    expect(out.s.value).toBe(1.43);
    expect(out.s.probabilities).toEqual({ "0": 0, "1": 0.57, "2": 0.43 });
    expect(client.calls).toBe(1);
  });

  // SDK 0.7: usage token counts may be null and the request id header may be absent.
  it("tolerates null usage and a missing request id", async () => {
    const fetch = async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { n: { type: "noul", noul: 0.2 } },
          usage: { input_tokens: null, output_tokens: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = new TypeSafeJevClient("jev-1.13.0", 8, new TypeSafeClient({ apiKey: "test", fetch }));
    const out = await client.decide({ x: 1 }, { n: noul("yes?") });
    expect(out.n).toMatchObject({ type: "noul", value: 0.2, confidence: 0.8, requestId: null });
  });

  // SDK 0.7 zstd-compresses bodies over 1 KiB on Node 22.15+; large states (deck text) must arrive intact.
  it.runIf(typeof zstdDecompressSync === "function")("sends a large state intact under zstd", async () => {
    const seen: { encoding?: string | null; body?: Record<string, unknown> } = {};
    const fetch = async (_url: unknown, init?: RequestInit) => {
      seen.encoding = new Headers(init?.headers).get("content-encoding");
      const raw = Buffer.from(await new Response(init?.body).arrayBuffer());
      seen.body = JSON.parse((seen.encoding === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"));
      return new Response(
        JSON.stringify({ model: "jev-1.13.0", answers: { n: { type: "noul", noul: 1 } } }),
        {
          status: 200,
          headers: { "content-type": "application/json", "x-typesafe-request-id": "req_2" },
        },
      );
    };
    const deck = "slide text ".repeat(2_000);
    const client = new TypeSafeJevClient("jev-1.13.0", 8, new TypeSafeClient({ apiKey: "test", fetch }));
    const out = await client.decide({ deck }, { n: noul("yes?") });
    expect(seen.encoding).toBe("zstd");
    expect(seen.body).toMatchObject({ model: "jev-1.13.0", state: { deck } });
    expect(out.n.requestId).toBe("req_2");
  });

  it("does not need TYPESAFE_API_KEY until the first decision", () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    expect(() => new TypeSafeJevClient("jev-1.13.0")).not.toThrow();
    if (saved) process.env.TYPESAFE_API_KEY = saved;
  });
});

describe("FakeJevClient", () => {
  it("answers from the script and records calls", async () => {
    const fake = new FakeJevClient({ q: 0.95 });
    const out = await fake.decide({ s: 1 }, { q: noul("?") });
    expect(out.q.value).toBe(0.95);
    expect(fake.calls).toHaveLength(1);
  });
});
