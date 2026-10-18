# hackeval runbook

How to run judging for an ArmorIQ hackathon, and how the code works.

- **Part 1** is for organizers: keys, a full judging round, reviews, rubric changes, tuning, and troubleshooting.
- **Part 2** is a code walkthrough, written so you can explain every piece.

---

## Part 1 — Operating it

### What it does

Each submission is three links or files: a **GitHub repo**, a **pitch deck** (PPTX or PDF) and a **video**. Judging runs in two phases.

```
GATE (every submission)        clone repo (https, no code executed) → scan for ArmorIQ usage
                                 PASS   → scoring
                                 FAIL   → disqualified, with feedback explaining what was searched for
                                 UNSURE → Jev decides PASS, or sends it to a human (Jev never disqualifies)
SCORING (gate passed)          deck + video digest → Jev prescreen flags
                                 → deck / video / integration analysts (LLM) → synthesis scorecard
                                 → Jev second opinion per criterion over the raw evidence
                                 → accept (confidence ≥ 0.85 and no rule fired) → leaderboard
                                 → otherwise → human review queue, with the reasons
```

**Disqualification rule.** A team is disqualified only when the scanner *positively* finds that the ArmorIQ SDK is not both installed **and** called in application code. Calls that appear only in tests, type-only imports, comments and READMEs do not count as usage. Env files are optional evidence.

Anything the scanner cannot follow goes to Jev or a human, never to an automatic disqualification. Examples: dynamic imports, notebooks, submodules, or usage without an install.

### Setup

1. **Keys.** Copy `.env.example` to `.env` and fill in:
   - `TYPESAFE_API_KEY` (Jev). **No Jev key?** Set `HACKEVAL_SECOND_OPINION=none`. The LLM still scores every submission, but nothing is auto-accepted: every result goes to the review queue with its score, and a judge approves or overrides it. Unresolved gate cases also go to a judge instead of Jev;
   - `GOOGLE_API_KEY` and/or `OPENAI_API_KEY`;
   - **Sign in with Google** (there is no shared password or token). In Google Cloud Console, open *APIs & Services > Credentials*, create an **OAuth client ID** of type *Web application*, and add the redirect URI `<HACKEVAL_PUBLIC_URL>/api/auth/google/callback` (locally `http://127.0.0.1:8000/api/auth/google/callback`). Put its id and secret in `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Set `HACKEVAL_SESSION_SECRET` to a long random string (`openssl rand -hex 32`) so sign-ins survive restarts;
   - **Laptop only, before the OAuth client exists:** `HACKEVAL_LOCAL_ONLY=true` skips sign-in. The server then refuses to start unless it binds to 127.0.0.1/localhost and `HACKEVAL_PUBLIC_URL` is localhost, so it cannot be exposed by mistake; anyone using that machine can open it;
   - `HACKEVAL_ALLOWED_EMAILS`: who may sign in (default `fuzail@armoriq.io,isha@armoriq.io`). Google must report the address as verified, and anyone else is turned away;
   - optionally `GITHUB_TOKEN` to clone private repos.
   - **Automatic form sync (optional, recommended):** new Google Form entries are pulled in every few minutes, imported, and run through the SDK gate. One-time setup:
     1. In Google Cloud Console, enable the **Google Drive API** and create a **service account** (IAM & Admin > Service accounts); add a JSON key and save it outside the repo, e.g. `~/.config/hackeval/service-account.json`.
     2. Open the form's responses sheet, click **Share**, and add the service account's email (`…@….iam.gserviceaccount.com`) as a **Viewer**. The sheet stays private.
     3. Set `HACKEVAL_SHEET_ID` (the id in the sheet's URL), `GOOGLE_SERVICE_ACCOUNT_FILE` (the key's path) and `HACKEVAL_HACKATHON`. Optional: `HACKEVAL_SYNC_INTERVAL_MIN` (default 5) and `HACKEVAL_AUTO_SCORE=true` to also score new teams (spends model quota).
     `serve` then syncs on that interval (the dashboard shows the last sync and entries it could not import, with a Sync now button); `hackeval sync` does one sync from the command line.
2. **Choose the LLM provider.** Set `HACKEVAL_LLM_PROVIDER=gemini` or `openai`. Model ids per role live in `config/models.yaml`. Run `hackeval models` to print the active set.
3. **Run it** in one of two ways:
   - **Docker:** `docker compose up -d`, then open http://127.0.0.1:8000.
   - **Local:** Node 22 plus `git`, `ffmpeg`, LibreOffice (`soffice`) and poppler (`pdftoppm`), with optional `yt-dlp` for YouTube/Loom links. Run `npm ci && npm ci --prefix web && npm run web:build`, then `npm run hackeval -- serve`.

Every CLI command below can be run as `npm run hackeval -- <command>`, or as `docker compose run --rm hackeval <command>` in Docker. Set `HACKEVAL_HACKATHON=<id>` once instead of passing `-H <id>` each time.

### A judging round

| Step | CLI | UI |
|---|---|---|
| 1. Create the hackathon (the deadline needs a timezone) | `init demo --deadline 2026-10-20T23:59:00-07:00` | Hackathons → New |
| 2. Activate the rubric | `rubric validate my_rubric.yaml`, then `rubric activate my_rubric.yaml` | Dashboard → Rubric |
| 3. Import submissions | `import submissions.csv` (columns: `config/intake.yaml`) or `add --team … --repo … --deck … --video …` | Import |
| 4. Gate everyone | `run --phase gate` | Dashboard → Gate only |
| 5. Work the gate queue | `review list`, then `review resolve <id> --decision reinstate\|disqualify --reviewer you` | Review |
| 6. Score | `run --phase score` | Dashboard → Score only |
| 7. Work the score queue | `review show <id>`, then `review resolve <id> --decision accept\|override\|disqualify --reviewer you [--override criterion=Label]` | Review → submission page |
| 8. Fix unreachable media | `attach <id> --deck deck.pdf` / `--video demo.mp4` | Submission page → Attach files |
| 9. Results | `leaderboard --format csv > results.csv` | Leaderboard → Download CSV |

`run` with no `--phase` does both phases. Re-running is always safe:
- finished submissions are skipped;
- `--retry` requeues the ones that errored;
- unchanged inputs are answered from the cache with zero model calls.

**What the reviewer sees.** On a submission page each criterion shows the LLM's level (the score of record) next to Jev's probability bars, plus the agreement, the evidence sufficiency and the reasons the item needs a human. Clicking a citation jumps to the slide, to the moment in the video, or to the code line.

### Changing things mid-event

- **The rubric.** Edit the file, bump `version`, then activate it. Results scored under the old version become `stale`, and `run --phase score` re-scores them.
  - Downloads and transcripts come from the cache. The LLM calls are repeated, because the rubric changed.
  - A human override made under the old version is not carried over. The re-score goes back to the review queue, saying which overridden criteria changed.
- **Routing thresholds** (`config/policy.yaml`). After editing, run `reroute`. It recomputes every machine route from the stored LLM and Jev outputs with **zero model calls**, and never touches items a human decided.
- **The provider.** Change `HACKEVAL_LLM_PROVIDER`. Model ids are part of the cache key, so the next score run uses the new provider.

### Tuning against human judges (gold set)

1. Have judges score 20–30 submissions by hand. Fill in `evals/gold/gold.example.csv`: one row per submission (`submission_id` is our id or your external id) and one column per criterion, holding the level label.
2. Run `calibrate evals/gold/gold.csv`. Add `--full` for every sweep row, or `--max-review-rate 0.3 --target-agreement 0.9` to set the targets.
3. The report shows, for the current policy:
   - agreement within ±1 level, on auto-accepted results and on all results;
   - exact agreement;
   - the mean score difference;
   - the review rate.

   It also sweeps `level_tolerance`, `min_sufficiency` and `min_criterion_agreement` with the **0.85 confidence bar fixed**. The recommended policy is the lowest review rate that still meets the agreement target.
4. Copy the recommended values into `config/policy.yaml`, then run `reroute`.

### Cost

`status` (and the dashboard) shows LLM calls, tokens per model, and Jev calls. To see dollar figures, fill in `prices` and `jev_price_per_call` in `config/models.yaml`. No prices are shipped, on purpose: use your contract's prices.

Concurrency is capped by:
- `HACKEVAL_CONCURRENCY` (submissions in parallel);
- `HACKEVAL_LLM_CONCURRENCY` (LLM calls in flight);
- `HACKEVAL_CPU_CONCURRENCY` (ffmpeg and LibreOffice jobs).

### Security notes

- Submission code is never executed.
  - Repos are cloned over https with a protocol allowlist, no submodules, no LFS smudge, and size and time caps.
  - The scanner parses code with tree-sitter. It never imports or runs it.
- Real ArmorIQ keys (`ak_live_` / `ak_test_` / `ak_claw_`) found in repos are stored only in redacted form. They are never sent to an LLM or to Jev.
- Deck and video content goes to the LLMs fenced as untrusted data. Jev flags text aimed at an AI judge, and that sends the result to a human.
- The UI and API always require a Google sign-in from an allowlisted, verified email (`HACKEVAL_ALLOWED_EMAILS`). Sign-in uses the OAuth code flow with PKCE and a state check; the session is a signed HttpOnly cookie that lasts 12 hours. Compose binds to 127.0.0.1; to let others in, host it behind TLS, set `HACKEVAL_PUBLIC_URL` to the https address, and register that callback URL with the OAuth client (cookies then become Secure).
- The API serves media only by submission id and index, from files the server itself wrote inside the workspace. It never accepts server-side paths from clients.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `needs_attention`: "link returned a login page" / "Canva link" | The link is private or not a direct file. Ask for a PDF/MP4, or attach it yourself. |
| `needs_attention`: "repository not found or private" | Wrong URL: re-import the corrected row (same `external_id`); the new revision replaces the old. Private repo: set `GITHUB_TOKEN`, then `review resolve <id> --decision requeue`. |
| `error` items | `review show <id>` shows the message. Fix the cause (keys, quota), then `run --retry`. |
| A Jev outage during scoring | The affected submissions go to `error` rather than review. `run --retry` once Jev is back. |
| Slides have no images | LibreOffice or poppler is missing. Slide text is still used, and `renderError` says why. |
| "yt-dlp is not installed" | Install it, or attach the video file. |

---

## Part 2 — Code walkthrough

Read the files in this order. Each module is a small, pure-ish function with its own tests in `tests/`.

### 1. Contracts: `src/schemas/`

Every piece of data is a Zod schema. The schema gives the TypeScript type (`z.infer`) and validates at runtime. Read them first: everything else is functions between these shapes.

| File | What it defines |
|---|---|
| `rubric.ts` | `Rubric` → `Criterion` → ordered `levels` (2–10, unique labels). `weightedScore` maps levels to 0–100. |
| `submission.ts` | `Submission` (repo URL plus deck/video `ArtifactRef`s). The natural key dedupes re-submissions. |
| `evidence.ts` | What the scanner and digests produce: `ArmorIQEvidence` (installs, usage sites, unresolved items) and `MediaDigest` (slides, transcript, keyframes). |
| `findings.ts` | LLM outputs: per-artifact `ArtifactFindings` and the final `Scorecard` (a level label per criterion, with citations). |
| `calibration.ts` | Jev's second opinion per criterion and the routing result. |
| `evaluation.ts` | The record stored per submission: gate, prescreen, findings, scorecard, calibration, reviews and usage. It also defines the `Status` state machine. |

### 2. Storage and intake: `src/store/`, `src/intake.ts`

- **`store/db.ts`**: SQLite in WAL mode. Each row holds a JSON body plus a few indexed columns.
- **`store/queries.ts`**: all the SQL.
  - `saveEvaluation(db, ev, expectedStatus)` is **compare-and-set**: it writes only if the status is still what the caller read. That is how a judge's decision and a running batch never overwrite each other.
  - `activateRubric` marks other-version results `stale`.
- **`intake.ts`**: CSV import.
  - It canonicalizes repo URLs (github/gitlab/bitbucket only) and requires timezone offsets.
  - Local paths are confined to the CSV's own folder.
  - Rows submitted after the deadline are listed, not imported.

### 3. The gate: is ArmorIQ really used?

1. **`acquire/repo.ts`** clones without executing anything.
   - `--filter=blob:none --no-recurse-submodules`, an https-only protocol allowlist, `GIT_LFS_SKIP_SMUDGE`, and size and time caps.
   - With a deadline, it checks out the last commit before it and counts later commits, which become a review flag rather than a disqualification.
2. **`digest/armoriq/`** is the scanner.
   - `files.ts` walks the tree, skipping symlinks, virtualenvs and `node_modules`.
   - `installs.ts` reads every manifest form: requirements, pyproject, Pipfile, package.json, lockfiles, Dockerfiles, shell scripts and notebooks.
   - `pythonUsage.ts` and `jsUsage.ts` parse code with **tree-sitter** and trace bindings: imports → aliases → instances → calls (including chained calls and subclasses). A comment or a string can therefore never count as usage.
     - What they cannot trace (dynamic imports, re-exports) is reported as `unresolved`.
   - `secrets.ts` finds real ArmorIQ keys and redacts them.
3. **`stages/gate.ts`** `classify()` turns evidence into PASS / FAIL / UNRESOLVED.
   - FAIL requires *positive absence*: nothing unresolved and no untraced import.
   - `decideGate()` asks Jev (`jev/gateQuestions.ts`) only about UNRESOLVED cases. A pass needs P(yes) ≥ 0.8; otherwise the case goes to a human. **Jev can pass a team but never disqualify one.**
   - `stages/feedback.ts` writes the disqualification explanation.

### 4. Media digests: `src/acquire/media.ts`, `src/digest/`

- **`acquire/media.ts`** downloads with size caps.
  - It sniffs the bytes, so an HTML login page is never mistaken for a deck.
  - It rewrites Google Drive/Slides share links, and uses `yt-dlp` for video hosts.
- **`digest/deck.ts`** extracts the text of *every* slide, plus notes and tables (PPTX XML, or `unpdf`). It renders an evenly spaced sample of slide images (LibreOffice → PDF → `pdftoppm`).
- **`digest/video.ts`** and **`digest/transcribe.ts`** run ffprobe, sample keyframes across the whole video, split mono 16 kHz audio chunks, and produce a timestamped transcript (OpenAI or Gemini).
- **`digest/media.ts`** orchestrates these steps and caches results by file content hash, so re-scoring never re-downloads or re-transcribes.

### 5. Jev: cheap typed decisions (`src/jev/`)

- **`client.ts`** wraps the TypeSafe SDK.
  - The model is pinned to `jev-1.13.0`, never `jev-latest`.
  - Every answer is normalized to `JevDecision` (`value`, `probabilities`, `confidence`).
- Question sets:
  - `gateQuestions.ts`: unresolved gate cases.
  - `prescreenQuestions.ts`: flags such as "is the deck a real pitch?", "does the video show this project?", "are deck and video the same project?", "is someone talking to the AI judge?".
  - `calibrationQuestions.ts`: one call per criterion, made of a `score` question over the rubric levels plus a `sufficient` question.
- **Key point to explain:** the calibration state holds the **raw** deck text, transcript and scanner summary, never the LLM's levels or rationale. Jev is therefore an independent second opinion, not a rubber stamp.

### 6. LLM agents: `src/agents/` (Google ADK)

- **`models.ts`** builds the model per role.
  - Gemini models are plain ADK model strings.
  - OpenAI models use `openaiLlm.ts`, our `BaseLlm` adapter for Chat Completions, with strict JSON schema output and images.
- **`outputSchemas.ts`** builds a Zod output schema *from the rubric*. Each criterion's level must be one of its labels (an enum), so the model cannot invent a level. Code then maps labels to indices.
- **`prompts.ts`** and **`messages.ts`** hold versioned prompts. Submission content is wrapped in a fence and treated as untrusted data.
- **`analysts.ts`** and **`run.ts`** define one `LlmAgent` per artifact (deck, video, repo integration) plus a synthesis judge, each run once with structured output. An absent artifact produces "absent" findings with no LLM call.

### 7. Calibration and routing: `src/stages/calibrate.ts`, `src/stages/route.ts`

- **`calibrate()`** asks Jev per criterion, adds the `claims_unsupported` flag, then calls `decideRoute()`.
- **`route.ts`** is pure math over stored numbers:
  - **agreement** = the Jev probability mass within ±`level_tolerance` of the LLM's level;
  - **confidence** = the weighted mean agreement.
- A result is **accepted** only if all of these hold:
  - confidence ≥ 0.85;
  - every criterion's agreement ≥ `min_criterion_agreement`;
  - every criterion's sufficiency ≥ `min_sufficiency`;
  - the |Jev expected level − LLM level| gap ≤ `max_level_gap`;
  - no flag rule fires (injection attempt, unsupported claims, mismatched artifacts, commits after the deadline).
- Every rule that fires becomes a human-readable reason.
- Because routing only reads stored numbers, `reroute.ts` and `calibrateGold.ts` can replay it under any policy for free.

### 8. Orchestration: `src/pipeline/`

- **`deps.ts`**, `PipelineDeps`, is the seam. Every stage is a function on this interface.
  - `production.ts` wires the real ones: Jev wrapped in cache plus usage meter, and LLM calls behind a concurrency limiter.
  - Tests inject fakes (`tests/fakes.ts`).
- **`gateWorkflow.ts`** and **`scoringWorkflow.ts`** are ADK `Workflow` graphs. Nodes are thin wrappers that call a stage and write to session state, and routes branch on outcomes. The three analysts run in parallel and meet at a `JoinNode`.
- **`batch.ts`** `BatchRunner` runs phases over the database with bounded concurrency.
  - One crashing submission becomes `error` without stopping the batch.
  - It accumulates usage per submission. `AsyncLocalStorage` in `util/context.ts` attributes Jev calls to the right submission.
- **`stageCache.ts`** is a content-addressed cache. Keys hash every input the model sees plus the versions that shape its answer: rubric, prompt version, model ids and Jev model.

### 9. Humans, results, front ends

- **`review.ts`** holds the review state machine: reinstate, disqualify, accept, override, requeue and attach. It also implements the rubric-version re-check for old overrides.
- **`service.ts`** holds the operations shared by the CLI and the API.
- **`leaderboard.ts`** uses competition ranking; a judge's override beats the auto score. The CSV export is formula-injection safe.
- **`cli.ts`** is commander. `runCli()` returns `{code, out, err}`, so tests run the real CLI in-process.
- **`api/`** is Fastify.
  - `auth.ts` accepts a bearer token or an HttpOnly cookie, compared in constant time.
  - `jobs.ts` runs pipelines in the background, one per hackathon.
  - `routes/` are typed with Zod; the same schemas generate `/api/openapi.json`.
  - `media.ts` streams files with Range support and checks real paths stay inside the workspace.
- **`web/`** is React with TanStack Query, using a typed client generated from that OpenAPI document (`npm run api:spec`).
  - It is styled with the **ArmorIQ design system**, vendored in `web/design-system/`: Tailwind v4 over the `aq-*` tokens (light and dark), the `@shared/ui` primitives (`Button`, `StatusBadge`, `ListRow`, `ListToolbar`, `FormField`, `SegmentedControl`, `TabRail`, `PageState`, …) and the self-hosted Geist fonts. Screens compose primitives; no hex values, arbitrary sizes or inline colours. `web/design-system/VENDORED.md` says what was copied.
  - `src/shell/` is the frame (rail, breadcrumb top bar, theme switch, sign-in split layout); `src/features/<area>/` holds the screens; `src/shared/` holds the app-level pieces reused across screens (`Panel`, `PageHeader`, `StatCell`, the status → tone mapping, the control classes).
  - `SubmissionDetail` → `ScorecardTable` (LLM vs Jev) + `EvidenceViewer` (slides, video seek, code) + `ReviewForm`.

### Tests

- `npm test` runs about 330 offline tests: fake Jev, scripted LLMs, fake fetch, real git repos built on the fly, and real ffmpeg and LibreOffice where installed.
- `npm run web:test` runs the UI tests in jsdom.
- `npm run test:live` runs the real Gemini, OpenAI and Jev checks, and skips any provider whose key is missing.
- `tests/integration/gateFixtures.test.ts` and its false-disqualification patterns are the best single place to see the gate's rules in action.
