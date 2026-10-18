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
  it("shows Sign in with Google on 401, and why an account was refused", async () => {
    mockApi({
      "GET /api/hackathons": () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      "GET /api/auth/config": { provider: "google", contact: "fuzail@armoriq.io" },
    });
    renderAt("/?signin_error=someone%40gmail.com%20is%20not%20allowed%20to%20use%20this%20app");
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(
      await screen.findByText(/someone@gmail.com is not allowed.*Ask fuzail@armoriq.io for access/),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });

  it("shows who is signed in", async () => {
    mockApi({
      "GET /api/hackathons": [HACKATHON.hackathon],
      "GET /api/session": { email: "isha@armoriq.io" },
    });
    renderAt("/");
    expect(await screen.findByText("Signed in as isha@armoriq.io")).toBeTruthy();
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

describe("form evidence and YouTube videos", () => {
  it("shows the form answers, the live demo check, and the link the model watched", async () => {
    const data = submission("needs_review");
    Object.assign(data.submission, {
      answers: { howArmoriq: "Every tool call goes through invokeWithPolicy." },
    });
    Object.assign(data.evaluation.media, {
      video: { ...data.evaluation.media.video, remoteUri: "https://www.youtube.com/watch?v=abcdefghijk" },
      liveDemo: {
        url: "https://demo.example.app/",
        reachable: false,
        status: 502,
        finalUrl: null,
        title: "",
        excerpt: "",
        error: "HTTP 502",
      },
    });
    mockApi({ "GET /api/submissions/s1": data, "GET /api/hackathons/h": HACKATHON });
    renderAt("/s/s1");
    fireEvent.click(await screen.findByRole("radio", { name: "Video" }));
    expect(screen.getByRole("link", { name: "https://www.youtube.com/watch?v=abcdefghijk" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    expect(screen.getByText("Every tool call goes through invokeWithPolicy.")).toBeTruthy();
    expect(within(screen.getByTestId("live-demo")).getByText(/Unreachable: HTTP 502/)).toBeTruthy();
  });
});

describe("status reasons", () => {
  it("says why a team is disqualified, in the list and on its page", async () => {
    const reason = "No ArmorIQ SDK install declaration and no SDK calls were found";
    const data = submission("disqualified");
    data.reasons = [reason];
    mockApi({
      "GET /api/hackathons/h": HACKATHON,
      "GET /api/hackathons/h/submissions": [
        {
          id: "s1",
          teamName: "GuardRail",
          projectName: null,
          checks: [],
          repoUrl: "https://github.com/o/guardrail",
          track: "main",
          status: "disqualified",
          reasons: [reason],
          autoScore: null,
          finalScore: null,
          confidence: null,
        },
      ],
      "GET /api/submissions/s1": data,
    });
    renderAt("/h/h/submissions");
    expect((await screen.findByTestId("reason-s1")).textContent).toBe(reason);
    fireEvent.click(screen.getByRole("link", { name: /GuardRail/ }));
    expect((await screen.findByTestId("status-reasons")).textContent).toContain(reason);
    expect(screen.getByText("Why this is disqualified:")).toBeTruthy();
  });
});

describe("scoring one team at a time", () => {
  it("shows the rubric score, each deduction, and the result", async () => {
    const data = submission("needs_review");
    Object.assign(data.evaluation.calibration as object, {
      rubricScore: 73.6,
      penalties: [
        { id: "social_post", label: "No X or LinkedIn post", points: 5, detail: "no link in the form" },
      ],
    });
    mockApi({ "GET /api/submissions/s1": data, "GET /api/hackathons/h": HACKATHON });
    renderAt("/s/s1");
    const breakdown = await screen.findByTestId("score-breakdown");
    expect(breakdown.textContent).toContain("Rubric score73.6");
    expect(breakdown.textContent).toContain("No X or LinkedIn post (no link in the form)−5");
  });

  it("offers Score this team on a team that is waiting", async () => {
    const data = submission("scoring");
    Object.assign(data.evaluation, { scorecard: null });
    mockApi({
      "GET /api/submissions/s1": data,
      "GET /api/hackathons/h": HACKATHON,
      "POST /api/hackathons/h/runs": {
        id: "r1",
        hackathonId: "h",
        state: "running",
        report: null,
        error: null,
        startedAt: "2026-10-01T00:00:00Z",
        finishedAt: null,
      },
    });
    renderAt("/s/s1");
    fireEvent.click(await screen.findByRole("button", { name: "Score this team" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/hackathons/h/runs")).toBe(true));
    expect(calls.find((c) => c.path === "/api/hackathons/h/runs")?.body).toEqual({
      phase: "score",
      only: ["s1"],
      retry: true,
    });
  });
});

describe("scores with gaps", () => {
  it("shows what could not be reviewed and marks unjudged criteria", async () => {
    const data = submission("needs_review");
    data.reasons = ["⚠ Video not watched: the Gemini quota is used up."];
    const scores = (data.evaluation.scorecard as { scores: Record<string, unknown>[] }).scores;
    scores[0] = { ...scores[0], notAssessed: true };
    mockApi({ "GET /api/submissions/s1": data, "GET /api/hackathons/h": HACKATHON });
    renderAt("/s/s1");
    expect((await screen.findByTestId("status-reasons")).textContent).toContain("Video not watched");
    expect(await screen.findAllByText(/not judged/i)).not.toHaveLength(0);
  });
});

describe("form sync", () => {
  it("shows the last sync and lists entries that could not be imported", async () => {
    mockApi({
      "GET /api/hackathons/h": HACKATHON,
      "GET /api/hackathons/h/submissions": [],
      "GET /api/hackathons/h/sync": {
        configured: true,
        intervalMin: 5,
        autoScore: false,
        last: {
          hackathonId: "h",
          at: new Date().toISOString(),
          ok: true,
          created: 43,
          updated: 4,
          unchanged: 9,
          skipped: ["row 164 (Ghost): repo_url must be a repository URL"],
          error: null,
          runId: "r1",
        },
      },
    });
    renderAt("/h/h");
    expect((await screen.findByTestId("sync-status")).textContent).toContain(
      "43 new · 4 updated · 9 unchanged",
    );
    expect(screen.getByText("row 164 (Ghost): repo_url must be a repository URL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
  });
});

describe("leaderboard", () => {
  it("ranks each track in its own panel", async () => {
    const row = (track: string | null, rank: number, teamName: string, finalScore: number) => ({
      rank,
      track,
      submissionId: teamName.toLowerCase(),
      teamName,
      finalScore,
      autoScore: finalScore,
      overridden: false,
    });
    mockApi({
      "GET /api/hackathons/h": HACKATHON,
      "GET /api/hackathons/h/leaderboard": [
        row("elevenlabs", 1, "Semicolon", 81),
        row("main", 1, "RepoSentry", 90),
        row("main", 2, "Dune", 70),
      ],
    });
    renderAt("/h/h/leaderboard");
    expect(await screen.findByText("Track: elevenlabs")).toBeTruthy();
    expect(screen.getByText("Track: main")).toBeTruthy();
    expect(screen.getByText("Semicolon")).toBeTruthy();
    expect(screen.getByText("81.00")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Score next team" }));
    await waitFor(() => expect(screen.getByText("Run done")).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByText(/processed 3/)).toBeTruthy();
    expect(screen.getByText(/Add prices for gpt-5-mini/)).toBeTruthy();
  });
});
