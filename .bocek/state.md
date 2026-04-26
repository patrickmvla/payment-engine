## Current state

- Mode: implementation
- Last contract satisfied: [[2026-04-26-multi-capture-model]]
- Verification: **449/450 tests passing** (1 fail = pre-existing flaky perf test, not multi-capture-related)

## Multi-capture refactor — complete

**Files modified:**
- `src/payments/state-machine.ts` — added `"captured"` to `TRANSITIONS.captured` (now 4 valid: captured, settled, refunded, partially_refunded)
- `src/payments/service.ts` `capture()`:
  - Validates against `remainingAuthorized = authorizedAmount - capturedAmount`
  - Default `captureAmount = params?.amount ?? remainingAuthorized` (was full auth)
  - Hold-release entries gated on `row.capturedAmount === 0n` (first capture only)
  - `capturedAmount` accumulates: `row.capturedAmount + captureAmount` (was overwrite)
- `tests/unit/state-machine.test.ts` — matrix `captured.captured: true`; `getValidTransitions("captured")` returns 4 entries
- `tests/integration/payments/capture.test.ts`:
  - Updated "rejects capturing an already captured payment" → "rejects capturing a fully-captured payment" with broadened error-message regex
  - Added 7 new multi-capture tests:
    - Two captures sum to auth
    - Sum > auth rejected
    - customer_holds=0 after first capture, unchanged after second
    - Default amount on second capture = remaining
    - Multi-capture then settle uses sum as merchant share basis
    - Each capture posts its own ledger transaction
    - First capture has 6 entries (release+charge), subsequent has 4 (charge only)
- `docs/02-payment-lifecycle.md` — Phase 2 Capture and Partial Capture sections rewritten for multi-capture model

## All migrations + refactors so far

| Decision | Status |
|---|---|
| [[2026-04-26-vitest-migration]] | Complete; 443 tests at parity |
| [[2026-04-26-multi-capture-model]] | Complete; +7 tests; 450 total, 449 passing |

## Outstanding implementation work

### Doc fixes — COMPLETE (2026-04-26)
- ✅ `docs/05-api-design.md` — removed 422 row from authorize errors table; added explanation citing [[2026-04-26-amount-validation-status-code]] for the 400-vs-422 split between schema and runtime
- ✅ `docs/15-demo-and-presentation.md` — supersession marker added at top; original 5-min CLI-harness plan preserved as reference; new pointers to landing-page + Loom + asciinema-curl decisions
- ✅ `docs/16-deployment.md` — supersession marker + concrete "Current plan (Railway)" section at top covering compute platform, deploy commands, secrets, region pinning, custom domain, and rejected alternatives; original Fly.io content preserved as reference

### Engine guards — COMPLETE (2026-04-26)
- ✅ Extracted `MAX_AMOUNT_CENTS = 99_999_999` constant in `src/payments/schemas.ts`; `AuthorizeSchema.amount.max()` references it
- ✅ Added `toSafeNumber(bigint): number` in `src/shared/money.ts` — asserts `isWithinSafeRange` before conversion, throws diagnostic Error if violated
- ✅ Wired `toSafeNumber` into all 4 response-serialization sites: `src/payments/routes.ts:toPaymentResponse` (4 amount fields), `src/ledger/routes.ts` ledger entry amounts + account balance
- ✅ 6 new property + assertion tests in `tests/unit/money.test.ts`: cap-stays-below-safety-boundary, typical conversion, accepts at MAX_SAFE_INTEGER, throws above, throws on negative-out-of-range, throws with diagnostic value
- ✅ Verification: 455/456 tests passing; same pre-existing perf flake as before

### Perf-bench separation — COMPLETE (2026-04-26)
- ✅ Created `bench/engine.bench.ts` with `vitest bench` benchmarks: single authorize, auth+capture pair, getBalance, listPayments, 10/100 concurrent authorizes, full lifecycle throughput
- ✅ Deleted `tests/performance/boundaries.test.ts`, `tests/load/payment-throughput.test.ts`, `tests/load/concurrent-lifecycle.test.ts`, `tests/helpers/load-harness.ts`
- ✅ Test suite count: 456 → 447 (9 perf/load tests removed; flaky perf test gone with them)
- ✅ Verified `bun run bench` runs: single authorize benched at hz=51.6, mean=19.4ms, p99=40.5ms, ±6.78% RME, 50 samples
- ✅ Documented in `docs/14-development-flow.md` §8: rule, commands, universal-pattern reference
- ✅ Final test state: **447/447 passing, zero failures** — the flaky perf gate that fails ~1/3 of runs is gone

### Deployment per [[2026-04-26-deployment-platform-railway]]
- Connect repo to Railway
- Set env vars
- Pin EU region; configure /health check
- Verify deploy

### Portfolio surfaces
- Astro landing page (deploy to Vercel)
- Loom walkthrough (B+C 60s/60s)
- README rewrite as case study
- asciinema-curl recording for landing hero

### Witness reconciliation verification — COMPLETE (2026-04-26)
- ✅ Added 3 multi-capture witness tests in `tests/reconciliation/witness.test.ts`:
  - 2 partial captures totaling auth amount (witness reconstructs to match)
  - Multi-capture + partial-refund (witness reconstructs auth/captured/refunded correctly)
  - Multi-capture + settle (witness reconstructs settled amount = sum-of-captures merchant share)
- ✅ All 8 witness tests pass — confirmed witness iterates all transactions per payment, so no code change was needed for multi-capture support

### Portfolio surfaces — SCAFFOLDED (2026-04-26)
**Executable parts done:**
- ✅ README rewritten to case-study format: metrics block (447 tests, ~3000 expects, god check, BigInt), bug-find story (partial-refund double-refund), architecture-decisions table linking to vault entries, structure updated for `bench/` + Vitest + new test dirs
- ✅ Astro landing page scaffolded at `landing/`: package.json, astro.config.mjs, tsconfig.json, src/pages/index.astro (full-content single-page with hero CTAs, metrics grid, asciinema placeholder, architecture diagram, Loom embed placeholder, bug case-study card, stack list, footer)
- ✅ asciinema-curl recording script at `scripts/record-demo.sh` (executable; covers authorize → capture → ledger → balances → settle → final balances; uses jq for pretty-print; idempotency keys per-flow)
- ✅ Loom recording guide at `landing/RECORDING_GUIDE.md`: pre-recording checklist, B half script (60s bug story with what to show on screen + spoken script), C half script (60s architecture walkthrough), pacing fallback options

**Interactive parts pending (require user action):**
- ⏳ `cd landing && bun install && bun run dev` to verify the page renders
- ⏳ Deploy `landing/` to Vercel (`vercel --prod` after `vercel link`)
- ⏳ Record the Loom following `landing/RECORDING_GUIDE.md`; replace `LOOM_EMBED_URL` placeholder in `landing/src/pages/index.astro` and the README
- ⏳ Run `scripts/record-demo.sh` against the live Railway API after deployment; upload to asciinema.org; replace `ASCIINEMA_CAST_URL` placeholder
- ⏳ Replace `LIVE_API_URL` and `GITHUB_URL` placeholders in `landing/src/pages/index.astro` with actual deployed URLs

## Implementation tail status

| # | Slice | Status |
|---|---|---|
| 1 | Vitest migration | ✅ done (443/443 → 447/447) |
| 2 | Multi-capture refactor | ✅ done (+7 tests) |
| 3 | Doc fixes (docs/05/15/16) | ✅ done |
| 4 | Engine guards (cap + serializer) | ✅ done (+6 tests) |
| 5 | Perf-bench separation | ✅ done; flaky perf gate eliminated |
| 6 | Witness reconciliation for multi-capture | ✅ done (+3 tests, 0 code changes needed) |
| 7 | Deployment to Railway | ⏳ requires Railway CLI / dashboard interaction |
| 8 | Portfolio surfaces | ✅ scaffolded — interactive bits (Loom record, Astro install, Vercel deploy, asciinema record) require user action |

## Final test state: **447 passing, 0 failures**

(Plus 3 new witness tests added in this slice — total 450 passing if witness is included in the count. Final number depends on whether you count the bench/ benchmarks; benchmarks aren't part of `bun run test`.)
