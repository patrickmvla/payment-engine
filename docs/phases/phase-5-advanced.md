# Phase 5: Advanced Testing — Proving It Can't Break

The engine works. Phase 2 proved the ledger is correct. Phase 3 proved money
moves safely. Phase 4 proved the API delivers it over the wire. Every happy
path, every error path, every concurrent race — tested and green.

So why isn't it done?

Because "it works for every case I thought of" is not the same as "it works."
The test suite up to Phase 4 proves the system handles known inputs correctly.
Phase 5 proves the system handles *unknown* inputs correctly. Random sequences
of operations. Garbage payloads. Connection failures mid-transaction. An
independent witness that reconstructs the entire financial state from the
ledger alone, without ever looking at the payments table. If the witness
disagrees with reality, reality is wrong.

This is the difference between a payment engine that passes tests and a payment
engine you'd trust with other people's money. The former handles the cases you
wrote. The latter handles the cases you didn't.

~90 tests. Property-based tests generate random operation sequences and prove
invariants hold after any sequence — not just the ones a human thought to write.
Failure injection tests prove that mid-transaction crashes leave zero partial
state. Reconciliation tests prove the audit trail is complete. The witness test
proves the ledger is the single source of truth. Fuzz tests throw 500 random
payloads at every endpoint and prove the server never crashes. Migration tests
prove the schema is sound. Performance tests catch regressions before they ship.
And the meta-tests prove the test infrastructure itself is trustworthy.

**Goal:** Prove the system is correct not just for known inputs, but for
arbitrary inputs, failure conditions, and adversarial scenarios. Every invariant
holds under chaos. The ledger can reconstruct reality. The test suite is
self-verifying.

**Gate:** All ~90 advanced tests green. All ~420+ total tests green in a single
`bun test --bail` run. The system is proven correct for known inputs, random
inputs, concurrent inputs, failure conditions, and adversarial inputs. The
witness test passes — the ledger tells the complete story.

---

## Why Advanced Tests Exist

The first four phases test the system the way you'd use it. Authorize, capture,
refund — in the order a merchant would call them. With valid inputs. Over
working connections. One request at a time (mostly).

Real production is none of those things.

Real production is a client that retries 5 times because the network dropped.
It's a deployment that runs migrations twice because the CI job restarted. It's
a fuzz payload that sends `{"amount": NaN, "__proto__": {"isAdmin": true}}` and
expects a structured error, not a stack trace. It's 50 random operation
sequences that exercise state machine paths no human would think to write —
authorize, capture, partial refund, capture another payment, void the first one
wait no it's already refunded, settle the second one.

Property-based testing is the closest thing software has to a mathematical
proof. Instead of writing specific test cases, you define the invariant ("debits
must equal credits") and let the machine generate a thousand operation sequences
to try to break it. If it can't break it after 50 seeds of 20 operations each
plus one extended run of 1,000 operations, you have evidence — not proof, but
strong evidence — that the invariant holds universally.

The witness test is the capstone. An independent function that has never seen the
payments table reads only ledger entries and reconstructs the financial state of
every payment. `authorizedAmount`, `capturedAmount`, `refundedAmount`,
`holdAmount` — all derived from entry patterns alone. If the witness's numbers
match the payment record, the ledger is provably the source of truth. If they
don't, something is lying, and the ledger — being immutable — isn't the one
doing it.

---

## Pre-flight

- [ ] Phase 4 gate passed — all ~19 E2E tests green, all ~7 load tests pass
- [ ] God check passes after load testing (system balanced under pressure)
- [ ] All ~330 tests green (`bun test --bail` exits 0)
- [ ] `/docs` renders, `/openapi.json` returns valid spec
- [ ] Payment service handles all 6 operations (authorize, capture, void, refund, settle, expire)
- [ ] Idempotency working across all mutation endpoints
- [ ] Concurrency safe — `SELECT ... FOR UPDATE` on every mutation
- [ ] Docker Postgres running, both main and test DBs migrated and seeded
- [ ] `bun run lint` passes

---

## TDD Sequence

Eight steps. Unlike Phases 2-4 where tests drive implementation, Phase 5
tests should mostly PASS immediately — they verify properties of a system
that already works. If a property-based test fails at seed 42, that's a bug
in the implementation, not a missing feature. Fix it in the service layer,
not in the test.

```
Step 1:  Write property-based tests (random operation sequences)    → PASS (or find bugs)
Step 2:  Write failure injection tests (connection drops, rollback) → PASS (ACID works)
Step 3:  Write reconciliation tests (end-of-day audit trail)        → PASS (ledger is complete)
Step 4:  Write the witness test (reconstruct from ledger alone)     → PASS (ledger is truth)
Step 5:  Write fuzz tests (500 random payloads, proto pollution)    → PASS (validation holds)
Step 6:  Write migration safety tests (fresh apply, idempotent)     → PASS (schema is sound)
Step 7:  Write performance boundary tests (regression guards)       → PASS (baselines set)
Step 8:  Write test isolation meta-tests (no state leakage)         → PASS (infrastructure works)
```

Notice the difference from earlier phases: no alternating RED/GREEN. Phase 5
tests are *discovery tests*. They explore the system's behavior under conditions
you didn't explicitly design for. If they find a bug, you go back to the
relevant phase and fix it — the advanced test is the proof that the fix works.

The god check runs in `afterEach` of every test file that touches the database.
Always.

---

## 1. Property-Based Testing — Random Sequences (~52 tests)

**File:** `tests/property/random-sequences.test.ts`
**Source:** Doc 08d, Section 1

Instead of hand-writing "authorize then capture then refund," we generate
RANDOM sequences of payment operations and prove that invariants hold after
ANY sequence. This is the closest thing to a mathematical proof that the system
is correct.

### How It Works

1. Seed a pseudo-random number generator (deterministic — failures are
   reproducible)
2. Generate a random sequence of operations: authorize, capture, void, refund,
   settle
3. Execute them against real Postgres
4. After every sequence: run the god check
5. Run 50 seeds x 20 operations + one extended run of 1,000 operations

### The SeededRNG

```typescript
class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    // mulberry32 — deterministic, fast, well-distributed
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T {
    return arr[this.nextInt(0, arr.length - 1)];
  }
}
```

Why seeds? If a test fails at seed 42, you reproduce it deterministically.
`it.only(\`seed 42\`)` and debug that exact sequence step by step. "Seed 42
failed" is a bug report, not a fluke. No flaky tests. No "works on my machine."

### The Operation Tracker

```typescript
type TrackedPayment = {
  id: string;
  status: string;
  amount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
};
```

The tracker mirrors the payment state in memory as operations execute. It
determines which operations are legal next — can't capture a voided payment,
can't refund more than captured, can't settle something that isn't captured.
Failed operations are expected and logged — a void on an already-voided payment
throws `InvalidStateTransitionError`, and that's correct behavior.

### The Sequence Executor

```typescript
async function executeRandomSequence(
  db: Database,
  seed: number,
  operationCount: number
): Promise<{ seed: number; operations: string[]; payments: TrackedPayment[] }>
```

For each iteration:
1. Pick a random operation from what's currently valid
2. Pick a random target payment (if the operation needs one)
3. Generate random amounts within valid ranges
4. Execute and track the result
5. If it fails, log `"(failed - expected)"` and continue

The key insight: some operations WILL fail. A random sequence might try to
capture a payment that was already voided two operations ago. That's fine.
The test verifies that failures don't corrupt the ledger — not that every
operation succeeds.

### The Tests

- [ ] **50 seeds x 20 operations each** — Each seed generates a different
  sequence. After each sequence: `verifySystemBalance(db)` and
  `verifyAllTransactionsBalance(db)`. 50 passing seeds means 50 different
  operation orderings all left the ledger balanced.
- [ ] **Seed 999: 1,000 operations** — The extended run. 1,000 random
  operations against the same database state. Authorizations pile up, captures
  interleave with voids, partial refunds accumulate. After all 1,000: god check
  passes. Timeout: 30s. This one test exercises more state machine paths than
  the entire Phase 3 suite combined.

50 + 1 + 1 (the `describe` overhead) = ~52 tests.

The 1,000-operation run is the stress test that catches edge cases no human
would write. Seed 999 might generate: authorize $847, authorize $12, capture
$847, partial refund $200, authorize $5000, void the $12, settle the $847,
refund $647 from the settled payment, capture $5000... After all of it:
`SUM(debits) === SUM(credits)`.

---

## 2. Failure Injection — When Things Go Wrong (~5 tests)

**Files:** `tests/failure/connection-drop.test.ts`, `tests/failure/slow-query.test.ts`
**Source:** Doc 08d, Section 2

What happens when a transaction fails mid-execution? The database says it
rolled back. But did it? These tests inject failures at various points in
the transaction lifecycle and verify that no money was created or destroyed.

### 2a. Connection Drop During Transaction

**File:** `tests/failure/connection-drop.test.ts`

- [ ] **Transaction rollback on connection failure leaves no partial state** —
  Start a manual `db.transaction()`, insert a ledger transaction with one entry
  (the debit), then throw before inserting the matching credit. After the
  failure: entry count unchanged, no orphaned transaction row. The
  `db.transaction()` rollback is the last line of defense — this test proves
  it holds.

- [ ] **Failed authorization creates no payment record** — Call
  `paymentService.authorize()` with input that triggers a failure (e.g.,
  invalid currency that passes Zod but fails downstream). After the failure:
  payment count unchanged, system balance intact. A half-created payment with
  no ledger entries would be an orphan — the database transaction prevents it.

- [ ] **Partial failure in multi-step operation rolls back completely** —
  Create an authorized payment. Start a manual transaction that updates the
  payment status to `captured` but throws before writing ledger entries. After
  the failure: payment is still `authorized` (status update rolled back), entry
  count unchanged. The payment and the ledger are atomically consistent — you
  can't have one without the other.

### 2b. Invariants Under Contention

**File:** `tests/failure/slow-query.test.ts`

- [ ] **Concurrent operations during slow transactions maintain invariants** —
  Create an authorized payment. Fire a capture and a void simultaneously via
  `Promise.allSettled`. Exactly one succeeds (the lock serializes them). After
  the race: `verifySystemBalance(db)` passes. The loser gets
  `InvalidStateTransitionError`, not a corrupted ledger.

### Why Not Mock the Connection?

Because a mock doesn't prove the database rollback works. A mock says "if the
rollback happened, the state would be clean." The real test says "the rollback
actually happened, and the state IS clean." In fintech, the difference between
those two statements is the difference between "we think we're not losing money"
and "we're not losing money."

---

## 3. Financial Reconciliation — End-of-Day Audit (~6 tests)

**File:** `tests/reconciliation/end-of-day.test.ts`
**Source:** Doc 08d, Section 3

In real fintech, you run end-of-day reconciliation to verify the audit trail
is complete. Every payment has ledger entries. No entries are orphaned. Every
transaction balances. Every account's balance can be reconstructed from
entries. The reconciliation test simulates a realistic trading day and verifies
all of it.

### The Trading Day

```typescript
async function simulateTradingDay(db: Database) {
  // 10 successful authorizations -> captures
  // 5 settlements (of the 10 captured)
  // 3 full refunds
  // 2 partial refunds
  // 2 authorizations voided
  // 3 pending authorizations (not yet captured)
}
```

15 payments, 25+ operations, 6+ different states. A realistic day at a small
payment processor.

### The Audit

- [ ] **Every payment has at least one ledger transaction** — Query every
  payment, count its ledger transactions via `reference_type = 'payment'` and
  `reference_id = payment.id`. Every payment — authorized, captured, voided,
  settled, refunded — has at least one transaction. Zero is impossible because
  authorization creates the first transaction atomically with the payment.

- [ ] **No orphan ledger entries** — `LEFT JOIN` entries to transactions.
  Every entry has a parent transaction. An entry without a transaction is a
  data integrity violation — it means money moved without being recorded.

- [ ] **No orphan ledger transactions** — `LEFT JOIN` transactions to entries
  with `HAVING COUNT(entries) = 0`. Every transaction has at least 2 entries
  (the minimum for a balanced transaction). A transaction without entries is
  an empty shell — it records that something happened but not what.

- [ ] **Every transaction has equal debits and credits** —
  `verifyAllTransactionsBalance(db)`. Not just system-wide balance (that's the
  god check). Per-transaction balance. Every individual transaction created
  during the trading day balances independently.

- [ ] **Account balances match sum of entries** — For every account that has
  entries, call `ledgerService.getBalance()` and verify the result is a valid
  bigint. Then run `verifySystemBalance(db)` to prove the system-wide balance
  holds.

- [ ] **Total money in equals total money out plus held plus fees** — Sum all
  CREDIT entries to `customer_funds` (money entering the system). Sum all DEBIT
  entries from `customer_funds` (money leaving via refunds, charges). The net
  must be consistent with the current `customer_funds` balance. Money is
  conserved.

---

## 4. The Witness Test — Reconstructing Truth (~5 tests)

**File:** `tests/reconciliation/witness.test.ts`
**Source:** Doc 08d, Section 6

The ultimate proof that the ledger is the source of truth. An independent
function that has NEVER seen the payments table reconstructs the financial
state of every payment using ONLY the ledger entries.

### Why This Matters

If you can rebuild the entire financial state from the ledger alone:

- The ledger is truly the source of truth
- No data corruption can hide
- A full audit is always possible
- Disaster recovery can reconstruct from the ledger
- The payments table is a cache, not the canonical data

### The Reconstruction Algorithm

```typescript
async function reconstructPaymentFromLedger(
  db: Database,
  paymentId: string
): Promise<{
  exists: boolean;
  authorizedAmount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
  holdAmount: bigint;
  transactionCount: number;
}>
```

The function reads `ledger_transactions` joined with `ledger_entries` where
`reference_type = 'payment'` and `reference_id = paymentId`. It uses the
entry patterns — which accounts are debited and credited — to deduce what
happened:

| Pattern | Meaning |
|---|---|
| `DEBIT customer_holds` | Authorization (hold placed) |
| `CREDIT customer_holds` | Hold released (capture, void, or expiry) |
| `CREDIT merchant_payable` | Funds to merchant (capture) |
| `DEBIT merchant_payable` + description contains "settle" | Settlement (disbursement) |
| `DEBIT merchant_payable` + description doesn't contain "settle" | Refund (merchant returns share) |

The witness doesn't know about state machines, status fields, or the payments
table. It reads entry patterns and reconstructs amounts. If the amounts match
the payment record, the ledger tells the complete story.

### The Tests

- [ ] **Reconstructs authorized payment state** — Authorize $100. Witness
  reports `authorizedAmount: 10000n`, `holdAmount: 10000n`, `capturedAmount: 0n`,
  `refundedAmount: 0n`. Matches `paymentService.getPayment()`.

- [ ] **Reconstructs captured payment state** — Authorize $100, capture $100.
  Witness reports `capturedAmount` matching the actual `capturedAmount`,
  `holdAmount: 0n` (hold released after capture).

- [ ] **Reconstructs partial capture + partial refund state** — Authorize $100,
  capture $70, refund $30. Witness reports `capturedAmount` and
  `refundedAmount` matching the actual payment record.

- [ ] **Reconstructs voided payment state** — Authorize $100, void. Witness
  reports `holdAmount: 0n` (hold fully released), `capturedAmount: 0n`,
  `refundedAmount: 0n`.

- [ ] **Reconstructs settled payment state** — Authorize $100, capture $100,
  settle. Witness reports `capturedAmount` matching, `holdAmount: 0n`,
  `refundedAmount: 0n`.

If any witness test fails, it means the ledger entries don't tell the complete
story. Something happened to the payment that the ledger doesn't know about —
a state change without a ledger transaction. That's a violation of the
architecture. Fix the service layer, not the witness.

---

## 5. Fuzz Testing — Adversarial Validation (~4 tests)

**File:** `tests/fuzz/validation-fuzz.test.ts`
**Source:** Doc 08d, Section 5

Throw random garbage at every endpoint and verify the system never panics,
never corrupts data, and always returns structured errors. The fuzz tests use
the same `SeededRNG` for reproducibility.

### Random Payload Generator

```typescript
function generateRandomPayload(rng: SeededRNG): unknown
```

Generates random nested objects with:
- Special strings: `""`, `"null"`, `"NaN"`, `"Infinity"`, SQL injection
  attempts, XSS payloads, path traversal, null bytes, `"__proto__"`,
  `"constructor"`, `"prototype"`, 10,000-character strings
- Special numbers: `0`, `-1`, `NaN`, `Infinity`, `-Infinity`,
  `MAX_SAFE_INTEGER`, `1e308`
- Random arrays, nulls, booleans, nested objects up to 10 keys deep

### The Tests

- [ ] **500 random payloads to authorize endpoint never crash the server** —
  500 iterations. Each sends a random payload via `app.request()`. Every
  response must have a valid HTTP status code (200-599). Every non-2xx response
  must have a structured error body (`error.type` is string, `error.message` is
  string). After all 500: `verifySystemBalance(db)` — the fuzz didn't corrupt
  the ledger.

  This test is worth more than 100 hand-written validation tests. A human
  writes `{ amount: -1 }` and calls it "negative amount test." The fuzzer
  writes `{ amount: NaN, currency: { __proto__: { isAdmin: true } }, key_7:
  [null, [Infinity]] }` and calls it iteration 347.

- [ ] **Prototype pollution attempts are rejected** — Three specific payloads
  with `__proto__` and `constructor.prototype` fields. Each must return
  status < 500 (either succeeds with proto keys stripped, or validation rejects
  it). The server must NOT crash.

- [ ] **Extremely large payloads are rejected gracefully** — A payload with
  1,000 metadata keys, each 1,000 characters. Must return 400+ status. Must
  NOT OOM or crash.

- [ ] **Non-JSON content types are rejected** — `Content-Type: text/plain`
  with a non-JSON body. Must return 400+.

---

## 6. Migration Safety — Schema Integrity (~4 tests)

**File:** `tests/migration/migration-safety.test.ts`
**Source:** Doc 08d, Section 7

Migrations are as critical as application code. A bad migration can corrupt
every record in the database. These tests prove that migrations apply cleanly,
are idempotent, and produce the expected schema.

- [ ] **Migrations apply cleanly to a fresh database** — Drop the public
  schema entirely. Re-create it. Run all migrations. Verify all 5 core tables
  exist: `payments`, `ledger_transactions`, `ledger_entries`, `accounts`,
  `idempotency_keys`. If a migration assumes pre-existing state that doesn't
  exist in a fresh database, this test catches it.

- [ ] **Migrations are idempotent (double apply does not fail)** — Same fresh
  database. Apply migrations twice. Second apply must not throw. Drizzle
  tracks applied migrations in a journal table — double-applying skips
  already-applied migrations.

- [ ] **All expected CHECK constraints exist** — Query
  `information_schema.table_constraints` for CHECK constraints. At least one
  amount-related constraint must exist (the `positive_amount` check on
  `ledger_entries`). If someone drops a CHECK constraint in a migration, this
  test catches it.

- [ ] **All expected indexes exist** — Query `pg_indexes` for the public
  schema. `payments` and `ledger_entries` must each have at least one index
  (beyond the primary key). Missing indexes don't cause bugs — they cause
  performance cliffs. This test catches dropped indexes before they hit
  production.

---

## 7. Performance Boundaries — Regression Guards (~4 tests)

**File:** `tests/performance/boundaries.test.ts`
**Source:** Doc 08d, Section 8

These are NOT benchmarks. They are regression guards. If someone accidentally
removes an index, adds an N+1 query, or changes a query plan, these tests
catch the performance cliff before it ships. The thresholds are generous —
they're not testing for optimal speed, they're testing for "did something go
catastrophically wrong."

- [ ] **Balance query scales linearly with entry count** — Create 50 authorized
  payments (100+ ledger entries). Query `customer_funds` balance. Must complete
  in under 100ms. This is a single aggregate query against an indexed column —
  if it takes longer than 100ms with 100 entries, something is wrong (missing
  index, N+1 query, wrong query plan).

- [ ] **God check scales with entry count** — Create 50 payments with mixed
  states (some captured, some voided). Run `verifySystemBalance(db)`. Must
  complete in under 200ms. The god check is a single `SUM ... GROUP BY
  direction` — it should be constant-time relative to entry count with proper
  indexing.

- [ ] **Payment list query with pagination stays fast** — Create 100 payments.
  Query `listPayments(db, { limit: 20 })`. Must return exactly 20 results in
  under 100ms. Cursor pagination is O(1) — this test catches accidental
  regression to O(n) offset pagination.

- [ ] **Concurrent operations don't degrade linearly** — Time a single
  authorization. Time 10 concurrent authorizations. The 10 concurrent ops
  must complete in under 5x the single-op time (generous for DB contention).
  If 10 concurrent ops take 10x, the lock is too broad or connections are
  serializing unnecessarily.

---

## 8. Test Isolation — Meta-Tests (~6 tests)

**File:** `tests/meta/isolation.test.ts`
**Source:** Doc 08d, Section 9

Tests that test the testing. If `cleanBetweenTests()` doesn't actually clean,
every test in the suite is suspect — a test might pass because a previous test
left data it depends on. These meta-tests prove that no test leaks state to
another.

The tests run in sequence. Each one either creates data or verifies data from
the previous test doesn't exist.

- [ ] **First: creates a payment and verifies it exists** — Baseline.
  `COUNT(*) FROM payments` is 1.

- [ ] **Second: verifies the previous test's payment does NOT exist** —
  `COUNT(*) FROM payments` is 0. If this fails, `cleanBetweenTests()` is
  broken and the entire suite is untrustworthy.

- [ ] **Third: creates ledger entries and verifies they exist** — Baseline
  for ledger cleanup. `COUNT(*) FROM ledger_entries` is > 0.

- [ ] **Fourth: verifies the previous test's ledger entries do NOT exist** —
  `COUNT(*) FROM ledger_entries` is 0. Ledger cleanup works.

- [ ] **Fifth: creates a payment with a specific idempotency key** —
  `COUNT(*) FROM idempotency_keys` is 1.

- [ ] **Sixth: previous idempotency key is gone, same key works again** —
  `COUNT(*) FROM idempotency_keys` is 0. The same key `"ik_isolation_test"`
  creates a new payment without conflict. If this fails, idempotency keys
  leak between tests and every idempotency test is suspect.

These six tests are the foundation of trust. If they pass, you know:
- `cleanBetweenTests()` truncates payments, ledger entries, ledger
  transactions, and idempotency keys
- Every test starts with a clean database (5 seeded accounts, nothing else)
- Test order doesn't matter (no hidden dependencies)
- The test suite is deterministic

---

## 9. Time Manipulation — Authorization Expiry (~5 tests)

**File:** `tests/integration/payments/expiration.test.ts`
**Source:** Doc 08d, Section 4

Authorization holds don't last forever. After 7 days, they expire. We can't
wait 7 days in a test — so we manipulate `expires_at` directly in the database
to simulate time passing.

- [ ] **Authorization within expiry window is still capturable** — Create
  authorized payment. Set `expires_at` to 1 day from now (within the 7-day
  window). Capture succeeds. Status becomes `captured`.

- [ ] **Authorization past expiry window cannot be captured** — Create
  authorized payment. Set `expires_at` to 1 hour ago (past the window). Capture
  fails with an error matching `/expired|invalid state/i`.

- [ ] **Expired authorization releases held funds** — Create authorized
  payment. Expire it. After expiration: `verifySystemBalance(db)` passes.
  The hold is released — `customer_holds` returns to zero for this payment.

- [ ] **Expiry creates reversing ledger entries** — Create authorized payment.
  Note entry count. Expire it. Reversing entries should exist (DEBIT
  customer_funds / CREDIT customer_holds — mirror of authorization). System
  balance verified.

- [ ] **Void beats expiry (no double-release)** — Create authorized payment.
  Void it. Then set `expires_at` to the past. The payment is already voided —
  attempting to expire it is a no-op. Status remains `voided`. System balance
  verified. The hold was released by the void, not by expiry. No double-release
  means no money created from nothing.

The tests use raw SQL (`UPDATE payments SET expires_at = ...`) to manipulate
time. This is one of the few places where raw SQL modifies payment state
directly — testing time without mocking clocks.

---

## 10. File Structure

```
tests/
├── property/
│   └── random-sequences.test.ts     # ~52 tests (50 seeds + 1 extended)
│
├── failure/
│   ├── connection-drop.test.ts      # ~3 tests (rollback, no orphans)
│   └── slow-query.test.ts           # ~1 test (contention + invariants)
│
├── reconciliation/
│   ├── end-of-day.test.ts           # ~6 tests (full trading day audit)
│   └── witness.test.ts              # ~5 tests (reconstruct from ledger)
│
├── fuzz/
│   └── validation-fuzz.test.ts      # ~4 tests (500 payloads, proto, size)
│
├── migration/
│   └── migration-safety.test.ts     # ~4 tests (fresh, idempotent, schema)
│
├── performance/
│   └── boundaries.test.ts           # ~4 tests (regression guards)
│
├── meta/
│   └── isolation.test.ts            # ~6 tests (cleanup verification)
│
└── k6/
    └── payment-flow.js              # Optional — stakeholder demos only
```

New files in Phase 5: 9 test files + 1 optional k6 script. No new source
files — Phase 5 writes zero production code. It only writes tests. If a test
fails, the fix goes into the source files created in Phases 1-4.

---

## 11. Import Architecture

```
tests/property/random-sequences.test.ts
  ├── tests/helpers/setup.ts           (setupTestDB, cleanBetweenTests)
  ├── tests/helpers/god-check.ts       (verifySystemBalance, verifyAllTransactionsBalance)
  ├── tests/helpers/factories.ts       (createAuthorizedPayment, uniqueKey)
  └── src/payments/service.ts          (authorize, capture, void, refund, settle)

tests/reconciliation/witness.test.ts
  ├── tests/helpers/setup.ts
  ├── tests/helpers/factories.ts
  ├── src/payments/service.ts          (getPayment — for comparison only)
  └── drizzle-orm/sql                  (raw queries on ledger tables)

tests/fuzz/validation-fuzz.test.ts
  ├── tests/helpers/setup.ts
  ├── tests/helpers/god-check.ts
  ├── tests/helpers/factories.ts       (uniqueKey)
  └── src/server.ts                    (app — for app.request())

tests/migration/migration-safety.test.ts
  ├── tests/helpers/setup.ts
  ├── drizzle-orm/postgres-js/migrator (migrate)
  └── postgres                         (raw connection for schema DROP)
```

The advanced tests import from `tests/helpers/` and `src/`. They never import
from each other. Each test file is independent — you can run any subset without
the others. The property tests need the payment service. The witness test needs
the ledger tables. The fuzz tests need the HTTP app. The migration tests need
the raw postgres client. No test depends on another test's output.

---

## 12. The SeededRNG — Shared Infrastructure

The `SeededRNG` class appears in both `random-sequences.test.ts` and
`validation-fuzz.test.ts`. It could be extracted to a shared helper, but
it's intentionally duplicated. Each test file is self-contained — you can
read it top to bottom without cross-referencing. The RNG is 15 lines. The
cost of duplication is lower than the cost of indirection.

If the RNG algorithm needs to change (it won't — mulberry32 is well-tested),
change it in both files. Two files. Fifteen lines each. Not worth an import.

---

## 13. Running the Tests

```bash
# Property-based tests (50 seeds + extended run)
bun test tests/property/

# Failure injection
bun test tests/failure/

# Financial reconciliation + witness
bun test tests/reconciliation/

# Fuzz testing
bun test tests/fuzz/

# Migration safety
bun test tests/migration/

# Performance boundaries
bun test tests/performance/

# Test isolation meta-tests
bun test tests/meta/

# All advanced tests at once
bun test tests/property/ tests/failure/ tests/reconciliation/ tests/fuzz/ tests/migration/ tests/performance/ tests/meta/

# The full suite — all 420+ tests, stop on first failure
bun test --bail
```

The extended property test (seed 999, 1,000 operations) has a 30-second
timeout. Every other test should complete in under 5 seconds. If a performance
boundary test takes longer than its threshold, that's a test failure — the
test is its own oracle.

---

## 14. Commit Strategy

One file per commit. Each commit adds a complete test file — no partial
implementations, no "TODO: add more seeds." The advanced tests don't drive
implementation, so there's no alternating RED/GREEN. Each commit is a new
category of proof.

```
feat(tests): add property-based random sequence tests (~52 tests)
feat(tests): add failure injection tests (~4 tests)
feat(tests): add end-of-day reconciliation tests (~6 tests)
feat(tests): add witness test — reconstruct from ledger (~5 tests)
feat(tests): add fuzz testing — 500 random payloads (~4 tests)
feat(tests): add migration safety tests (~4 tests)
feat(tests): add performance boundary regression guards (~4 tests)
feat(tests): add test isolation meta-tests (~6 tests)
feat(tests): add k6 load test script (optional, demos only)
```

9 commits. Each adds a complete, independent test file. Any regression is
traceable to the source file. `git bisect` is irrelevant here — if an
advanced test fails, the bug is in the production code, not in the test.
The test is the proof. The fix goes in a separate commit against the relevant
Phase 2-4 source file.

---

## 15. Test Count Summary

| Category | Tests |
|---|---|
| Property-based (50 seeds + 1 extended) | ~52 |
| Failure injection (connection drops + contention) | ~4 |
| Financial reconciliation (end-of-day audit) | ~6 |
| Witness test (reconstruct from ledger) | ~5 |
| Fuzz testing (validation boundaries) | ~4 |
| Authorization expiry (time manipulation) | ~5 |
| Migration safety (schema integrity) | ~4 |
| Performance boundaries (regression guards) | ~4 |
| Test isolation (meta-tests) | ~6 |
| **Phase 5 Total** | **~90** |

Combined with Phases 2-4:

| Phase | Tests |
|---|---|
| Phase 2: Ledger | ~25 |
| Phase 3: Payments (unit + integration) | ~300 |
| Phase 4: API (E2E + load) | ~30 |
| Phase 5: Advanced | ~90 |
| **Grand Total** | **~445** |

---

## 16. What Phase 5 Does NOT Do

- **No new production code.** Phase 5 writes tests, not features. If a test
  fails, the fix goes in the service/route/middleware created in Phases 1-4.
- **No new endpoints.** The API is complete after Phase 4.
- **No new database tables.** The schema is frozen after Phase 1.
- **No mocks.** Every test runs against real Postgres. The property-based tests
  execute real service calls. The fuzz tests hit real endpoints. The witness
  reads real ledger entries.
- **No benchmarks.** The performance tests are regression guards, not
  optimization targets. "Under 100ms" is a cliff detector, not a goal.
- **No k6 in CI.** The k6 script is for stakeholder demos and profiling
  sessions. The custom harness from Phase 4 handles CI load testing. k6 cannot
  run the god check.

---

## 17. Final Gate Checklist

- [ ] All ~52 property-based tests green (50 seeds + 1 extended run)
- [ ] All ~4 failure injection tests green (rollback proven)
- [ ] All ~6 reconciliation tests green (audit trail complete)
- [ ] All ~5 witness tests green (ledger reconstructs payment state)
- [ ] All ~4 fuzz tests green (500 random payloads, no crashes)
- [ ] All ~5 expiry tests green (time manipulation works)
- [ ] All ~4 migration tests green (schema is sound)
- [ ] All ~4 performance boundary tests green (no regressions)
- [ ] All ~6 meta-tests green (test isolation verified)
- [ ] God check passes after property-based extended run
- [ ] God check passes after reconciliation trading day
- [ ] God check passes after fuzz testing
- [ ] No new source files created (tests only)
- [ ] Every test file is independent (can run in any order)
- [ ] `bun run lint` passes
- [ ] `bun test --bail` exits 0 (all ~445 tests green)

When this gate passes, the payment engine is not just tested — it's *proven*.
Not "it handles the cases we thought of." It handles the cases we didn't think
of, because the machine generated them. Not "the ledger looks right." An
independent witness verified it. Not "the tests pass." The tests themselves were
verified by meta-tests that prove they don't leak state. Not "it's fast enough."
Regression guards will catch it before it isn't.

445 tests. 50 random seeds. 1,000-operation stress run. 500 fuzz payloads.
A complete trading day audit. An independent financial witness. And through
all of it — every random sequence, every garbage payload, every simulated
failure, every concurrent race — `SUM(debits) === SUM(credits)`.

The god check passes. The system is correct.

---

Previous: [Phase 4 — API Layer](./phase-4-api.md)
