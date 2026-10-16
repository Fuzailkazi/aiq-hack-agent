# Review, chore-retire-python, 2026-10-16

**Reviewed by**: Sonnet 5.5 (author on unknown)
**Scope**: 7 non-Python files (plus Python deletions, not reviewed), branch vs feat/ts-rewrite
**Verdict**: Approve with nits

## Summary
Retires the Python implementation, bumps @typesafe-ai/sdk 0.6.0 to 0.7.0, adds a live probe script and two SDK 0.7 tests. The bump is safe for current callers: state is always an object, Jev usage is metered per call (not per token), no question uses `box`, and the SDK falls back to uncompressed bodies where zstd is unavailable. 363/363 tests pass; `npm run check` shows only 3 pre-existing info-level Biome notes.

## Minor
### 🟡 toDecision has no handling for the new `box` answer type, `src/jev/client.ts:24`
**Problem**: `Answer` is a hand-written union of noul/choice/score and `data.answers` is cast to it. The switch has no default, so an unexpected type (e.g. `box`) returns `undefined` silently instead of failing.
**Why it matters**: Latent only. No code builds box questions today, but a future one would yield undefined decisions and a confusing downstream crash.
**Suggested fix**: Add an exhaustive default that throws a clear error naming the unsupported answer type.

### 🟡 Probe script has no key check and unguarded failures, `scripts/jevProbe.ts:10`
**Problem**: Without TYPESAFE_API_KEY the SDK throws an opaque error at the first call. Also the state-size loop only catches 400/422; a 413 or timeout for the 128k-word case rethrows and loses earlier output (acceptable) but the size limit may be reported differently.
**Why it matters**: Developer-facing only; the spike result in docs/spikes.md is meant to come from this script.
**Suggested fix**: Print a clear message if the key is missing, and treat 413 as a rejection too.

## Nits
- ⚪ `docs/spikes.md:60`, says "361 tests" but the suite is now 363 after the new tests.
- ⚪ `package.json:8`, engines is `>=22` while zstd needs 22.15+; harmless (SDK falls back), but worth knowing if a proxy rejects `Content-Encoding: zstd` (`compression: false` is the escape hatch, not wired in `src/jev/client.ts:70`).
- ⚪ `test-preferences.json:3`, `gate: null` and `additionalTools` fine, just confirm it should be committed.

## Strengths
- The tests target the real 0.7 risks: null usage tokens and absent request id, and a large state round-tripped through actual zstd decompression, guarded by `it.runIf`.
- Docs honestly state that live 0.7 behavior is unverified until `jev:probe` runs, and record the archive bundle location and restore command.

## Test coverage
New SDK-0.7 behaviors are covered. Not covered: the box answer path (unused), and the probe script (manual by design).
