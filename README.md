# hackathon-project-evaluator (`hackeval`)

Automated judging for the ArmorIQ hackathon, in TypeScript (Node 22, Fastify, React, Google ADK, Jev).

The pipeline:
1. Disqualifies teams that do not both **install** and **call** the ArmorIQ SDK. This is decided by static scanning; submission code is never run.
2. Scores the pitch deck and the demo video against your rubric with LLM agents (Gemini or OpenAI).
3. Gets an independent Jev second opinion per criterion. A result reaches the leaderboard only when confidence is ≥ 0.85 and no rule fires; everything else goes to a human with the reasons.

- **Runbook and code walkthrough:** [`docs/runbook.md`](docs/runbook.md)
- **Design:** [`docs/design.md`](docs/design.md)

```bash
cp .env.example .env             # keys + HACKEVAL_ADMIN_TOKEN
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

**Commands:**
- Setup: `init`, `rubric validate|activate`, `import`, `add`.
- Running: `run [--phase gate|score] [--retry]`, `status`.
- Reviewing: `review list|show|resolve`, `attach`.
- Routing and results: `reroute`, `calibrate <gold.csv>`, `leaderboard`.
- Other: `models`, `serve`.

**System tools:** `git`, `ffmpeg`/`ffprobe`, LibreOffice (`soffice`), poppler (`pdftoppm`); optional `yt-dlp` for YouTube/Loom links.

**Development:**
- `npm test`: offline suite.
- `npm run web:test`: UI.
- `npm run test:live`: needs API keys.
- `npm run check`: Biome + tsc.
- `npm run api:spec`: regenerate the UI's API types after changing routes.
