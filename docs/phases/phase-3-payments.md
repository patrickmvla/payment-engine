# Phase 3: Payment Layer — Where Money Moves

The ledger is the source of truth. Phase 3 is the thing that makes the truth
happen. Authorize, capture, void, refund, settle, expire — six operations that
move money between accounts, each producing exactly the right ledger entries,
each protected by a state machine that refuses to let money move when it
shouldn't.

This is the largest phase. ~300 tests. The unit tests prove the pure logic is
correct. The integration tests prove the database operations are correct. The
concurrency tests prove that two requests arriving at the same millisecond
don't corrupt anything. The invariant tests prove that after all of it — every
race, every edge case, every partial refund — `SUM(debits) === SUM(credits)`.

If Phase 2 proved the ledger works, Phase 3 proves the payment engine works.

**Goal:** Full payment lifecycle with state machine enforcement, idempotency,
and concurrency safety. Every operation creates correct, balanced ledger entries.

**Gate:** All unit tests (~165) green. All integration tests (~135) green. God
check passes after every operation type. Concurrent operations don't corrupt
state. `bun test --bail` exits 0.

---

## Why Unit Tests Come First

Phase 3 starts with ~165 unit tests before touching the database. This isn't
an accident. The state machine, fee calculation, and validation schemas are
pure functions — they can be tested in under a millisecond each, with zero
infrastructure. If `validateTransition("authorized", "captured")` doesn't
return `"captured"`, you don't need a database to find that out.

Unit tests first means:
1. The state machine is locked down before any service function calls it
2. The fee math is proven correct before any capture writes entries
3. The validation schemas reject bad input before it reaches the database
4. When an integration test fails, you know it's a service-layer bug — not a
   logic bug hiding behind a database connection

---

## Pre-flight

- [ ] Phase 2 gate passed — all ~25 ledger tests green, god check passes
- [ ] Ledger service is standalone with zero payment awareness
- [ ] Test helpers compile (`setup.ts`, `god-check.ts`, `assertions.ts`)
- [ ] Docker Postgres running, both main and test DBs migrated and seeded
- [ ] `bun run lint` passes

---

## TDD Sequence

Twenty-three steps. The god check appears after every mutation implementation —
not just at the end. If capture creates unbalanced entries, we know at step 10,
not step 23.

```
Step 1:  Write unit tests for state machine        → RED
Step 2:  Implement state machine                    → GREEN
Step 3:  Write unit tests for validation schemas    → RED
Step 4:  Implement Zod schemas                      → GREEN
Step 5:  Write unit tests for money utilities       → RED
Step 6:  Implement money utilities                  → GREEN
Step 7:  Write integration tests for authorize      → RED
Step 8:  Implement authorize                        → GREEN + god check
Step 9:  Write integration tests for capture        → RED
Step 10: Implement capture                          → GREEN + god check
Step 11: Write integration tests for void           → RED
Step 12: Implement void                             → GREEN + god check
Step 13: Write integration tests for refund         → RED
Step 14: Implement refund                           → GREEN + god check
Step 15: Write integration tests for expiration     → RED
Step 16: Implement expiration                       → GREEN + god check
Step 17: Write integration tests for settlement     → RED
Step 18: Implement settle                           → GREEN + god check
Step 19: Write query tests                          → RED
Step 20: Implement getPayment(), listPayments()     → GREEN
Step 21: Write idempotency tests                    → RED
Step 22: Implement idempotency                      → GREEN
Step 23: Write concurrency + invariant tests        → RED → GREEN + god check
```

Notice the pattern: unit tests (steps 1-6) have no god check — they don't
touch the database. Integration tests (steps 7-23) run the god check after
every GREEN. The first time money moves through the system, the system proves
it balanced.

---

## 1. Unit Tests — Pure Logic, No Database (~165 tests)

### 1a. State Machine (`tests/unit/state-machine.test.ts`) — ~80 tests

**Source:** Doc 08a, Section 2

The state machine is the control flow of the payment engine. A single invalid
transition means money moves when it shouldn't. A captured payment that can
transition back to `authorized` would allow double-capture. A voided payment
that can transition to `captured` would resurrect a cancelled hold. One truth
table, 64 cells, zero ambiguity.

```typescript
import {
  validateTransition,
  getValidTransitions,
  PaymentStatus,
  TERMINAL_STATES,
  InvalidStateTransitionError,
} from "../../src/payments/state-machine";
```

**The Full 8×8 Matrix:**

| From \ To | created | authorized | captured | settled | voided | expired | refunded | partial_refunded |
|---|---|---|---|---|---|---|---|---|
| created | - | VALID | - | - | - | VALID | - | - |
| authorized | - | - | VALID | - | VALID | VALID | - | - |
| captured | - | - | - | VALID | - | - | VALID | VALID |
| settled | - | - | - | - | - | - | VALID | VALID |
| voided | - | - | - | - | - | - | - | - |
| expired | - | - | - | - | - | - | - | - |
| refunded | - | - | - | - | - | - | - | - |
| partially_refunded | - | - | - | - | - | - | VALID | VALID |

12 valid transitions, 52 invalid. Every cell gets a test. The 52 invalid cells
are more important than the 12 valid ones — they're the walls that keep money
from going where it shouldn't.

- [ ] **64 tests:** Full 8×8 matrix — each `(from, to)` pair asserts VALID or throws `InvalidStateTransitionError`
- [ ] `getValidTransitions("created")` → `["authorized", "expired"]` (length 2)
- [ ] `getValidTransitions("authorized")` → `["captured", "voided", "expired"]` (length 3)
- [ ] `getValidTransitions("captured")` → `["settled", "refunded", "partially_refunded"]` (length 3)
- [ ] `getValidTransitions("settled")` → `["refunded", "partially_refunded"]` (length 2)
- [ ] `getValidTransitions("partially_refunded")` → `["refunded", "partially_refunded"]` (length 2)
- [ ] `getValidTransitions("voided")` → `[]` (terminal — no way out)
- [ ] `getValidTransitions("expired")` → `[]` (terminal)
- [ ] `getValidTransitions("refunded")` → `[]` (terminal)
- [ ] `TERMINAL_STATES` is exactly `{voided, expired, refunded}` (length 3)

**Error diagnostics** — in production, the error message determines whether an
on-call engineer diagnoses the issue in 30 seconds or 30 minutes:

- [ ] `InvalidStateTransitionError` is instance of `Error`
- [ ] Error carries `.from` property (where we are)
- [ ] Error carries `.to` property (where we tried to go)
- [ ] Error carries `.allowedTransitions` array (where we CAN go)
- [ ] Error `.message` is human-readable, contains both `from` and `to`

### 1b. Money Operations (`tests/unit/money.test.ts`) — ~30 tests

**Source:** Doc 08a, Section 1

Every financial bug starts here. These tests don't just verify our BigInt
utilities work — they first PROVE that floating point is broken for money.
The IEEE 754 proof-by-failure tests exist so that anyone reading the test
file understands WHY we use BigInt. Not because someone said so. Because
`0.1 + 0.2 !== 0.3`.

```typescript
import {
  toMinorUnits, fromMinorUnits, addAmounts, subtractAmounts,
  divideAmount, isWithinSafeRange, CURRENCY_DECIMALS,
} from "../../src/shared/money";
```

**IEEE 754 proof-by-failure** (the WHY):
- [ ] `0.1 + 0.2 !== 0.3` — the classic
- [ ] Cumulative drift: 1000 additions of 0.1 → not 100 in float, exactly 10000n in BigInt
- [ ] Catastrophic cancellation: `1000000.01 - 1000000.00 !== 0.01`
- [ ] `MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2` in Number — two different amounts become indistinguishable
- [ ] Associativity failure: `(a + b) + c !== a + (b + c)` — order of operations changes the result
- [ ] BigInt addition is exact where float fails

**Currency precision** (not all currencies have 2 decimals):
- [ ] `CURRENCY_DECIMALS`: USD=2, EUR=2, GBP=2, JPY=0, BHD=3
- [ ] `toMinorUnits`: USD $1.00 → 100n, $0.01 → 1n
- [ ] `toMinorUnits`: JPY ¥500 → 500n (zero decimal — getting this wrong means charging 100x)
- [ ] `toMinorUnits`: BHD 1.0 → 1000n (three decimal — Bahraini Dinar uses fils)
- [ ] `fromMinorUnits`: round-trip preserves value

**BigInt arithmetic** (the actual math):
- [ ] `addAmounts`: correct sum, commutative, identity (x + 0 = x)
- [ ] `subtractAmounts`: correct difference, to zero (x - x = 0)
- [ ] 100,000 additions produce exact result (no drift)
- [ ] Operates correctly beyond `MAX_SAFE_INTEGER`
- [ ] `isWithinSafeRange`: boundary detection at 2^53

**Division with remainder** (fee math depends on this):
- [ ] Even division, uneven division with remainder
- [ ] Conservation law: `quotient × divisor + remainder === original` — no money created or lost (5 test cases)
- [ ] `divideAmount(1n, 100n)` → quotient 0, remainder 1 (1 cent is indivisible into 100 parts)
- [ ] Division by 1 is identity, division by 0 throws
- [ ] Large amount division preserves conservation

The conservation law is the money version of energy conservation. If you divide
$100.00 by 3, you get $33.33 with 1 cent remainder. `33.33 × 3 + 0.01 = 100.00`.
No money created, no money lost. The `divideAmount` function guarantees this
algebraically, not approximately.

### 1c. Balance Computation (`tests/unit/balance-computation.test.ts`) — ~15 tests

**Source:** Doc 08a, Section 3

```typescript
import { computeBalance, AccountType } from "../../src/ledger/balance";
```

This is the pure-function version of what `ledgerService.getBalance()` does
with real data. Same math, no database.

- [ ] **Asset** (debit-normal): single debit increases, single credit decreases, mixed nets correctly, equal nets to zero
- [ ] **Liability** (credit-normal): single credit increases, single debit decreases, mixed nets correctly
- [ ] **Revenue** (credit-normal): same behavior as liability
- [ ] **Expense** (debit-normal): same behavior as asset
- [ ] **Equity** (credit-normal): credit increases, debit decreases
- [ ] Empty entries returns 0n for all account types
- [ ] Large values: 10,000 entries compute without overflow

### 1d. Validation Schemas (`tests/unit/validation.test.ts`) — ~30 tests

**Source:** Doc 08a, Section 4

Validation is the first line of defense. If bad data reaches the service layer,
it's already too late — the error might be a database constraint violation
instead of a clean `400 Bad Request`. These schemas catch everything before it
gets near the ledger.

- [ ] `AuthorizeSchema` accepts: valid amount + currency, optional description/metadata
- [ ] `CaptureSchema` accepts: optional amount (omitted = full capture)
- [ ] `RefundSchema` accepts: optional amount + optional reason (omitted = full refund)
- [ ] `VoidSchema` accepts: empty body
- [ ] Rejects zero and negative amounts
- [ ] Rejects floating-point amounts (no `100.5` — cents only)
- [ ] Rejects non-ISO-4217 currency codes
- [ ] Rejects SQL injection in string fields
- [ ] Rejects `__proto__` and `constructor` pollution attempts
- [ ] Rejects Cyrillic confusable characters (визually identical to Latin but different bytes)
- [ ] Mass assignment protection: strips `status`, `id`, `refunded_amount` from input

Mass assignment is the classic vulnerability. A client sends
`{ amount: 10000, status: "captured" }` and skips the authorization step.
Zod strips unknown fields — the `status` field never reaches the service.

### 1e. ID Generation (`tests/unit/id-generation.test.ts`) — ~10 tests

**Source:** Doc 08a, Section 5

- [ ] `generateId("pay")` matches `/^pay_/`
- [ ] `generateId("txn")` matches `/^txn_/`
- [ ] `generateId("ent")` matches `/^ent_/`
- [ ] IDs are time-sortable (generated in sequence, sort order matches)
- [ ] 1000 generated IDs are all unique
- [ ] ID suffix is Crockford Base32 charset

Prefixed IDs make debugging possible. When you see `pay_01HX...` in a log,
you know it's a payment. When you see `ent_01HX...`, you know it's a ledger
entry. No guessing, no `SELECT * FROM everything WHERE id = ?`.

---

## 2. The Service — Seven Functions, One Database Parameter

**File:** `src/payments/service.ts`

Every function takes `db` as its first parameter. No classes, no `this`, no
dependency injection. You can read the function signature and know every
dependency.

```typescript
export async function authorize(db, params, idempotencyKey): Promise<PaymentResponse>
export async function capture(db, paymentId, params?): Promise<PaymentResponse>
export async function voidPayment(db, paymentId): Promise<PaymentResponse>
export async function refund(db, paymentId, params?): Promise<PaymentResponse>
export async function settle(db, paymentId): Promise<PaymentResponse>
export async function getPayment(db, paymentId): Promise<PaymentResponse>
export async function listPayments(db, options?): Promise<PaginatedResponse>
```

Every mutation function follows the same pattern:
1. Look up the payment (`SELECT ... FOR UPDATE` — lock the row)
2. Check expiration (authorize-derived operations only)
3. Validate the state transition (`validateTransition(current, target)`)
4. Validate the amounts (capture ≤ authorized, refund ≤ captured)
5. Post the ledger entries (`ledgerService.postTransaction()`)
6. Update the payment record
7. Return the updated payment

The `FOR UPDATE` lock in step 1 is why concurrent operations are safe. The
second request blocks on the lock, then reads the updated state from step 6.
By the time it checks the state transition, the payment has already moved.

### Supporting Files

**`src/payments/state-machine.ts`** — Pure functions. `validateTransition`,
`getValidTransitions`, `TERMINAL_STATES`, `InvalidStateTransitionError`. No
database, no side effects. Tested by ~80 unit tests.

**`src/payments/schemas.ts`** — Zod validation schemas. `AuthorizeSchema`,
`CaptureSchema`, `RefundSchema`, `VoidSchema`. Strip unknown fields. Tested
by ~30 unit tests.

**`src/payments/types.ts`** — TypeScript interfaces. `PaymentStatus`,
`PaymentResponse`, `AuthorizeParams`, `CaptureParams`, `RefundParams`,
`PaginatedResponse`, `ListPaymentsOptions`.

**`src/shared/idempotency.ts`** — `checkIdempotency`, `storeIdempotencyResult`.
Manages the `idempotency_keys` table.

---

## 3. Authorize — Creating the Hold (~10 tests)

**File:** `tests/integration/payments/authorize.test.ts`
**Source:** Doc 08b, Section 2a

Authorization is the first financial operation. It creates a payment record and
moves money into a hold — the customer's funds are earmarked but not yet
charged. The ledger entry pattern is the simplest: two entries, one transaction.

- [ ] Creates payment with `status: "authorized"`, amounts correct (authorized=amount, captured=0, refunded=0)
- [ ] Creates correct ledger entries: DEBIT customer_holds / CREDIT customer_funds (2 entries)
- [ ] Sets `expires_at` ~7 days in the future (within 30s tolerance)
- [ ] Preserves `metadata` on the payment record
- [ ] Accepts minimum amount of 1 cent
- [ ] Accepts large amount (99999999n — $999,999.99)
- [ ] Increases `customer_holds` balance by authorized amount
- [ ] Multiple authorizations accumulate in `customer_holds`
- [ ] Preserves `currency` and `description` on payment record

**Ledger entry pattern:**
```
DEBIT   customer_holds   [amount]     ← money is held
CREDIT  customer_funds   [amount]     ← customer's funds reserved
```
2 entries, 1 transaction. The simplest pattern. Every subsequent operation
builds on this foundation.

---

## 4. Capture — Charging the Customer (~14 tests)

**File:** `tests/integration/payments/capture.test.ts`
**Source:** Doc 08b, Section 2b

Capture is the most complex operation in the system. It does three things in
one atomic transaction: releases the hold, charges the customer, and splits
the fee. The entry count varies (4 or 6) depending on whether the fee rounds
to zero.

- [ ] Transitions to `captured`, clears `expiresAt` (no more expiration — money is charged)
- [ ] Omitted amount captures entire authorized amount
- [ ] Partial capture records specified amount
- [ ] Releases **entire** hold after partial capture — `customer_holds` = 0
- [ ] Creates balanced ledger entries
- [ ] Captures exact authorized amount
- [ ] Captures 1 cent minimum
- [ ] Fee split: 3% to `platform_fees`, remainder to `merchant_payable` (6 entries)
- [ ] Zero-fee edge case: amount ≤ 33 cents skips fee entries (4 entries)
- [ ] Rejects capture exceeding authorized amount
- [ ] Rejects capture of zero amount
- [ ] Rejects capturing a voided payment (with error context)
- [ ] Rejects capturing an already captured payment
- [ ] Rejects capturing a non-existent payment

**Normal capture (6 entries):**
```
DEBIT   customer_funds    [auth_amount]      ← release hold
CREDIT  customer_holds    [auth_amount]

DEBIT   customer_funds    [capture_amount]   ← charge customer
CREDIT  merchant_payable  [capture - fee]    ← merchant's share
CREDIT  platform_fees     [fee]              ← our cut
```

**Zero-fee capture, amount ≤ 33 cents (4 entries):**
```
DEBIT   customer_funds    [auth_amount]      ← release hold
CREDIT  customer_holds    [auth_amount]

DEBIT   customer_funds    [capture_amount]   ← charge customer
CREDIT  merchant_payable  [capture_amount]   ← entire amount to merchant
```

**The fee math:**
```
fee = (captured_amount * 3n) / 100n     // BigInt truncates, no rounding
merchant_share = captured_amount - fee   // merchant gets the rest — exact
```

At 33 cents: `33 * 3 / 100 = 0` (integer division). The fee is zero. We can't
post a zero-amount entry — the CHECK constraint `amount > 0` on `ledger_entries`
would reject it. So we skip the fee entries entirely. This is why capture has
4 entries for small amounts and 6 for normal amounts.

**The hold release gotcha:** Capture always releases the ENTIRE authorized hold,
even for partial captures. If you authorize $100 and capture $70, the $100 hold
is fully released. The customer isn't stuck with a $30 phantom hold. This
matches how real payment processors work — the auth hold is an all-or-nothing
reservation.

---

## 5. Void — Cancelling the Hold (~8 tests)

**File:** `tests/integration/payments/void.test.ts`
**Source:** Doc 08b, Section 2c

Voiding cancels an authorization and releases held funds. It is terminal —
the payment is dead. No captures, no refunds, no resurrections.

- [ ] Transitions to `voided` status
- [ ] Creates reversing ledger entries (2 entries — exact mirror of authorize)
- [ ] Net effect on `customer_holds` is zero (hold created by auth, released by void)
- [ ] Rejects voiding a captured payment (too late — money already moved)
- [ ] Rejects voiding an already voided payment (can't kill it twice)
- [ ] Voided is terminal — capture fails
- [ ] Voided is terminal — refund fails
- [ ] Clears `expiresAt` (nothing to expire)

**Ledger entry pattern:**
```
DEBIT   customer_funds   [amount]     ← reverse the authorization
CREDIT  customer_holds   [amount]     ← release the hold
```
2 entries, 1 transaction. The exact mirror of authorize. Auth moves money
right; void moves it back. Net result: zero. As if the authorization never
happened — but with a complete audit trail showing that it did.

---

## 6. Refund — Returning the Money (~14 tests)

**File:** `tests/integration/payments/refund.test.ts`
**Source:** Doc 08b, Section 2d

Refunds are the only operation that can be partial AND repeated. A $100 capture
can be refunded $30, then $20, then $50. Each refund creates its own ledger
entries. The state machine tracks whether the payment is `partially_refunded`
or fully `refunded`.

- [ ] Full refund transitions to `refunded` (terminal)
- [ ] Omitted amount refunds entire captured amount
- [ ] Partial refund transitions to `partially_refunded` (not terminal — more refunds allowed)
- [ ] Multiple partial refunds accumulate, final one transitions to `refunded`
- [ ] Refund after partial capture is limited to captured amount, not authorized
- [ ] Refunding exactly the remaining amount transitions to `refunded`
- [ ] Refunding 1 cent succeeds
- [ ] Rejects refund exceeding remaining refundable amount
- [ ] Rejects refund of zero amount
- [ ] Rejects further refunds after full refund (terminal state)
- [ ] Rejects refunding an authorized (not captured) payment — there's nothing to refund
- [ ] Rejects refunding a voided payment
- [ ] Full lifecycle (auth → capture → refund) nets all accounts to zero
- [ ] Refund with reason preserves the reason

That last-but-one test is the full circle test. After auth → capture → refund,
every account in the system is back to zero. `customer_funds`, `customer_holds`,
`merchant_payable`, `platform_fees` — all zero. Money came in, money went out,
nothing was created, nothing was destroyed. The ledger proves it.

**Status transitions:**
- `captured` / `settled` / `partially_refunded` → `partially_refunded` (partial refund)
- `captured` / `settled` / `partially_refunded` → `refunded` (full or final refund)

Refunds work from BOTH `captured` and `settled` status. A merchant who has
already been paid out can still have their payment refunded. This is how the
real world works — chargebacks happen after settlement.

---

## 7. Expiration — Time Kills the Hold (~5 tests)

**File:** `tests/integration/payments/expiration.test.ts`
**Source:** Doc 08b, Section 2e

Authorization holds don't last forever. After 7 days (configurable via
`AUTH_EXPIRY_DAYS`), the hold expires. The customer's money is released.
No capture, no void — time itself ended the authorization.

- [ ] Authorization sets `expires_at` on the payment
- [ ] Expired payment cannot be captured (on-access check triggers expiration)
- [ ] Expired payment cannot be voided (already expired)
- [ ] Capture before expiry succeeds (time hasn't run out yet)
- [ ] Expiration releases hold from `customer_holds`

**On-access expiration:** There is no background job checking for expired
payments. Instead, when capture or void is attempted, the service checks
`expires_at < NOW()`. If expired, it transitions the payment to `expired` and
releases the hold. Lazy evaluation — the expiration happens when someone tries
to use the authorization, not on a timer.

The tests use `UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour'`
to simulate time passing. This is one of the few cases where raw SQL modifies
payment state directly — testing time without mocking clocks.

**Ledger entry pattern (same as void):**
```
DEBIT   customer_funds   [amount]
CREDIT  customer_holds   [amount]
```

---

## 8. Settlement — Paying the Merchant (~10 tests)

**File:** `tests/integration/payments/settle.test.ts`
**Source:** Doc 08b, Section 2f

Settlement records that the merchant has been paid. It moves the merchant's
share from `merchant_payable` (a liability — we owe them) to `platform_cash`
(an asset — money going out our door).

- [ ] Transitions to `settled` status
- [ ] Creates correct ledger entries: DEBIT merchant_payable / CREDIT platform_cash (2 entries)
- [ ] Settlement amount = `captured_amount - fee` (merchant_share), **NOT** captured_amount
- [ ] Zeroes out `merchant_payable` for the payment
- [ ] Records outflow in `platform_cash` (negative asset balance — money left)
- [ ] Rejects settling an authorized (not captured) payment
- [ ] Rejects settling an already settled payment
- [ ] Rejects settling a voided payment
- [ ] Rejects settling a non-existent payment
- [ ] Refund after settlement is allowed and transitions correctly

**Ledger entry pattern:**
```
DEBIT   merchant_payable  [merchant_share]   ← discharge the liability (we paid them)
CREDIT  platform_cash     [merchant_share]   ← record the outflow (money left our account)
```
2 entries, 1 transaction.

**The settlement amount gotcha:** Settlement moves `merchant_share`, not
`captured_amount`. If the customer paid $100 and the fee was $3, settlement
moves $97 — the merchant's share after our cut. This is the most common
mistake when implementing settlement. The test for it is explicit:
`fee = (10000n * 3n) / 100n; merchantShare = 10000n - fee;` and the ledger
entry amount is verified against `merchantShare`.

**The platform_cash sign:** After settlement, `platform_cash` has a NEGATIVE
balance. That's correct. `platform_cash` is an asset account (debit-normal).
A CREDIT decreases it. The negative balance represents money that has left
the platform — an outflow. If this seems wrong, re-read doc 18
(accounting model). It's exactly how Stripe and every other processor model
merchant disbursements.

---

## 9. Payment Queries (~10 tests)

**File:** `tests/integration/payments/queries.test.ts`
**Source:** Doc 08b, Section 3

The read path. No mutations, no ledger entries, no god check needed. But the
queries must reflect the truth — every mutation that happened must be visible
in the query results.

### Single Retrieval
- [ ] Retrieves payment by ID with all fields
- [ ] Returns error for non-existent ID (`PaymentNotFoundError`, not a null)
- [ ] Reflects current state after operations (authorize → capture → query shows `captured`)
- [ ] All amount fields present after full lifecycle

### List & Pagination

Cursor pagination, not offset. Offset pagination is O(n) — page 1000 scans
999 pages of results and throws them away. Cursor pagination is O(1) — start
after the cursor, return the next N.

- [ ] Returns default limit of results (≤ 20)
- [ ] Respects custom limit
- [ ] Cursor pagination with `hasMore` and `nextCursor`
- [ ] Subsequent page starts after cursor (no overlap — page 2 IDs ∩ page 1 IDs = ∅)
- [ ] Filters by status
- [ ] Returns results in reverse chronological order (newest first — ULIDs sort naturally)

---

## 10. Idempotency — Same Request, Same Result (~20 tests)

**File:** `tests/integration/payments/idempotency.test.ts`
**Source:** Doc 08b, Section 4

Network failures happen. Clients retry. The idempotency system ensures that
retrying a request produces the exact same result without creating duplicate
payments or duplicate ledger entries. Every assertion is definitive — no
"should either... or..." hedging.

### Cache Hit Behavior

When the same `Idempotency-Key` arrives with the same parameters, return the
cached response. Don't process the request again. Don't create new entries.

- [ ] Same key + same params returns identical response
- [ ] Third retry still returns identical response
- [ ] All fields match between original and cached response
- [ ] Cached response creates no new ledger entries (entry count unchanged)
- [ ] Payment count does not increase on retry

### Conflict Detection

When the same key arrives with DIFFERENT parameters, that's a conflict. The
client is trying to reuse a key for a different operation. This is always a
bug — reject it with 409.

- [ ] Same key + different amount → 409 conflict
- [ ] Same key + different currency → 409 conflict
- [ ] Conflict error body includes type `idempotency_conflict`
- [ ] Conflict error includes the original idempotency key (for debugging)

### Ledger Deduplication

The most important idempotency tests. Not "does the response match?" but
"does the ledger have exactly one transaction, even after 3 retries?"

- [ ] Exactly one transaction despite 3 retries
- [ ] Concurrent same-key requests create exactly one payment
- [ ] Entry count stable across retries
- [ ] Transaction count stable across retries

That second test is the hard one. Three `Promise.allSettled` requests with
the same key, arriving simultaneously. All three get the same payment ID.
The ledger has exactly one authorization transaction. No duplicates. No races.

### Cross-Operation Idempotency
- [ ] Capture retry returns same captured payment
- [ ] Refund retry does not double-refund (refundedAmount unchanged)
- [ ] Void retry rejects (already voided — terminal state, not idempotency)
- [ ] Different idempotency keys create separate resources

### Key Semantics
- [ ] Different keys with identical params create separate payments (key is the identity, not params)
- [ ] Key reuse across different operations is independent
- [ ] Concurrent identical requests all resolve to same payment ID (5 simultaneous, 1 ID)

---

## 11. Concurrency — The Race Conditions (~16 tests)

**Files:** `tests/integration/concurrency/*.test.ts`
**Source:** Doc 08b, Section 5

This is where the `SELECT ... FOR UPDATE` lock proves its worth. Every test
uses `Promise.allSettled` to fire multiple operations simultaneously. The god
check runs after every race. If the lock doesn't work, money gets created or
destroyed — the god check catches it.

### Double Capture

Two clients capture the same authorized payment at the same millisecond.

- [ ] 2 simultaneous captures — exactly 1 succeeds, god check passes
- [ ] 5 simultaneous captures — exactly 1 succeeds, god check passes
- [ ] Payment state after race is `captured` with correct amount

Without `FOR UPDATE`, both reads would see `status: "authorized"`, both would
post ledger entries, and the customer would be charged twice. The lock
serializes access — the second request blocks, then sees `status: "captured"`,
then fails with `InvalidStateTransitionError`. Exactly one succeeds. Always.

### Double Settlement

- [ ] 2 simultaneous settlements — exactly 1 succeeds, god check passes

Same pattern as double capture. Without the lock, the merchant gets paid twice.

### Capture vs Void Race

Two different operations on the same payment. One wants to charge, the other
wants to cancel. Only one can win.

- [ ] Exactly one succeeds when capture and void race
- [ ] Payment ends in a valid terminal state (`captured` OR `voided` — both are acceptable)
- [ ] Ledger balanced after race

The system doesn't guarantee WHICH operation wins. It guarantees that exactly
one wins, the result is consistent, and the ledger balances. The winner depends
on who acquires the lock first — and that's fine. Both outcomes are valid.

### Refund Races

Refunds are the trickiest race because partial refunds can accumulate. Two
$70 refunds on a $100 capture — at most one can succeed, because the total
would exceed the captured amount.

- [ ] Concurrent full refunds — only one succeeds
- [ ] Concurrent partial refunds cannot exceed captured amount
- [ ] 10 concurrent $20 refunds on a $100 capture — at most 5 succeed, god check passes
- [ ] God check passes after refund race

### Parallel Independent Payments

Different payments don't contend. The `FOR UPDATE` lock is per-payment-row,
not a global lock. 20 concurrent authorizations for 20 different payments
should all succeed.

- [ ] 20 concurrent authorizations all succeed
- [ ] All concurrent payments have unique IDs

### Mixed Chaos

The stress test. Multiple payments, multiple operation types, all concurrent.

- [ ] Mixed operations across multiple payments, god check passes
- [ ] Duplicate operations fail gracefully (no crash, no corruption), god check passes
- [ ] God check after chaos across 10 payments (capture even-indexed, void odd-indexed)

---

## 12. Invariants — The Final Proof (~20 tests)

**Source:** Doc 08b, Section 6

The invariant tests are the capstone. They don't test individual operations —
they test the mathematical properties that must be true after ANY sequence of
operations. If the god check passes after auth + capture + settle + refund
across 10 concurrent payments, the system is provably correct.

### God Check (`tests/integration/invariants/god-check.test.ts`)

`SUM(debits) === SUM(credits)` across the entire system. After everything.

- [ ] Empty system balances to zero
- [ ] After single authorization
- [ ] After authorization + full capture
- [ ] After authorization + void
- [ ] After authorization + capture + full refund
- [ ] After authorization + capture + settlement
- [ ] After authorization + capture + settlement + full refund
- [ ] After authorization + partial capture + partial refund
- [ ] After 5 mixed payments in different flows
- [ ] After concurrent mixed operations across 10 payments
- [ ] Every individual transaction is balanced (per-transaction, not just system-wide)

### Account Integrity (`tests/integration/invariants/account-integrity.test.ts`)

Every account's service balance matches raw SQL. No drift, no stale cache,
no off-by-one.

- [ ] Every account service balance matches raw SQL computation (all 5 accounts checked)
- [ ] No orphaned entries (every entry references a valid transaction AND a valid account)
- [ ] Balance is deterministic (query twice → same result)

### Database Constraints (`tests/integration/invariants/constraint-tests.test.ts`)

The database itself rejects invalid data, independent of the service layer.
These tests bypass the service and write directly to the database to prove
the constraints work.

- [ ] Rejects `captured_amount > authorized_amount` — DB CHECK constraint fires
- [ ] Rejects `refunded_amount > captured_amount` — DB CHECK constraint fires
- [ ] Rejects zero amount in ledger entry — `positive_amount` CHECK fires
- [ ] Rejects negative amount in ledger entry — same CHECK
- [ ] Rejects invalid payment status — `valid_status` CHECK fires

Belt (service validation), suspenders (state machine), AND a third thing
(database constraints). Three independent layers that all enforce the same
rules. Any one of them failing is a bug. All three failing simultaneously is
practically impossible.

---

## 13. Test Factories — Real Operations, No Mocks

**File:** `tests/helpers/factories.ts`

Phase 1 created stubs that throw `"Not implemented until Phase 3"`. Phase 3
makes them real. Every factory calls the actual service functions against real
Postgres. `createCapturedPayment` doesn't INSERT a row with
`status: "captured"` — it calls `authorize()` then `capture()`. The payment
goes through the full lifecycle. The ledger entries exist. The balances are
real.

- [ ] `createAuthorizedPayment(db, overrides?)` — calls `paymentService.authorize()` with defaults + overrides
- [ ] `createCapturedPayment(db, overrides?)` — authorize then capture
- [ ] `createVoidedPayment(db, overrides?)` — authorize then void
- [ ] `createSettledPayment(db, overrides?)` — authorize, capture, settle
- [ ] `uniqueKey()` — generates unique idempotency key
- [ ] All accept optional overrides: `{ amount?, currency?, description?, metadata?, authorizeAmount? }`

Why no mock factories: A mock `createCapturedPayment` that INSERTs a row
directly would skip the ledger entries. The payment would show
`status: "captured"` but `customer_holds` would still have money in it. The
god check would fail. By using real service calls, the factories guarantee
that every test starts with a financially consistent state.

---

## 14. File Structure

```
src/payments/
├── schema.ts           # Already exists (Phase 1)
├── service.ts          # authorize, capture, void, refund, settle, getPayment, listPayments
├── state-machine.ts    # validateTransition, getValidTransitions, TERMINAL_STATES
├── schemas.ts          # Zod validation schemas
└── types.ts            # PaymentStatus, PaymentResponse, etc.

src/ledger/
├── balance.ts          # computeBalance (pure function for unit tests)
└── ...                 # Existing from Phase 2

src/shared/
├── idempotency.ts      # checkIdempotency, storeIdempotencyResult
├── errors.ts           # Updated: all error types populated
└── ...                 # Existing from Phase 1

tests/unit/
├── state-machine.test.ts        # ~80 tests
├── money.test.ts                # ~30 tests
├── balance-computation.test.ts  # ~15 tests
├── validation.test.ts           # ~30 tests
└── id-generation.test.ts        # ~10 tests

tests/integration/payments/
├── authorize.test.ts            # ~10 tests
├── capture.test.ts              # ~14 tests
├── void.test.ts                 # ~8 tests
├── refund.test.ts               # ~14 tests
├── expiration.test.ts           # ~5 tests
├── settle.test.ts               # ~10 tests
├── queries.test.ts              # ~10 tests
└── idempotency.test.ts          # ~20 tests

tests/integration/concurrency/
└── races.test.ts                # ~16 tests

tests/integration/invariants/
├── god-check.test.ts            # ~11 tests
├── account-integrity.test.ts    # ~3 tests
└── constraint-tests.test.ts     # ~5 tests

tests/helpers/
├── factories.ts                 # Updated: real implementations (no mocks)
└── ...                          # Existing from Phase 1
```

---

## 15. Import Architecture

```
payments/service.ts
  ├── payments/state-machine.ts      (pure functions — no DB)
  ├── payments/schemas.ts            (Zod validation — no DB)
  ├── ledger/service.ts              (postTransaction, getBalance — the only way to move money)
  ├── shared/db.ts                   (Database type)
  ├── shared/id.ts                   (generateId)
  ├── shared/errors.ts               (error classes)
  ├── shared/money.ts                (splitAmount, calculateFee)
  └── shared/idempotency.ts          (checkIdempotency, storeResult)
```

The arrow points one direction: `payments/` imports from `ledger/` and
`shared/`. Never the reverse. The ledger has no idea payments exist. `shared/`
has no idea either of them exist. If `ledger/service.ts` ever imports from
`payments/`, the architecture is broken — the foundation depends on the thing
built on top of it.

---

## 16. Error Types

Every error extends `AppError` with `type`, `message`, `statusCode`, `details`.
The error type is a machine-readable string. The message is a human-readable
diagnostic. The details carry structured data for debugging.

| Error | HTTP | Type | When |
|---|---|---|---|
| `ValidationError` | 400 | `validation_error` | Failed Zod schema validation |
| `PaymentNotFoundError` | 404 | `not_found` | `getPayment` for non-existent ID |
| `InvalidStateTransitionError` | 409 | `invalid_state_transition` | `capture` on a voided payment |
| `IdempotencyConflictError` | 409 | `idempotency_conflict` | Same key, different params |
| `InvalidAmountError` | 422 | `invalid_amount` | Capture exceeds authorized amount |
| `InsufficientFundsError` | 422 | `insufficient_funds` | Refund exceeds refundable amount |
| `LedgerImbalanceError` | 500 | `ledger_imbalance` | Should never happen. If it does, wake someone up. |

Response format: `{ error: { type, message, details? } }`. The `type` field is
the same string used in the error class. Clients match on `type`, not on HTTP
status codes or message strings.

---

## 17. Commit Strategy

One concern per commit. Either add tests or make tests pass. Never both. The
git log reads like a narrative — each commit tells you exactly what changed
and why.

```
feat(payments): add state machine unit tests (~80 tests)
feat(payments): implement state machine (validateTransition)
feat(payments): add validation schema unit tests (~30 tests)
feat(payments): implement Zod validation schemas
feat(payments): add authorize integration tests (~10 tests)
feat(payments): implement authorize with ledger entries
feat(payments): add capture integration tests (~14 tests)
feat(payments): implement capture with fee split
feat(payments): add void integration tests (~8 tests)
feat(payments): implement void with hold release
feat(payments): add refund integration tests (~14 tests)
feat(payments): implement refund with partial support
feat(payments): add expiration integration tests (~5 tests)
feat(payments): implement on-access expiration
feat(payments): add settlement integration tests (~10 tests)
feat(payments): implement settle with merchant disbursement
feat(payments): add query tests (~10 tests)
feat(payments): implement getPayment and listPayments
feat(payments): add idempotency tests (~20 tests)
feat(payments): implement idempotency key management
feat(payments): add concurrency tests (~16 tests)
feat(payments): add SELECT FOR UPDATE to all mutations
feat(payments): add invariant tests (~20 tests)
```

Any regression is traceable to a single commit. `git bisect` finds it in
log₂(22) ≈ 5 steps.

---

## 18. Final Gate Checklist

- [ ] All ~165 unit tests green (`bun run test:unit` in < 1s)
- [ ] All ~135 integration tests green (`bun run test:integration` in < 5s)
- [ ] God check passes after every operation type
- [ ] Concurrent operations don't corrupt state (all race tests pass)
- [ ] Idempotency working (same key = same result, zero duplicate entries)
- [ ] All errors have correct type, message, status code, details
- [ ] No circular imports (payments → ledger → shared, never backwards)
- [ ] Payment service is standalone module (no payment awareness in `ledger/`)
- [ ] Test factories are real implementations (no mocks, no stubs, no direct INSERTs)
- [ ] `bun run lint` passes (Biome)
- [ ] `bun test --bail` exits 0

When this gate passes, the payment engine processes money correctly. Every
authorization holds funds. Every capture charges the right amount with the
right fee split. Every void releases the hold. Every refund returns money
without exceeding the captured amount. Every settlement pays the merchant
their share. Every concurrent race resolves cleanly. And through all of it —
every race, every edge case, every partial refund, every zero-fee capture —
`SUM(debits) === SUM(credits)`.

---

Previous: [Phase 2 — Ledger Layer](./phase-2-ledger.md) | Next: [Phase 4 — API Layer](./phase-4-api.md)
