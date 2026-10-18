# hackathon-project-evaluator — Design & Implementation Plan

## Context

ArmorIQ is running a hackathon and expects hundreds of submissions. Judging them by hand means fatigue, delay and inconsistent scores. Each submission has three parts: a **GitHub repo**, a **pitch deck** (PPTX/PDF) and a **video explainer**. We are building an automated judging pipeline that:

1. **Disqualifies** teams that don't really use ArmorIQ. The ArmorIQ SDK must be **installed** (in `package.json` or a Python manifest) **and** its functions must be **called in code**. Env files are optional evidence only.
2. **Evaluates the deck and video in depth** against an organizer rubric. The rubric file comes later; this plan defines its schema and ships an example.
3. **Calibrates and routes** each result. If confidence is above 0.85 the result goes to the leaderboard; otherwise it goes to human judges with notes explaining the disagreement.

We never execute submission code. Repo analysis is limited to ArmorIQ integration evidence.

**Two engines, two jobs:**
- **Jev (TypeSafe `typesafe-sdk` 0.7)** makes cheap typed decisions in about 70–500 ms. It has three answer types: `Noul` (P(yes)), `Choice` (an option plus probabilities) and `Score` (a fractional position on 2–10 ordered levels). Its `state` input is token-limited.
  - Its roles here: settle gate cases the scanner can't resolve, raise pre-screen flags, and give an independent per-criterion second opinion from the **raw** deck and video text.
- **Google ADK 2.x (`google-adk>=2.10`)** runs the gate and scoring flows as `Workflow` graphs and hosts the multimodal LLM analyst agents.

**Decisions locked with user:**
- Never execute submission code.
- The rubric is config-driven; the organizer file comes later.
- ADK agents can switch between **Gemini and OpenAI**.
- Intake accepts a **CSV of links and direct uploads**.
- Interfaces: **CLI + web UI**.
- **FastAPI** backend, reusing the Python pipeline and Pydantic schemas.
- **React (Vite + TypeScript)** frontend, served by FastAPI.

---

## Stack decision (2026-10-01, supersedes Python/FastAPI below)

At the user's request, the whole system is implemented in **TypeScript (Node 22) with Fastify**, so the team can read and explain every line. Everything else in this design stands unchanged: the architecture, the schemas (now Zod), routing math, security rules and milestones.

Python → TypeScript equivalents:

| Python | TypeScript |
|---|---|
| Pydantic | Zod |
| SQLAlchemy | better-sqlite3 |
| Typer | commander |
| FastAPI | Fastify (+ zod type provider, swagger) |
| `ast` | tree-sitter Python grammar (`web-tree-sitter`) |
| python-pptx / pypdfium2 | jszip XML + soffice + unpdf + pdftoppm |
| ADK Python | `@google/adk` (JS) |
| ADK `OpenAILlm` | own `OpenAILlm` adapter over the `openai` SDK |
| `typesafe-sdk` | `@typesafe-ai/sdk` |

The Python implementation was retired on 2026-10-16, after a parity check found all of its behavior in this repo: configs byte for byte, gate rule, DQ feedback, scanners, clone safety, redaction, intake, routing math with every route test case, prompts and fixtures. Its branches are archived offline.

---

## 1. Architecture

There are two ADK `Workflow`s per submission. Human decisions live in the database between them; there are no paused sessions.

```
GATE WORKFLOW (cheap; run across ALL submissions first)
[acquire_repo]  partial clone; record committer-date info (no code execution)
  │   repo 404/private → needs_attention (organizer fixes the link; never DQ)
[armoriq_gate]  scanner → rule (§3.5) → PASS | FAIL | UNRESOLVED
  │   UNRESOLVED → Jev Noul over snippets → PASS (≥0.8) | human gate review   (Jev never disqualifies)
  ├─ FAIL     → [disqualify]  DQ feedback markdown: what we searched for, what we found
  ├─ UNRESOLVED/low-Jev → gate_review queue
  └─ PASS     → enqueue SCORING WORKFLOW        (a human "reinstate" also just enqueues it)

SCORING WORKFLOW
[acquire_media] → [digest_media]   deck: text of ALL slides, images of an evenly sampled ≤40
  │                                video: full transcript (timestamped); keyframes sampled over the whole video
  │   unreachable artifact (login page, Canva/Pitch link, yt-dlp blocked) → needs_attention + "attach file & resume"
[jev_prescreen]  one Jev call → flags only (never DQ)
  ├──► [deck_analyst]  ──┐   every branch always runs; a missing artifact gives "absent" findings,
  ├──► [video_analyst] ──┼─► [join] ─► [synthesis] ─► [jev_calibrate] ─► [route]
  └──► [integration_analyst]   only if the rubric has a repo-sourced criterion
                                                      ├─ accept → finalized → leaderboard
                                                      └─ review → needs_review + discrepancy notes
```

**Orchestration rules**
- Every node is a thin wrapper around a pure, separately testable service function, such as `scan_armoriq(path) -> ArmorIQEvidence`. The graphs only do wiring.
- Each node checkpoints its output to SQLite under `hash(artifact sha256 + rubric version + prompt version + model ids)`. Reruns and resumes skip finished work.
- **Routing is separate from scoring**: changing thresholds re-routes from stored outputs without new LLM or Jev calls.
- Spike M0(b) is **go/no-go** for ADK `Workflow`. Because of the pure-function design, falling back to plain asyncio plus ADK `LlmAgent`s is cheap.

**Provider parity (Gemini ↔ OpenAI)**
- Both providers receive the same provider-neutral evidence: slide images plus text, and keyframes plus a timestamped transcript. Nothing depends on Gemini's native video input.
- `config/models.yaml` sets the model per role. `gemini-*` model strings resolve natively in ADK. OpenAI goes through `google.adk.labs.openai.OpenAILlm`, falling back to `LiteLlm("openai/…")`.
- Spike M0(c) must show that both providers return **image parts and `output_schema` structured output**.
- Images are injected by a `before_model_callback` from file paths kept in session state. Binary data never goes into state.
- Analyst agents run with `mode="single_turn"`.
- Transcription uses one `Transcriber` protocol with a Gemini and an OpenAI implementation. Audio is mono 16 kHz, chunked under OpenAI's 25 MB upload limit.
- One switch selects the provider: `HACKEVAL_LLM_PROVIDER=gemini|openai`.

**Throughput & cost**
- Batches run in phases: gate everything, then score the submissions that passed.
- Each provider has its own async limiter (RPM/TPM, configurable) with backoff on 429.
- ffmpeg and LibreOffice run in a separate CPU-bound pool.
- Token and cost usage is recorded per LLM/Jev call, and `hackeval status` reports cost per submission.

**Security**
- Never run submission code.
- Clone with `--filter=blob:none --no-recurse-submodules` and `GIT_LFS_SKIP_SMUDGE=1`, under size and time caps.
- Downloads sniff the content type (an HTML login page is not a deck) and are capped.
- LibreOffice runs under a timeout with a throwaway profile, inside the container.
- Committed ArmorIQ keys are stored only redacted (`ak_****abcd`) and never sent to LLMs, Jev or logs.
- Submission content is fenced as untrusted data in prompts. A Jev Noul flags text aimed at an AI evaluator and escalates it.
- The UI requires auth.

---

## 2. Directory layout

> **Historical.** This is the original Python layout, kept for the design record. The Python repo was retired on 2026-10-16 (see the stack decision above). The live code is this TypeScript repo, laid out under `src/`, `tests/`, `web/`, `config/` and `scripts/`.

```
hackathon-project-evaluator/        # Python (retired; archived as a git bundle)
├── pyproject.toml / uv.lock        # google-adk>=2.10,<3 · typesafe-sdk>=0.7,<0.8 · openai · litellm · pydantic v2
│                                   # pydantic-settings · sqlalchemy 2 · typer · fastapi · uvicorn · python-multipart
│                                   # httpx · python-pptx · pypdfium2 · yt-dlp · tree-sitter-language-pack · pyyaml
├── .env.example                    # GOOGLE_API_KEY, OPENAI_API_KEY, TYPESAFE_API_KEY, GITHUB_TOKEN,
│                                   # HACKEVAL_LLM_PROVIDER, HACKEVAL_ALLOWED_EMAILS
├── Dockerfile · docker-compose.yml # python + git + ffmpeg + libreoffice; builds web/ and serves it from FastAPI
├── README.md · docs/design.md · docs/spikes.md
├── config/
│   ├── settings.example.yaml       # workspace, limiters, caps (slide images ≤40, keyframes ≤24, clone ≤200 MB)
│   ├── models.yaml                 # provider → role (deck/video/integration/synthesis/transcribe) → model id
│   ├── policy.yaml                 # gate + routing thresholds (§3.5)
│   ├── intake.yaml                 # CSV column mapping (team, repo, deck, video, track, external_id)
│   ├── armoriq_signatures.yaml     # §3.3
│   └── rubrics/example_rubric.yaml # replaced by the organizer rubric
├── src/hackeval/
│   ├── settings.py
│   ├── schemas/                    # every contract (Pydantic), no logic
│   │   ├── rubric.py  submission.py  evidence.py  jev.py  findings.py  calibration.py  evaluation.py
│   ├── acquire/
│   │   ├── repo.py                 # partial clone, committer-date deadline check
│   │   ├── downloader.py           # HTTP / Google Slides+Drive export / yt-dlp; content sniffing; unreachable reasons
│   │   └── uploads.py
│   ├── digest/
│   │   ├── armoriq_scanner.py      # manifests + install scripts, Python `ast`, JS/TS tree-sitter, env, redaction
│   │   ├── deck.py                 # pptx → python-pptx text/notes + LibreOffice→PDF→pypdfium2 PNG; pdf direct
│   │   ├── video.py                # ffprobe, keyframe sampling, audio extraction/chunking
│   │   └── transcribe.py           # Transcriber protocol + GeminiTranscriber / OpenAITranscriber
│   ├── jev/
│   │   ├── client.py               # AsyncTypeSafeClient wrapper: pinned model, limiter, RetryPolicy, cache,
│   │   │                           # answer → JevDecision, state-budget trimming on max_tokens_exceeded
│   │   ├── gate_questions.py  prescreen_questions.py  calibration_questions.py
│   ├── stages/                     # pure logic, testable without ADK
│   │   ├── gate.py  prescreen.py  calibrate.py  route.py  feedback.py
│   ├── agents/
│   │   ├── models.py               # build_model(role) + per-provider limiter
│   │   ├── multimodal.py           # before_model_callback image injection
│   │   ├── output_schemas.py       # per-rubric dynamic schema: level fields are Literal[label…] enums
│   │   ├── prompts/{deck_analyst,video_analyst,integration_analyst,synthesis}.md   # versioned
│   │   └── deck_analyst.py  video_analyst.py  integration_analyst.py  synthesis.py
│   ├── pipeline/
│   │   ├── gate_workflow.py  scoring_workflow.py   # ADK Workflow wiring only
│   │   ├── nodes.py                # wrappers: call stage fn, checkpoint, emit Event(route=…, state=…)
│   │   ├── runner.py               # run one workflow for one submission
│   │   └── batch.py                # phased batches, resume, DB-backed job queue worker (CLI and API share it)
│   ├── store/  db.py  tables.py  queries.py   # SQLAlchemy over SQLite (WAL), swappable for Postgres
│   ├── leaderboard.py              # final score (human override > auto), per rubric version, CSV/JSON
│   ├── cli.py                      # Typer (§4)
│   └── api/  app.py  auth.py  deps.py
│       └── routes/  hackathons.py  submissions.py  runs.py  review.py  leaderboard.py  media.py
├── web/                            # React + Vite + TS + React Router + TanStack Query
│   └── src/
│       ├── api/ client.ts  schema.d.ts            # generated from FastAPI OpenAPI (openapi-typescript)
│       ├── pages/ Dashboard  Import  Submissions  SubmissionDetail  ReviewQueue  Leaderboard
│       └── components/ ScorecardTable  EvidenceViewer (SlideViewer · VideoPlayer seek-to-citation · CodeSnippet)
│                       ReviewForm (gate | score | attach-file)  StatusBadge
├── evals/
│   ├── gold/                       # human-scored submissions: gold.csv + artifacts
│   └── calibrate_thresholds.py     # replays stored outputs against gold → agreement + review-rate report
└── tests/
    ├── fixtures/repos/  decks/  videos/  jev/  submissions.csv(+expected_status column)
    ├── fakes.py                    # FakeJevClient (replays fixtures), ScriptedLlm(BaseLlm) (canned structured output)
    ├── unit/  integration/         # offline, run in CI
    └── live/                       # @pytest.mark.live — real Gemini / OpenAI / Jev
```

---

## 3. Schemas (Pydantic v2, `src/hackeval/schemas/`)

### 3.1 Rubric — immutable once used; the organizer file must validate
```python
Source = Literal["deck", "video", "repo"]

class RubricLevel(BaseModel):
    label: str                      # "Strong"; unique within the criterion. The LLM outputs the label, never an int.
    description: str                # observable; used verbatim in the LLM rubric AND as Jev Score criteria

class Criterion(BaseModel):
    id: str                         # slug, e.g. "problem_clarity"
    name: str; description: str
    weight: float                   # > 0, normalized
    sources: list[Source]           # which analysts see it; "repo" also enables integration_analyst
    levels: list[RubricLevel]       # ordered low → high, 2–10 levels (Jev Score limit)

class Rubric(BaseModel):
    id: str; version: str           # (id, version) immutable after the first evaluation uses it
    criteria: list[Criterion]       # validators: unique ids/labels, weight > 0, 2 ≤ levels ≤ 10
    tracks: list[str] = []          # optional; enables the Jev track_fit Choice
```
Changing the rubric creates a new version. Existing evaluations become `stale` and are re-scored from cached digests, with no re-download or re-transcription. Human reviews are kept, and an override is flagged if its criterion changed. The leaderboard is per rubric version. The example rubric is deck- and video-based (problem & solution clarity, demo quality, architecture as presented, innovation, presentation) and has a single repo-sourced criterion, *ArmorIQ integration depth*.

### 3.2 Submission & evidence
```python
class ArtifactRef:   kind: Literal["deck","video"]; origin: Literal["url","upload"]; uri: str; sha256: str | None
                     unreachable_reason: str | None
class Submission:    id; hackathon_id; external_id: str | None; team_name; track: str | None
                     repo_url; deck: ArtifactRef | None; video: ArtifactRef | None; submitted_at
                     # unique (hackathon_id, external_id or normalized repo_url); a newer pre-deadline entry supersedes

class RepoSnapshot:  url; commit_sha; committer_date; commits_after_deadline: int; file_count; readme_excerpt
class InstallHit:    path; kind: Literal["manifest","lockfile","dockerfile","script","notebook"]
                     ecosystem: Literal["pypi","npm"]; package; version_spec | None
class UsageSite:     path; line; symbol; kind: Literal["import","client_init","call","http_call"]; snippet; in_test: bool
class EnvSignal:     path; var; has_real_value: bool                       # the value is never stored
class ArmorIQEvidence: installs: list[InstallHit]; usage_sites: list[UsageSite]; sdk_functions_used: list[str]
                       unresolved: list[str]       # e.g. "dynamic import in src/x.ts:12", "notebook usage"
                       env_signals: list[EnvSignal]; config_files: list[str]; secret_exposed: bool; redacted_keys: list[str]

class SlideDigest:   index; text; notes; image_path | None              # text for all slides; images for a sample
class DeckDigest:    source_format: Literal["pptx","pdf"]; slide_count; slides; images_sampled: bool
class TranscriptSegment: start_s; end_s; text
class Keyframe:      t_s; image_path
class VideoDigest:   duration_s; has_speech: bool; transcript: list[TranscriptSegment]; keyframes: list[Keyframe]
```

### 3.3 `config/armoriq_signatures.yaml` (from the published SDKs, v0.6.10)
```yaml
packages:      { pypi: [armoriq-sdk], npm: ["@armoriq/sdk"] }
install_files: [requirements*.txt, pyproject.toml, Pipfile*, setup.py, setup.cfg, poetry.lock, uv.lock,
                package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, Dockerfile*, "*.sh", "*.ipynb"]
python_imports: ["armoriq_sdk", "armoriq_sdk.*"]
js_imports:     ["@armoriq/sdk", "@armoriq/sdk/*"]          # incl. dist/integrations/{google_adk,langchain,strands}
# USAGE RULE: any call or instantiation on an imported ArmorIQ binding (aliases tracked) is a usage site.
# The method lists below only label usage in reports; they do not gate (robust to SDK changes).
known_methods:
  python: [ArmorIQClient, from_config, capture_plan, get_intent_token, invoke]
  js: [ArmorIQClient, ArmorIQSession, capturePlan, getIntentToken, invoke, invokeWithPolicy, startSession,
       delegate, verifyToken, completePlan, listMcps, loadMcp, buildPlanFromToolCalls, loadArmorIQConfig]
env_vars:     [ARMORIQ_API_KEY, ARMORIQ_USER_ID, ARMORIQ_AGENT_ID, USER_ID, AGENT_ID]   # optional evidence
config_files: [armoriq.yaml]
hosts:        ["armoriq.ai"]
exclude_dirs: [node_modules, .venv, venv, vendor, dist, build, .git]
real_key_pattern: "ak_[A-Za-z0-9]{16,}"
```
Python files are parsed with `ast`, and JS/TS with tree-sitter, so comments and strings never count as usage.

### 3.4 Jev payloads — every SDK answer is normalized to `JevDecision`
```python
class JevDecision(BaseModel):
    question_id: str; type: Literal["noul","choice","score"]
    value: float | str              # noul → P(yes); choice → key; score → fractional 0-based index
    probabilities: dict[str, float] | None   # per option or level (exact SDK fields confirmed in spike M0a)
    confidence: float               # SDK value for choice/score; max(p, 1-p) for noul
    model: str; request_id: str
```
The model is pinned to `jev-1.13.0`, never `jev-latest`.
- **Gate (UNRESOLVED only):** the state is `{unresolved items, snippets ±15 lines}`. One Noul, `sdk_called_in_app_code`: "Does application code call the ArmorIQ SDK as part of its runtime behaviour (not only comments, docs or tests)?"
- **Prescreen (one call):** the state is `{deck text excerpt, transcript excerpt, README excerpt, declared track}`.
  - Nouls: `deck_is_real_pitch`, `video_shows_this_project`, `artifacts_describe_same_project`, `evaluator_injection_attempt`.
  - Choice: `track_fit`, only if the rubric has tracks.
- **Calibration (one call per criterion, so evidence can't leak between criteria and the state stays small):**
  - **State = raw evidence, not LLM prose.** That means the full deck text and the timestamped transcript for that criterion's `sources`. If this exceeds the state budget, fall back to the raw slides and segments the LLM cited. A repo-sourced criterion gets the scanner summary.
  - Questions: `score` = `Score(criteria=[f"{l.label}: {l.description}" for l in levels])` and `sufficient` = Noul ("Is there enough evidence here to place this submission on the rubric?").
  - Global question, added to the prescreen call after synthesis: `claims_unsupported`.
  - Jev sees no images, so slide-visual-only evidence lowers sufficiency, which routes to a human. That behaviour is intended.

### 3.5 Stage results, routing math, policy
```python
class GateResult:       status: Literal["pass","fail","review","needs_attention"]; checks: dict[str,bool]
                        reasons: list[str]; jev: list[JevDecision]; feedback_md: str | None
class PrescreenResult:  flags: dict[str, float]; track_fit: str | None; jev: list[JevDecision]

class Citation:         source: Source; ref: str               # "slide 4" | "02:13–02:41" | "src/agent.py:42"
class CriterionFinding: criterion_id; observations: list[str]; citations: list[Citation]; absent: bool
class ArtifactFindings: source: Source; summary; findings: list[CriterionFinding]; claims: list[str]; red_flags
class CriterionScore:   criterion_id; level_label: str; level: int  # level is mapped from the label in code
                        rationale; citations: list[Citation]
class Scorecard:        scores: list[CriterionScore]; strengths; weaknesses; inconsistencies; feedback_md
                        # llm_level := Scorecard (synthesis) level, the score of record

class CriterionCalibration: criterion_id; llm_level: int; jev_score: float | None; jev_probs: list[float] | None
                            agreement: float | None; sufficiency: float | None; level_gap: float | None
class CalibrationResult:    criteria; auto_score_0_100; confidence; route: Literal["accept","review"]
                            reasons: list[str]; discrepancy_notes: list[str]

Status = Literal["queued","needs_attention","disqualified","gate_review","scoring",
                 "needs_review","finalized","stale","superseded","error"]
class HumanReview: reviewer; kind: Literal["gate","score","attention"]
                   decision: Literal["accept","override","disqualify","reinstate","attach"]
                   overrides: dict[str, str]  # criterion_id → level label
                   notes; at
class Evaluation:  submission_id; rubric_version; status: Status; gate; prescreen; findings; scorecard; calibration
                   reviews: list[HumanReview]; final_score: float | None; versions: {prompts, llm_models, jev_model}
```

**ArmorIQ gate rule (`stages/gate.py`)** — mirrors the user's rule:
| Scanner result | Outcome |
|---|---|
| Install hit **and** ≥1 non-test usage site | **PASS** |
| No usage sites in app code (nothing at all, installed-but-never-called, comments only) | **FAIL** → auto-DQ |
| Usage sites but **no** install hit anywhere (manifests, lockfiles, Dockerfiles, scripts, notebooks) | **UNRESOLVED**: the scanner probably missed an install path |
| `unresolved` items: dynamic/aliased imports it can't follow, notebook-only, test-only usage | **UNRESOLVED** |
| Repo unreachable | **needs_attention**, never DQ |

UNRESOLVED goes to Jev `sdk_called_in_app_code`: at ≥ `gate.jev_pass` (0.8) the result is PASS, otherwise gate review. Jev never disqualifies. `commits_after_deadline > 0` is a review **flag**, not a DQ, and deadline pinning (by committer date) is configurable.

**Calibration math (`stages/calibrate.py` + `stages/route.py`, pure functions)**
- `agreement_c` = Jev probability mass on the LLM's level ± `level_tolerance` (default 0). Unlike a distance-based metric, it doesn't depend on how many levels the criterion has, and it doesn't punish the top and bottom of the scale.
  - Fallback if the SDK exposes no Score probabilities: `agreement_c = max(0, 1 − |jev_score − llm_level| / (max_level_gap + 1))`.
- `confidence` = the weight-averaged `agreement_c`.
- **Accept** only if all of these hold:
  - `confidence ≥ 0.85`
  - every `agreement_c ≥ min_criterion_agreement` (0.5)
  - every `sufficiency_c ≥ min_sufficiency` (0.6)
  - every `|jev_score − llm_level| ≤ max_level_gap` (1)
  - no flags tripped: `evaluator_injection_attempt ≥ 0.5`, `claims_unsupported ≥ 0.7`, `artifacts_describe_same_project ≤ 0.3`, `video_shows_this_project ≤ 0.3`, `secret_exposed` (reported only), `commits_after_deadline`
- Otherwise route to **review**. `reasons` records each rule that fired.
- `discrepancy_notes` gives, per flagged criterion: the LLM level and rationale, Jev's level distribution, and the cited evidence.
- `auto_score_0_100 = 100·Σ wᵢ·(levelᵢ/(nᵢ−1)) / Σ wᵢ` from the LLM levels. Jev calibrates; it doesn't score.
- `policy.yaml` holds every threshold above.
- **0.85 stays as you specified.** M8 tunes the other components against the gold set, with a target **review rate of ≤ 30%** of scored submissions. That target is an assumption; adjust it if you have one.

---

## 4. Interfaces

**CLI (`hackeval`, Typer):**
- `init <hackathon>`
- `rubric validate|activate <file>`
- `import <csv>` (column mapping from `intake.yaml`)
- `add --repo URL --deck FILE|URL --video FILE|URL`
- `run [--phase gate|score|all] [--only IDS] [--limit N] [--provider gemini|openai]`
- `reroute` (re-applies `policy.yaml` to stored outputs, with no model calls)
- `status` (counts, cost)
- `review list|show|resolve` and `attach <id> --deck|--video FILE`
- `leaderboard [--format csv|json]`
- `calibrate evals/gold/gold.csv`
- `serve`

**API (FastAPI; admin/judge bearer token):**
- Hackathons CRUD, plus rubric upload and activate.
- `POST /submissions/import` (CSV) and `POST /submissions` (multipart upload).
- `POST /runs` and `GET /runs/{id}`.
- `GET /submissions?status=` and `GET /submissions/{id}`.
- `GET /review-queue` and `POST /submissions/{id}/review`, which also takes attach-file.
- `GET /leaderboard` (+CSV).
- `GET /media/...` (slides, keyframes, and video with HTTP range support).
- Jobs run in the worker in `batch.py`, never inside a request.

**Web (React):**
- Dashboard: counts by status, run progress, cost.
- Import/Upload.
- Submissions table.
- SubmissionDetail: per-criterion LLM level vs Jev distribution, and clickable citations that seek the video, open the slide or show the code snippet.
- ReviewQueue: gate, score and attention reviews.
- Leaderboard: export.
- Styling uses ArmorIQ design-system tokens.

---

## 5. Milestones (TDD; each ends green in CI)

**M0 — Scaffold + spikes.**
- Run `git init`, set up the uv project, ruff, pyright, pytest and CI, and commit this plan as `docs/design.md`.
- Spikes are throwaway code in `spikes/`; record the answers in `docs/spikes.md`:
  - **(a)** `typesafe-sdk`: the Choice/Score probability and confidence field names, whether Score is 0-based, the state token budget and how an oversized state fails, and whether there is a question-count limit.
  - **(b) go/no-go on ADK `Workflow`:**
    - multi-chain edges
    - `Event(route=…)`
    - the `JoinNode` input shape
    - an `LlmAgent(mode="single_turn", output_schema=…)` node reading `ctx.state`
  - **(c)** image parts **and** `output_schema` on Gemini, on `OpenAILlm` and on the LiteLlm fallback.
  - **(d)** timestamped transcription on both providers: which OpenAI models return segments, and chunking under 25 MB.
- *Exit:* each question has a written answer, and the model IDs in `models.yaml` are filled from the accounts.

**M1 — Schemas, config, walking skeleton.**
- All models in §3, loaders, rubric validation, the dynamic output schema, the example rubric, DB tables, and intake mapping with dedupe.
- **The skeleton:** `hackeval run` goes end to end over `tests/fixtures/submissions.csv` with every stage stubbed by FakeJev and ScriptedLlm, and produces a leaderboard plus a review queue.
- *Tests:*
  - Invalid rubrics are rejected: 1 or 11 levels, duplicate id or label, zero weight.
  - Dedupe and supersede work.
  - Each fixture row reaches its `expected_status`.

**M2 — Repo acquisition + ArmorIQ gate.**
- `acquire/repo.py`, the scanner (`ast` + tree-sitter), `stages/gate.py`, DQ feedback, and the gate phase from the CLI.
- *Fixture repos and expected outcomes:*

| fixture | expected |
|---|---|
| `py_sdk_used` | PASS |
| `ts_sdk_used` | PASS |
| `ts_aliased_import` | PASS |
| `monorepo_nested` | PASS |
| `dockerfile_install` | PASS |
| `no_sdk` | FAIL |
| `sdk_installed_unused` | FAIL |
| `sdk_in_comments_only` | FAIL |
| `calls_without_install` | UNRESOLVED |
| `sdk_only_in_tests` | UNRESOLVED |
| `dynamic_import` | UNRESOLVED |
| `committed_secret` | PASS + `secret_exposed`, with the value absent from DB and logs |
| `post_deadline_commits` | flag |
| `private_repo` | needs_attention |

- *Live:* run it on 5 real public repos that use ArmorIQ.

**M3 — Deck & video digest + prescreen.**
- Inputs: pptx, pdf, Google Slides/Drive export; yt-dlp or upload.
- Sampling, both transcribers, content-hash cache, unreachable handling plus `attach`, and the Jev prescreen.
- *Tests:*
  - The fixture deck produces all slide text and N sampled PNGs.
  - A 100-slide deck samples evenly.
  - A login-page HTML response gives `needs_attention`.
  - Fixture video keyframe timestamps span the whole video.
  - A rerun hits the cache with zero transcription calls.
  - Live: one transcription per provider.

**M4 — ADK analyst agents.**
- Model factory and limiter, multimodal callback, the 3 analysts plus synthesis with label-enum output schemas, and fenced prompts.
- **Needs the organizer rubric and about 10 human-scored submissions (early gold set) before prompt tuning.**
- *Tests:*
  - ScriptedLlm wiring tests.
  - Output-schema rejection of unknown labels.
  - A live pytest over the early gold set, run once per provider. Pass if it is within ±1 level on ≥80% of criteria.
  - Per-submission cost is measured and recorded.

**M5 — Jev calibration + routing.**
- Per-criterion calibration calls, the math and rules in §3.5, discrepancy notes, `reroute`.
- *Tests:*
  - Table-driven pure-function tests: each rule fires on its own, agreement with and without probabilities, weight normalization.
  - FakeJev asserts that the Jev state holds no LLM levels or LLM prose.
  - The review rate is measured on the early gold set.

**M6 — Full workflows + batch + CLI complete.**
- Both ADK workflows wired in, phased batches, checkpoint/resume, reinstate goes to scoring, rubric versioning (`stale` → re-score from cache), the `review resolve` CLI, leaderboard export.
- *Exit:*
  - A live run over the 10-submission fixture set matches every row's `expected_status`.
  - A second run makes zero model calls.
  - Killing the run mid-way and resuming finishes without redoing completed nodes.
  - `reroute` makes zero model calls.

**M7 — API + React UI.**
- Routes, auth, media range streaming, the React pages, an OpenAPI-typed client, and ArmorIQ styling.
- *Tests:* httpx API tests, plus one Playwright happy path: create hackathon → upload rubric → import CSV + upload one submission → run → resolve gate, score and attach reviews → export the leaderboard.

**M8 — Calibrate against humans + harden.**
- Grow the gold set to 20–30 submissions.
- `calibrate_thresholds.py` replays stored outputs (no model calls) and tunes `level_tolerance`, `min_sufficiency` and `min_criterion_agreement` with 0.85 fixed. Targets: auto-accepted results within ±1 level of humans on ≥90% of criteria, and a review rate ≤30%.
- Deliver the cost/latency report, the Docker image, and a runbook covering keys, provider switch, resume and the review workflow.

---

## 6. Verification (end-to-end)

1. `uv run pytest -m "not live"` → offline suites green (FakeJev + ScriptedLlm).
2. `uv run pytest -m live` with `GOOGLE_API_KEY`, `OPENAI_API_KEY` and `TYPESAFE_API_KEY` set → Jev, both providers and transcription pass.
3. ``uv run hackeval init demo && uv run hackeval rubric activate config/rubrics/example_rubric.yaml && uv run hackeval import tests/fixtures/submissions.csv && uv run hackeval run``, then `uv run hackeval status` → every row matches `expected_status`.
4. `HACKEVAL_LLM_PROVIDER=openai uv run hackeval run --only <ids>` → completes, then compare the scorecards.
5. `uv run hackeval reroute` after editing `policy.yaml` → routes change and zero model calls are logged.
6. `uv run hackeval serve`, then in the browser: resolve gate, score and attach reviews, and export the leaderboard CSV.
7. `uv run hackeval calibrate evals/gold/gold.csv` → agreement and review-rate report.

## Open items (do not block M0–M3)
- Organizer rubric file (needed by M4).
- About 10 human-scored submissions by M4, growing to 20–30 by M8. A past hackathon or a pilot works.
- Confirm the ≤30% review-rate target.
- ArmorIQ team: confirm the signature list, and whether plugin-based integrations (ArmorClaude, OpenClaw) count as "using the SDK".
