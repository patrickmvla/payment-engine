---
type: decision
features: [payments, state-machine, ledger]
related: ["[[2026-04-26-amount-wire-format]]"]
created: 2026-04-26
confidence: high
---

# Multi-capture v1: capture accumulates, ledger writes per call

## Decision

A single authorization supports multiple partial captures, accumulating until
`captured_amount == authorized_amount` or the merchant stops. Each capture
call posts its own ledger transaction. The state machine permits
`captured → captured` self-loops. The first capture releases the full hold;
subsequent captures do not re-release.

Concrete implementation contract:

- `paymentService.capture(db, paymentId, { amount }, key)` accumulates:
  `capturedAmount = row.capturedAmount + captureAmount` (was overwrite).
- State machine: `TRANSITIONS.captured` includes `captured` (currently
  `["settled", "refunded", "partially_refunded"]`; add `"captured"`).
- Hold release is gated on first capture only:
  `if (row.capturedAmount === 0n) emit DEBIT customer_funds / CREDIT customer_holds for row.authorizedAmount`.
  Subsequent captures only post the merchant-share + fee entries.
- Capture amount validation: `captureAmount <= row.authorizedAmount - row.capturedAmount`
  (already implied by the existing `capture_limit` DB CHECK).
- Idempotency key required per capture call (already enforced by prior wiring).
- Each capture's ledger transaction has its own description:
  `"Capture $X.XX for {payment_id}"`. Witness reconciles by summing all
  `Capture` transactions per payment (sums `merchant_payable + platform_fees`
  CREDITs across all capture txns).

## Reasoning

The engine is committed to a Stripe-shape (recorded in [[2026-04-26-amount-wire-format]]).
Stripe-shape includes marketplace and split-shipment patterns where merchants
ship partial fulfillment and capture incrementally. Multi-capture is a
first-class pattern in that lane.

Author's intent — as stated by the engine owner — was multi-capture from the
start. The evidence in the docs supports this:

- `docs/06-invariants.md:140-145` (Invariant 5 example): explicit two-capture
  sequence ($70 then $30), running-sum constraint.
- `docs/05-api-design.md:120`: capture amount must be
  `<= authorized_amount - already_captured_amount` — only meaningful if
  multiple captures are expected.

`docs/02-payment-lifecycle.md:88-92` (single-capture, full hold release on
partial capture) was a stale early simplification, not the canonical model.
The implementation was built to that stale doc and drifted from intent.

The initial review of the codebase against the docs flagged this as
"code matches doc 02; docs 05/06 are inconsistent" and recommended
preserving single-capture. That recommendation is reversed: code drifted from
canonical, not the other way. Doc 02 is the one to rewrite.

## Strongest rejected alternative

**Single-capture v1, multi-capture v2.**

Counter-argument considered:

- v1 is consumer/SMB direct-charge; marketplace is v2.
- Smaller v1 scope = faster ship.
- Code already implements single-capture cleanly; refactor cost is now.
- Stripe shipped single-capture for years before adding multi-capture in
  late 2024 — that evolution path is proven.

Why it lost:

- The Stripe-shape commitment (prior vault entry) explicitly includes
  marketplaces. Marketplaces need split-shipment / incremental-fulfillment
  capture patterns in v1, not v2.
- Author's canonical intent was multi-capture; rejecting it would cement a
  bug, not preserve a feature.
- Refactor cost is bounded and small: state machine adds one valid
  transition; capture function changes overwrite to accumulation; hold-release
  becomes a one-line conditional gated on `capturedAmount === 0n`. Tests
  update one matrix cell. Doc 02 rewrites one section.
- Refactoring later under consumer pressure (when many clients depend on
  single-capture semantics) is strictly more expensive than refactoring now.

## Failure mode

The model breaks if any of these become true:

1. **Hold release gating bug.** If the first-capture hold-release condition
   is mis-coded (e.g., releases on every capture, or never releases), the
   ledger desyncs from `customer_holds`. Mitigation: integration test that
   asserts `customer_holds == 0n` after the first capture of any payment,
   and unchanged after subsequent partial captures of the same payment.

2. **Concurrent capture race.** Two simultaneous capture requests with
   different idempotency keys but same payment ID. The existing
   `findPaymentForUpdate` lock serializes them; the second sees the
   accumulated `capturedAmount` and validates against
   `authorizedAmount - newCapturedAmount`. Already covered by the locking
   work in this session, but worth a dedicated multi-capture race test.

3. **Refund-of-which-capture ambiguity.** A refund after multiple captures
   doesn't specify which capture is being refunded. Current refund code
   uses `capturedAmount - refundedAmount` as the cap, which is correct in
   aggregate but loses per-capture provenance. v1 does NOT track refund
   provenance per capture. If audit later requires "this $X refund came
   from capture #2," that's a v2 feature.

4. **Settlement timing across multi-capture.** Settle currently transitions
   `captured → settled` and uses `row.capturedAmount` (the running total).
   If a merchant captures $70, settles, then captures another $30, the
   second capture would attempt to transition `settled → captured`, which is
   invalid. The state machine forbids this. Decision implication: a payment
   can be captured multiple times BEFORE settlement, but settlement is
   one-shot and finalizes the captured total. Document this explicitly in
   the rewritten doc 02.

## Revisit when

- Refund needs per-capture provenance tracking (audit requirement,
  jurisdiction-specific reporting, capture-level dispute handling).
- Settlement needs to operate on individual captures rather than the
  payment's running total (rare; per-capture settlement timing is unusual).
- Performance: ledger transaction count per payment grows linearly with
  capture count. If a single payment routinely has > 10 captures (delivery
  platforms with per-line-item capture?), index strategy on
  `ledger_transactions(reference_id)` may need revisiting.

## Implementation tasks

These are concrete and belong in the next implementation session, not in
this design entry:

1. `src/payments/state-machine.ts`: add `"captured"` to
   `TRANSITIONS.captured`.
2. `src/payments/service.ts` `capture()`: change
   `capturedAmount: captureAmount` to
   `capturedAmount: row.capturedAmount + captureAmount`. Gate the
   hold-release entry pair on `row.capturedAmount === 0n`. Validate
   `captureAmount <= row.authorizedAmount - row.capturedAmount`.
3. `tests/unit/state-machine.test.ts`: 8×8 matrix `captured.captured: true`;
   `getValidTransitions("captured")` returns 4 entries.
4. New integration tests in `tests/integration/payments/capture.test.ts`:
   - Two captures totaling auth amount → second succeeds, accumulates
   - Sum of captures > auth → second rejected with `invalid_amount`
   - Hold released on first capture only (`customer_holds == 0n` after
     first; unchanged after second)
   - Multi-capture then settle uses sum of captures as merchant share
5. `docs/02-payment-lifecycle.md`: rewrite the "Partial Capture" subsection
   to match the multi-capture model in docs 05 and 06. Update the state
   machine diagram if it shows `captured` as a single-shot terminal node
   for capture.
6. `tests/reconciliation/witness.test.ts`: verify it correctly sums multiple
   capture transactions per payment (it iterates ALL transactions, so
   should already work — confirm via a multi-capture witness test).
