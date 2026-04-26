# Recording Guide — Loom Walkthrough (B+C, 60s/60s)

Per `[[2026-04-26-loom-walkthrough-content]]`. Two halves, ~2 minutes total.
Drop the file into `landing/public/walkthrough.mp4` after recording, OR use
the Loom embed URL (preferred — Loom hosts the video).

## Pre-recording checklist

- [ ] Repo is at the latest commit
- [ ] `bun run test` is green (447/447)
- [ ] `payment-engine-db-1` is up: `docker compose up -d`
- [ ] Terminal font ≥ 14pt, dark theme, max 100 columns wide
- [ ] Screen resolution 1080p (Loom encodes well at this)
- [ ] Mic levels checked
- [ ] Distractions silenced
- [ ] Architecture diagram (`landing/src/pages/index.astro` arch section) open in another tab for the C half

---

## Half 1 — Bug-find-and-fix story (~60s)

**Goal:** demonstrate financial-grade engineering judgment. Find a critical
bug, prove it RED with a failing test, fix it, prove it GREEN, confirm no
regressions.

**Setup before recording:** check out a commit BEFORE the partial-refund
double-refund fix so the bug is reproducible. (Or stash the fix.)

**Spoken script** (read at conversational pace, ~60 seconds total):

> "I was reviewing the engine against the spec and noticed something
> serious. The route layer required an Idempotency-Key header on refunds
> — but the service layer never used it. Same for capture, void, and
> settle. Network retries of partial refunds could double-refund — money
> out twice, no error to the client.
>
> [run failing test]
>
> Here are four failing tests asserting the contract: same-key retry
> returns identical refund, no extra ledger entries, full-refund retry
> returns the original 200, different-amount-same-key returns 409.
> Watch them turn RED.
>
> [show RED output]
>
> The fix: a race-safe claim helper using INSERT ... ON CONFLICT DO
> NOTHING RETURNING — atomic, no TOCTOU window. Wired through every
> mutation: capture, void, settle, refund. Eighty call sites updated
> across tests and factories.
>
> [run tests again]
>
> Four GREEN. Full suite of 447 tests still GREEN. Twelve new retry
> tests added across all four mutations. Four vacuous tests that passed
> by accident replaced with tests that actually retry."

**Show on screen** (terminal capture):
1. The failing test file (~5s)
2. `bun run test tests/integration/payments/idempotency.test.ts -t "refund retries"` → 4 RED (~15s)
3. The fix in `src/payments/service.ts` and `src/shared/idempotency.ts` — quick scroll-by (~10s)
4. Re-run the same command → 4 GREEN (~10s)
5. Full suite: `bun run test` summary line `447/447` (~5s — fast-forward most of the run)

---

## Half 2 — Architecture walkthrough (~60s)

**Goal:** demonstrate systems thinking. The mental model behind the engine
in the time it takes a senior engineer to nod.

**Show on screen:** the architecture diagram from
`landing/src/pages/index.astro` (or `docs/03-architecture.md`).

**Spoken script** (~60 seconds):

> "The engine is a two-layer design. Routes validate via Zod, which
> doubles as the OpenAPI 3.1 spec, served live at /docs through Scalar.
>
> [point at routes layer]
>
> Routes call services. Service layer holds the state machine — eight
> states, thirteen valid transitions. Each mutation acquires a per-payment
> SELECT FOR UPDATE lock so concurrent operations on the same payment
> serialize.
>
> [point at service layer]
>
> Inside each mutation, the first thing we do is claim the idempotency
> key. INSERT ON CONFLICT DO NOTHING RETURNING. If we lose the race, we
> read the existing record, validate the parameters match, and return
> the cached response. If we win, we proceed to the ledger.
>
> [point at idempotency layer]
>
> The ledger is double-entry. Every transaction posts balanced entries —
> SUM of debits equals SUM of credits, enforced at the application level
> AND by a god-check assertion that runs after every integration test.
>
> [point at ledger layer]
>
> Money is BigInt throughout. Zero floating-point math anywhere in the
> path. Multi-capture is supported — one auth, N partial captures, hold
> released on the first one only.
>
> [end pointing]
>
> Forty-seven tests cover this — unit, integration, e2e, property-based,
> fuzz, witness reconciliation. Plus seven architectural decisions
> recorded in the vault, each with the rejected alternative and why it
> lost."

---

## Post-recording

- [ ] Trim to ~2:00 (acceptable up to 2:30 if both halves earn it)
- [ ] Title: "Payment Engine — finding and fixing a financial bug + architecture in 2 minutes"
- [ ] Description: link to the GitHub repo
- [ ] Set Loom to "anyone with the link" privacy
- [ ] Copy embed URL → paste into `landing/src/pages/index.astro` (`LOOM_EMBED_URL` constant)
- [ ] Copy embed URL → paste into `README.md` near the top (replace placeholder)

## If pacing feels rushed in dry-run

Per the failure-mode in `[[2026-04-26-loom-walkthrough-content]]`:
- Option 1: extend to 90s/90s (3 min total). Acceptable for senior
  audiences who watch all the way through.
- Option 2: trim Half 1 to 45s by skipping the diagnostic walk —
  jump straight from "here's the bug" to "RED → fix → GREEN."
