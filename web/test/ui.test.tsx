import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { HACKATHON, submission } from "./fixtures";
import { calls, mockApi } from "./setup";

const renderAt = (path: string) => {
  window.history.pushState({}, "", path);
  return render(<App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
};

describe("sign-in", () => {
  it("shows the login form on 401 and signs in with the token", async () => {
    let signedIn = false;
    mockApi({
      "GET /api/hackathons": () =>
        signedIn
          ? [HACKATHON.hackathon]
          : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      "POST /api/session": (req: Request) =>
        req.json().then((b: { token: string }) => {
          signedIn = b.token === "tok";
          return new Response(null, { status: signedIn ? 204 : 401 });
        }),
    });
    renderAt("/");
    const field = await screen.findByLabelText(/Admin token/);
    fireEvent.change(field, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("That token was not accepted.");
    fireEvent.change(field, { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("link", { name: "Hack" })).toBeTruthy();
  });
});

describe("submission detail", () => {
  const api = (status = "needs_review") =>
    mockApi({
      "GET /api/submissions/s1": submission(status),
      "GET /api/hackathons/h": HACKATHON,
      "POST /api/submissions/s1/decision": { from: "needs_review", to: "finalized" },
    });

  it("shows LLM levels next to Jev's distribution and the reasons for review", async () => {
    api();
    renderAt("/s/s1");
    expect(await screen.findByText("Clear (2/3)")).toBeTruthy();
    expect(screen.getByText("Mockup (1/3)")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Jev distribution, LLM chose Mockup" })).toBeTruthy();
    expect(screen.getAllByText("demo: agreement 0.10 < 0.50").length).toBeGreaterThan(0);
    expect(screen.getByText("demo: LLM level 1 vs Jev expected level 2.60")).toBeTruthy();
  });

  it("clicking a citation jumps to the cited slide, transcript moment or code", async () => {
    api();
    renderAt("/s/s1");
    fireEvent.click(await screen.findByRole("button", { name: "deck: slide 2" }));
    expect(screen.getByTestId("slide-2").dataset.focused).toBe("true");
    expect(screen.getByTestId("slide-1").dataset.focused).toBe("false");
    expect(screen.getByRole("img", { name: "Slide 1" }).getAttribute("src")).toBe(
      "/api/submissions/s1/slides/1",
    );

    fireEvent.click(screen.getByRole("button", { name: "video: 00:31-00:40" }));
    const moment = screen.getByRole("button", { name: /Here the guard blocks a tool call/ });
    expect(moment.dataset.focused).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "repo: app/guard.py:12" }));
    expect(
      screen.getByText("client.invoke(plan)").closest("[data-focused]")?.getAttribute("data-focused"),
    ).toBe("true");
  });

  it("an override sends only the changed criteria", async () => {
    api();
    renderAt("/s/s1");
    const form = await screen.findByRole("form", { name: "review decision" });
    fireEvent.click(within(form).getByRole("radio", { name: "Override" }));
    fireEvent.change(await within(form).findByLabelText("Demo"), { target: { value: "Partial" } });
    fireEvent.change(within(form).getByLabelText(/Your name/), { target: { value: "ana" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record decision" }));
    await screen.findByText("Decision recorded: Needs review → Finalized");
    const sent = calls.find((c) => c.path === "/api/submissions/s1/decision");
    expect(sent?.body).toEqual({
      decision: "override",
      reviewer: "ana",
      notes: "",
      overrides: { demo: "Partial" },
    });
  });

  it("offers only the decisions that fit the status", async () => {
    api("gate_review");
    renderAt("/s/s1");
    const form = await screen.findByRole("form", { name: "review decision" });
    const options = within(form)
      .getAllByRole("radio")
      .map((r) => r.textContent);
    expect(options).toEqual(["Reinstate", "Disqualify"]);
  });
});

describe("dashboard", () => {
  it("starts a run and follows it to completion", async () => {
    let polls = 0;
    const job = (state: string) => ({
      id: "r1",
      hackathonId: "h",
      state,
      report: state === "done" ? { byStatus: { finalized: 3 }, errors: [], skipped: [], processed: 3 } : null,
      error: null,
      startedAt: "2026-10-01T00:00:00Z",
      finishedAt: null,
    });
    mockApi({
      "GET /api/hackathons/h": HACKATHON,
      "POST /api/hackathons/h/runs": job("running"),
      "GET /api/runs/r1": () => job(++polls > 1 ? "done" : "running"),
    });
    renderAt("/h/h");
    fireEvent.click(await screen.findByRole("button", { name: "Run everything" }));
    await waitFor(() => expect(screen.getByText("Run done")).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByText(/processed 3/)).toBeTruthy();
    expect(screen.getByText(/Add prices for gpt-5-mini/)).toBeTruthy();
  });
});
