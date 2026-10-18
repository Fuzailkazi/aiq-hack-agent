# hackathon-project-evaluator (`hackeval`)

Automated judging for the ArmorIQ hackathon, in TypeScript (Node 22, Fastify, React, Google ADK, Jev).

The pipeline:
1. Disqualifies teams that do not both **install** and **call** the ArmorIQ SDK. This is decided by static scanning; submission code is never run.
2. Scores the submission against your rubric with LLM agents (Gemini or OpenAI): the pitch deck, the demo video, the depth of the ArmorIQ integration in the repo, and the team's form answers plus a check that their live demo loads.
3. Gets an independent Jev second opinion per criterion. A result reaches the leaderboard only when confidence is ≥ 0.85 and no rule fires; everything else goes to a human with the reasons. With `HACKEVAL_SECOND_OPINION=none` there is no Jev: the LLM scores and a human reviews every result.

The leaderboard ranks each track on its own (e.g. a separate ElevenLabs prize).

- **Runbook and code walkthrough:** [`docs/runbook.md`](docs/runbook.md)
- **Design:** [`docs/design.md`](docs/design.md)

```bash
cp .env.example .env             # keys + Google sign-in (see docs/runbook.md)
npm ci && npm ci --prefix web && npm run web:build
npm run hackeval -- init demo --deadline 2026-10-20T23:59:00Z
export HACKEVAL_HACKATHON=demo
npm run hackeval -- rubric activate config/rubrics/example_rubric.yaml
npm run hackeval -- import submissions.csv
npm run hackeval -- run                      # gate, then score
npm run hackeval -- review list
npm run hackeval -- leaderboard --format csv
npm run hackeval -- serve                    # UI + API on http://127.0.0.1:8000
```

Or use Docker: `docker compose up -d`.

## Flow State Hackathon

Submissions come from the Google Form; download the Responses sheet as CSV.

```bash
export HACKEVAL_INTAKE=intake.flow_state.yaml HACKEVAL_SECOND_OPINION=none HACKEVAL_HACKATHON=flowstate
npm run hackeval -- init flowstate --deadline 2026-10-20T18:29:00Z   # 23:59 IST
npm run hackeval -- rubric activate config/rubrics/flow_state.yaml
npm run hackeval -- import responses.csv
npm run hackeval -- run
```

- **Gate:** no `@armoriq/sdk` / `armoriq-sdk` install plus a real call means disqualified; nothing else runs.
- **Rubric** (`config/rubrics/flow_state.yaml`): demo video 40, live demo 40, ArmorIQ integration depth 20, takeaways 15, ArmorTools Pro 5 (normalized to 0-100).
- **Intake** (`config/intake.flow_state.yaml`): form timestamps are read as Asia/Kolkata; "Did you use ElevenLabs? Yes" puts a team on the `elevenlabs` track, everyone else on `main`. Names and emails are never imported.
- **Videos:** with Gemini, YouTube links go to the model as-is (it watches them), so no download is needed. Private videos fail and go to review.
- **Live demo:** one page load per URL (private addresses refused, cold starts retried). It shows the app is online, not that it works; the video carries that.
- **Requirements checklist** (per team, in the UI): ArmorIQ SDK gate, ElevenLabs actually in the code (ElevenLabs track; found by manifest or import, so "used it only for the video narration" shows as a warning), demo video watchable, live demo online, X/LinkedIn post with #FlowStateHackathon, ArmorTools Pro.
- **The agents know the form's rules:** the video analyst flags videos far outside 3 to 5 minutes; the form analyst compares partner claims with the repo scan.
- **Free-tier Gemini:** set `HACKEVAL_LLM_CONCURRENCY=1` (video calls are large); rate limits (429), overload (503) and dropped connections are retried with backoff, and a failed run says so in plain words ("Not scored yet: the Gemini rate limit was reached").
- **Form sync:** link the responses sheet once (`HACKEVAL_SHEET_ID` + a service account it is shared with) and `serve` pulls new entries every 5 minutes, imports them and runs the SDK gate; `hackeval sync` does it on demand.
- **Loom/Vimeo videos** need `yt-dlp` (`brew install yt-dlp`); YouTube does not.

**Commands:**
- Setup: `init`, `rubric validate|activate`, `import`, `add`.
- Running: `run [--phase gate|score] [--retry]`, `status`.
- Reviewing: `review list|show|resolve`, `attach`.
- Routing and results: `reroute`, `calibrate <gold.csv>`, `leaderboard`.
- Other: `models`, `serve`.

**System tools:** `git`, `ffmpeg`/`ffprobe`, LibreOffice (`soffice`), poppler (`pdftoppm`); optional `yt-dlp` for Loom/Vimeo links (and YouTube with OpenAI).

**Development:**
- `npm test`: offline suite.
- `npm run web:test`: UI.
- `npm run test:live`: needs API keys.
- `npm run check`: Biome + tsc.
- `npm run api:spec`: regenerate the UI's API types after changing routes.
