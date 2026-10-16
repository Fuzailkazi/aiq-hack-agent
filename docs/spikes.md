# M0 Spike Results

Probed on 2026-10-01 against installed packages: `google-adk==2.10.0`, `typesafe-sdk==0.7.2`, `tree-sitter-language-pack==1.20.0`, Python 3.12.

## (a) Jev / `typesafe-sdk` — mostly answered (no API key needed); live part pending

- Answer models (`typesafe_sdk`):
  - `NoulAnswer.noul: float`, which is P(yes). There is no confidence field.
  - `ChoiceAnswer.choice: str`, `.confidence: float`, `.probabilities: dict[str, float]`.
  - `ScoreAnswer.score: float`, `.confidence: float`, `.legend: dict[int, ...]`, `.probabilities: dict[int, float]`.
- **Score is 0-based.** Level keys are positions in the `criteria` list, and `score` is the expected value over those levels. Confirmed in the docs at docs.typesafe.ai/primitives/score.
- **Score confidence** is computed from how spread out the probabilities are: one sharp peak gives 1.0. It measures clarity, not correctness.
- **Jev distributions can be broad.** The docs' own example has a top probability of 0.57 and confidence 0.35. Two consequences for M5:
  - Never gate on Jev confidence.
  - Measure `level_tolerance` on the early gold set before trusting the 0.85 bar.
- `SystemOneResponse` has `model`, `usage` (`input_tokens`/`output_tokens`) and `answers` (a dict keyed by question id). `response.request_id` is a property read from the `x-typesafe-request-id` header, and it raises `TypeSafeError` if the header is missing.
- `Noul(instructions=..., criteria={"true": ..., "false": ...})`. `NoulCriteria` is a TypedDict with optional `true`/`false` keys.
- Client:
  - `AsyncTypeSafeClient(api_key=None, model=None, retry=RetryPolicy(...), timeout=..., transport=httpx2.AsyncBaseTransport, base_url=...)`.
  - It has `aclose()` and supports `async with`.
  - **Constructing it without `TYPESAFE_API_KEY` raises `TypeSafeError`**, so our wrapper creates the client lazily.
- Offline testing works: `AsyncTypeSafeClient(api_key="test", transport=httpx2.MockTransport(handler))`. Requests go to `POST https://api.typesafe.ai/v1/systemone` with body `{"state", "model", "questions": {id: {"type", "instructions", "criteria"}}}`.
- `RetryPolicy` defaults: 2 retries, 0.5 s → 5 s backoff, 30 s timeout. 408, 429 and 5xx are retried.
- **Pending (needs `TYPESAFE_API_KEY`):** the practical state token budget and how an oversized state fails. It was never run in the Python repo. The probe is ported to TypeScript as `scripts/jevProbe.ts`: run `TYPESAFE_API_KEY=... npm run jev:probe` and paste the output here. It also prints whether Score probabilities sum to 1. M1–M2 don't need it; M5 does.

## (b) ADK 2.10 `Workflow` — **GO**

- Imports: `from google.adk import Event, Workflow, Context` and `from google.adk.workflow import START, JoinNode, DEFAULT_ROUTE, FunctionNode`. **`START` is not exported from `google.adk`.**
- Node types: plain sync or async functions, async generators, and closures all work, including closures defined inside a factory, which gives dependency injection.
- Parameters other than `node_input`/`ctx` are bound **from session state by name**. Values written by an earlier node via `Event(state={...})` are visible to later nodes. A `None` value in state binds fine.
- Routing: `yield Event(route="x")` together with an edge `(node, {"x": next_node, ...})`. A route value can be a tuple of nodes, which fans out.
- Edges: multiple chains are allowed in one list, e.g. `[(START, a, {"ok": b}), (b, (c, d, e), JoinNode(name="join"), f)]`.
- `JoinNode` output is a dict keyed by **function name**: `{"deck_analyst": ..., "video_analyst": ..., ...}`.
- Running it:
  - `InMemoryRunner(agent=workflow, app_name="hackeval")`.
  - `session_service.create_session(app_name, user_id, state=...)`, then `run_async(user_id, session_id, new_message=types.Content(...))`, then `get_session(...)`.
  - One runner is reusable across many sessions, and `delete_session` exists.
- A node exception surfaces as an error event and then **raises out of `run_async`**, so callers must catch it.
- `FunctionNode(func=..., name=..., retry_config=RetryConfig, timeout=...)` is available if we need per-node retries or timeouts (M6).

## (c) Image parts + `output_schema` across providers — pending (needs keys), scheduled for the M4 plan

- `google.adk.labs.openai.OpenAILlm` requires the `google-adk[openai]` extra and is built on the **OpenAI Responses API**.
- `BaseLlm.generate_content_async(self, llm_request, stream=False) -> AsyncGenerator[LlmResponse, None]` is the signature for our `ScriptedLlm` test fake.

## (d) Timestamped transcription — pending (needs keys), scheduled for the M3 plan

## Tooling notes

- `tree-sitter-language-pack` 1.20 **downloads grammars on first use** into `~/Library/Caches/tree-sitter-language-pack/`. CI and Docker must pre-download them with `python -c "import tree_sitter_language_pack as t; t.download(['javascript','typescript','tsx'])"`.
- tree-sitter JS/TS node types we rely on:
  - `import_statement` (field `source`), `import_specifier`, `namespace_import`
  - `call_expression` (`function`, `arguments`), `new_expression` (`constructor`)
  - `comment`, `string`; dynamic `import(...)` is a `call_expression` whose function node type is `import`

## JavaScript stack (2026-10-01, for the TypeScript rewrite)

Probed against npm packages: `@google/adk` 2.2.0, `@typesafe-ai/sdk` 0.6.0, `web-tree-sitter` 0.27 with the official grammar wasm files, `unpdf` 1.8, and poppler `pdftoppm`.

**2026-10-16: `@typesafe-ai/sdk` upgraded to 0.7.0**, matching the 0.7 line the Python version used. The type definitions only add things for our use (`box` questions, `assets`, zstd request compression on Node 22.15+). The noul, choice and score answer shapes are unchanged. Two changes could affect us. `state` may no longer be null, but every caller passes an object. `usage` token counts may now be null, but we meter Jev per call, not per token. The full offline suite passed unchanged (361 tests). Two tests in `tests/unit/jevClient.test.ts` now lock in null usage, a missing request id, and large states sent intact under zstd. Live behavior on 0.7.0 is still unverified until `npm run jev:probe` runs with a key.

- **ADK JS `Workflow` — GO.**
  - Building the graph: `new Workflow({name, edges: [[START, a, {ok: b, unreachable: c}], [b, [x, y, z], new JoinNode({name}), d]]})`.
  - Nodes: `new FunctionNode(name, async (ctx, input) => ...)`. State is read with `ctx.state.get(key)`.
  - Events: `createEvent({output, route, actions: {stateDelta}})`.
  - `JoinNode` output is keyed by node name.
  - Running it: `new InMemoryRunner({agent: workflow, appName})`, then `runner.sessionService.createSession({appName, userId, state})`, then `runAsync({userId, sessionId, newMessage})`.
  - A node exception raises out of `runAsync`, after an error event.
- **ADK JS agents:**
  - `LlmAgent.outputSchema` accepts Zod 4 schemas.
  - A custom model extends `BaseLlm` and implements `generateContentAsync(llmRequest, stream, abortSignal)` plus `connect`.
  - There is **no OpenAI adapter** (only Gemini, Apigee and Chrome built-in), so we write one.
- **Jev TS SDK:**
  - Calls: `new TypeSafeClient({apiKey, defaultModel, fetch})` (a `model` key is silently ignored and requests fall back to `jev-latest`, so also pass `model` per request) and `client.systemOne({state, questions})` with `noul(instructions, criteria?)`, `choice(instructions, criteria)` and `score(instructions, levels)` builders.
  - The response has `{model, answers, usage}`, with the same answer shapes as Python.
  - Constructing the client without a key throws, so it is created lazily. Tests inject a fake `fetch`.
- **web-tree-sitter (WASM):**
  - `await Parser.init(); Language.load(require.resolve("tree-sitter-python/tree-sitter-python.wasm"))`.
  - The JS, TS and TSX grammar wasm files ship inside `tree-sitter-javascript` and `tree-sitter-typescript`.
  - Native `tree-sitter` bindings hit peer-dependency conflicts, so the WASM build was chosen for portability.
- **PDF:** `unpdf` `extractText(pdf, {mergePages: false})` gives per-page text. Page images come from `pdftoppm -png -r 100 -f N -l N -singlefile` (poppler; `poppler-utils` in CI/Docker), which avoids a native canvas dependency.
- **TypeScript:** pinned to 5.9 (TS 7 is the new native compiler; tooling compatibility is not yet assumed).
