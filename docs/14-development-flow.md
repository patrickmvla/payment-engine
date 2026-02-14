# Development Flow — How We Build This, And Why

Every payment engine tutorial writes the code first and bolts on tests later.
That's backwards. The docs are the spec. The tests prove the spec. The code
makes the tests pass. In that order.

This document defines the development methodology — the sequence, the rules,
and the gates between phases. Deviate from this and you'll end up with a
payment engine that "works" until it doesn't.

---

## 1. The Principles

Three decisions, locked in:

**TDD (Test-Driven Development)** — Every piece of logic is written to satisfy
a pre-existing test. Not "write code then verify." Write the test, watch it
fail, write the minimum code to pass, refactor. The docs already define every
test (see 08a through 08d). The implementation is just making those tests go
green.

**Functional Paradigm** — Pure functions, explicit parameters, module
namespacing. No classes, no `this`, no dependency injection containers.

```typescript
// YES — pure function, db is explicit, output depends only on input
export async function authorize(db: Database, params: AuthorizeParams, key: string) { ... }

// YES — pure function, no database, no side effects
export function validateTransition(current: PaymentStatus, action: string): PaymentStatus { ... }

// NO — class wrapping functional APIs adds indentation, not value
class PaymentService {
  constructor(private db: Database) {}
  async authorize(params: AuthorizeParams) { return authorize(this.db, params); }
}
```

Why functional:
- **The stack is functional.** Hono handlers, Drizzle queries, Zod schemas,
  Bun test cases — all function-based. Classes would wrap every call in
  `this.thing()` delegating to the functional API underneath.
- **Pure functions are provably correct.** `validateTransition("authorized", "capture")`
  always returns `"captured"`. No hidden state, no test setup, no mocking.
- **Explicit is auditable.** `authorize(db, params, key)` shows every
  dependency. `this.authorize(params)` hides the database behind `this`.
- **The financial domain is functional.** A ledger transaction is a pure
  transform: entries in, balanced transaction out. A balance query is pure
  math: entries in, bigint out. A state machine is a pure function:
  (status, action) → status.

The only time OOP earns its weight in fintech is polymorphic payment processor
adapters (Stripe adapter, Adyen adapter). We're not wrapping processors — we
ARE the processor.

**Inside-Out (Bottom-Up)** — Start from the foundation and build upward:

```
                    ┌──────────────────────┐
                    │   Phase 4: API       │   ← Last. Thin HTTP layer.
                    │   Routes, middleware  │      Depends on everything below.
                    ├──────────────────────┤
                    │   Phase 3: Payments  │   ← Business logic.
                    │   State machine,     │      Depends on ledger.
                    │   idempotency        │
                    ├──────────────────────┤
                    │   Phase 2: Ledger    │   ← Core accounting.
                    │   Transactions,      │      Depends on schema.
                    │   entries, balances   │
                    ├──────────────────────┤
                    │   Phase 1: Foundation│   ← Schema, config, shared
                    │   No business logic  │      utilities. No tests yet
                    │                      │      (nothing to test).
                    └──────────────────────┘
```

Each layer has exactly one dependency: the layer below it. No circular
references. No "I'll fix this import later." If layer N depends on something
from layer N+1, the architecture is wrong.

---

## 2. Why Not the Alternatives

### Why Not Outside-In?

Outside-in starts from the API and mocks everything below. You get a "working"
API that returns hardcoded responses. Then you swap mocks for real
implementations. The problem:

- **Mocks lie.** A mock that returns `{ status: "captured" }` tells you
  nothing about whether the ledger entries balance. The mock doesn't know about
  double-entry bookkeeping. The mock doesn't know about pessimistic locking.
- **Deferred pain.** The hard parts (ledger integrity, concurrency, state
  machine) are pushed to the end. By then, the API shape is locked in and
  may not fit what the ledger actually needs.
- **For fintech, the inside IS the product.** The ledger isn't an
  implementation detail — it's the source of truth. Building it last is like
  building a house roof-first.

### Why Not Vertical Slice?

Vertical slice implements one complete feature (authorize) across all layers
before moving to the next (capture). The problem:

- **Shared infrastructure gets built incrementally.** The ledger service,
  error handling, idempotency — they get built piecemeal as each slice needs
  them. This leads to inconsistent patterns between slices.
- **Refactoring cascades.** When you build capture, you realize the ledger
  API you designed for authorize doesn't quite work. Now you're changing the
  foundation while features depend on it.
- **Testing is harder.** The god check (system-wide balance verification)
  only makes sense when the ledger is complete. With slices, you can't verify
  the fundamental invariant until all slices are done.

### Why Inside-Out Wins for a Payment Engine

- **The ledger is independently verifiable.** Before a single payment exists,
  you can prove that transactions balance, entries are immutable, and balances
  are correct.
- **Each layer has a solid foundation.** When the payment service calls
  `postTransaction()`, it already works. No mocks, no stubs, no "TODO: implement."
- **The god check works from Phase 2 onward.** The moment the ledger exists,
  you can verify system-wide integrity. Every subsequent phase preserves it.
- **Concurrency is tested where it matters.** `SELECT ... FOR UPDATE` is a
  database feature, not an API feature. Testing it at the service layer (Phase 3)
  gives you real Postgres locks, not mocked behavior.

---

## 3. The Phases

### Phase 1: Foundation

**Goal:** A runnable project with database schema, config, and shared utilities.
No business logic. No tests (there's nothing to test yet — pure scaffolding).

**Creates:**

```
payment-engine/
├── package.json                  # Dependencies, scripts
├── tsconfig.json                 # TypeScript config
├── biome.json                    # Formatter + linter config
├── docker-compose.yml            # Local Postgres
├── drizzle.config.ts             # Migration config
├── .env.example                  # Documented env vars
├── .gitignore
│
├── scripts/
│   ├── init-test-db.sql          # Creates test database
│   └── reset-db.ts               # Dev-only database reset
│
├── drizzle/
│   └── 0001_initial_schema.sql   # Generated migration
│
├── src/
│   ├── server.ts                 # Entry point (Hono app + startup)
│   │
│   ├── shared/
│   │   ├── config.ts             # Zod-validated env config
│   │   ├── db.ts                 # Connection, pool, validation, shutdown
│   │   ├── logger.ts             # Structured JSON logger
│   │   ├── id.ts                 # Prefixed ULID generation
│   │   ├── money.ts              # BigInt money utilities
│   │   ├── errors.ts             # Error classes (PaymentNotFound, etc.)
│   │   └── seed.ts               # System account seeding
│   │
│   ├── ledger/
│   │   └── schema.ts             # Drizzle schema: accounts, transactions, entries
│   │
│   └── payments/
│       └── schema.ts             # Drizzle schema: payments, idempotency_keys
│
└── tests/
    └── helpers/
        ├── setup.ts              # setupTestDB, teardown, clean
        ├── factories.ts          # Test data factories (empty stubs)
        ├── god-check.ts          # verifySystemBalance, verifyAllTransactionsBalance
        └── assertions.ts         # assertEntriesBalance, assertPaymentConsistency
```

**Gate:** `docker compose up -d && bun run db:migrate && bun run db:seed`
succeeds. Server starts and `/health` returns 200. All 5 system accounts exist.
No tests to run yet — but the test helpers compile.

---

### Phase 2: Ledger Layer

**Goal:** A complete, independently verifiable ledger service. Post balanced
transactions, query balances, enforce immutability. The ledger doesn't know
payments exist.

**Test source:** Doc 08b, Section 1 (Ledger Foundation, ~25 tests)

**TDD sequence:**

```
Step 1: Write tests for posting balanced transactions
        → RED (postTransaction doesn't exist)
Step 2: Implement postTransaction()
        → GREEN
Step 3: Write tests for rejection of invalid transactions
        → RED
Step 4: Implement validation in postTransaction()
        → GREEN
Step 5: Write tests for immutability enforcement
        → RED
Step 6: Add database triggers (block UPDATE/DELETE on ledger tables)
        → GREEN
Step 7: Write tests for balance queries
        → RED
Step 8: Implement getBalance(), getAccountBalance()
        → GREEN
Step 9: Write tests for transaction history
        → RED
Step 10: Implement getTransactionsByReference()
         → GREEN
Step 11: Run god check
         → PASS (SUM debits === SUM credits across all tests)
```

**Creates:**

```
src/ledger/
├── schema.ts         # Already exists from Phase 1
├── service.ts        # postTransaction, getBalance, getTransactionsByReference
└── types.ts          # TransactionEntry, BalanceResult, etc.

tests/integration/ledger/
├── post-transaction.test.ts
├── balance-query.test.ts
├── immutability.test.ts
└── history.test.ts
```

**Gate:** All ~25 ledger tests green. God check passes. The ledger service
is a standalone, tested module with zero payment awareness.

---

### Phase 3: Payment Layer

**Goal:** Full payment lifecycle — authorize, capture, void, refund, expiration.
State machine enforced. Idempotency working. Concurrency safe. Every operation
creates correct ledger entries.

**Test source:** Doc 08b, Sections 2-6 (~110 tests)

**TDD sequence:**

```
Step 1:  Write unit tests for state machine (08a)
         → RED
Step 2:  Implement state machine (validateTransition)
         → GREEN
Step 3:  Write unit tests for validation schemas (08a)
         → RED
Step 4:  Implement Zod schemas
         → GREEN
Step 5:  Write unit tests for money utilities (08a)
         → RED
Step 6:  Implement money utilities (if not already complete)
         → GREEN
Step 7:  Write integration tests for authorize (08b §2a)
         → RED
Step 8:  Implement paymentService.authorize()
         → GREEN + god check
Step 9:  Write integration tests for capture (08b §2b)
         → RED
Step 10: Implement paymentService.capture()
         → GREEN + god check
Step 11: Write integration tests for void (08b §2c)
         → RED
Step 12: Implement paymentService.void()
         → GREEN + god check
Step 13: Write integration tests for refund (08b §2d)
         → RED
Step 14: Implement paymentService.refund()
         → GREEN + god check
Step 15: Write integration tests for expiration (08b §2e)
         → RED
Step 16: Implement expiration logic
         → GREEN + god check
Step 17: Write query tests (08b §3)
         → RED
Step 18: Implement getPayment(), listPayments()
         → GREEN
Step 19: Write idempotency tests (08b §4)
         → RED
Step 20: Implement idempotency middleware/service
         → GREEN
Step 21: Write concurrency tests (08b §5)
         → RED
Step 22: Add SELECT ... FOR UPDATE to all mutation operations
         → GREEN + god check
Step 23: Write invariant tests (08b §6)
         → RED → GREEN (these should already pass if previous steps are correct)
```

**Creates:**

```
src/payments/
├── schema.ts           # Already exists from Phase 1
├── service.ts          # authorize, capture, void, refund, getPayment, listPayments
├── state-machine.ts    # validateTransition, VALID_TRANSITIONS
└── types.ts            # PaymentStatus, PaymentResponse, etc.

src/shared/
├── errors.ts           # Expanded: PaymentNotFoundError, InvalidStateTransitionError, etc.
└── idempotency.ts      # Idempotency key management

tests/unit/
├── state-machine.test.ts
├── balance-computation.test.ts
├── validation.test.ts
├── money.test.ts
└── id-generation.test.ts

tests/integration/payments/
├── authorize.test.ts
├── capture.test.ts
├── void.test.ts
├── refund.test.ts
├── expiration.test.ts
├── queries.test.ts
└── idempotency.test.ts

tests/integration/concurrency/
├── double-capture.test.ts
├── capture-void-race.test.ts
├── double-refund.test.ts
├── parallel-payments.test.ts
└── stress.test.ts

tests/integration/invariants/
├── god-check.test.ts
├── account-integrity.test.ts
└── constraint-tests.test.ts
```

**Gate:** All unit tests (~165) green. All integration tests (~135) green. God
check passes after every operation type. Concurrent operations don't corrupt
state. The payment service is a standalone, tested module that happens to
create ledger entries.

---

### Phase 4: API Layer

**Goal:** HTTP endpoints via Hono + OpenAPI. Thin route handlers that call the
payment service. Middleware for idempotency checking, rate limiting, error
formatting, security headers.

**Test source:** Doc 08c (E2E & Load, ~30 tests)

**TDD sequence:**

```
Step 1:  Write E2E happy path tests via Hono RPC (08c)
         → RED (routes don't exist)
Step 2:  Implement routes: POST /authorize, /capture, /void, /refund
         → GREEN
Step 3:  Write E2E error response tests
         → RED
Step 4:  Implement error middleware (consistent error shape)
         → GREEN
Step 5:  Write API contract tests (response shapes, headers, timestamps)
         → RED
Step 6:  Wire up OpenAPI schemas, security headers, request tracing
         → GREEN
Step 7:  Write pagination tests
         → RED
Step 8:  Implement GET /payments with cursor pagination
         → GREEN
Step 9:  Write idempotency middleware E2E tests
         → RED
Step 10: Wire idempotency middleware into routes
         → GREEN
Step 11: Run load tests (08c load harness)
         → PASS (throughput + correctness under concurrency)
```

**Creates:**

```
src/
├── server.ts               # Updated: Hono app, routes, startup
├── payments/
│   └── routes.ts           # OpenAPI route definitions + handlers
├── ledger/
│   └── routes.ts           # Account balance, payment ledger routes
└── shared/
    ├── middleware/
    │   ├── idempotency.ts  # Idempotency key checking middleware
    │   ├── rate-limit.ts   # In-memory per-IP rate limiter
    │   ├── error-handler.ts# Consistent error response formatting
    │   └── security.ts     # Security headers, request tracing
    └── openapi.ts          # OpenAPI spec metadata

tests/e2e/
├── happy-paths.test.ts
├── error-responses.test.ts
├── api-contract.test.ts
└── pagination.test.ts

tests/load/
├── harness.ts
├── payment-throughput.test.ts
└── concurrent-lifecycle.test.ts
```

**Gate:** All E2E tests green. All load tests pass with acceptable latency.
`/docs` renders the full OpenAPI spec. Every endpoint returns correct status
codes, headers, and error shapes. God check passes after load testing.

---

### Phase 5: Advanced Testing

**Goal:** Prove the system is correct not just for known inputs, but for
arbitrary inputs, failure conditions, and adversarial scenarios.

**Test source:** Doc 08d (~90 tests)

**TDD sequence:**

```
Step 1:  Write property-based tests (random operation sequences)
         → Should PASS (if Phases 2-4 are correct)
Step 2:  Write failure injection tests (connection drops)
         → Verify ACID rollback on failure
Step 3:  Write reconciliation tests (end-of-day audit trail)
         → Verify ledger completeness
Step 4:  Write the witness test (reconstruct state from ledger alone)
         → Verify ledger is the source of truth
Step 5:  Write fuzz tests (random payloads, boundary inputs)
         → Verify validation rejects everything invalid
Step 6:  Write migration safety tests (fresh apply, double apply)
         → Verify schema integrity
Step 7:  Write performance boundary tests (scale regression guards)
         → Baseline established
Step 8:  Write test isolation tests (no state leakage)
         → Verify test infrastructure is sound
```

**Creates:**

```
tests/property/
│   └── random-sequences.test.ts
tests/failure/
│   ├── connection-drop.test.ts
│   └── slow-query.test.ts
tests/reconciliation/
│   ├── end-of-day.test.ts
│   └── witness.test.ts
tests/fuzz/
│   └── validation-fuzz.test.ts
tests/migration/
│   └── migration-safety.test.ts
tests/performance/
│   └── boundaries.test.ts
tests/meta/
│   └── isolation.test.ts
tests/k6/
│   └── payment-flow.js
```

**Gate:** All ~420+ tests green. `bun test` passes with zero failures. The
system is proven correct for known inputs, random inputs, concurrent inputs,
failure conditions, and adversarial inputs.

---

## 4. The Rules

### Rule 1: Test Before Code

No implementation without a failing test. The test is written from the doc
spec, not from the implementation. If the test doesn't exist in docs 08a-08d,
it's either missing from the spec (fix the doc) or unnecessary (don't write it).

### Rule 2: God Check After Every Mutation

Every test file that creates ledger entries runs `verifySystemBalance()` in
`afterAll`. This is not optional. If a test creates money or destroys money,
we know immediately — not three phases later.

### Rule 3: No Phase Skipping

Phase N does not begin until Phase N-1's gate passes. You don't write API
routes while the ledger is broken. You don't write property tests while the
payment service has failing tests.

### Rule 4: No Mocks for Financial Logic

The ledger service is never mocked. The database is never mocked. If a test
needs a captured payment, it calls `paymentService.authorize()` then
`paymentService.capture()` against real Postgres. Mocks are only acceptable
for:
- External services (bank simulation — not in v1)
- Time (for expiration tests)
- Nothing else

### Rule 5: Refactor Only on Green

All tests passing → refactor → all tests still passing. Never refactor while
tests are red. The tests are the safety net. Refactoring without them is
walking a tightrope without a net over a pit of other people's money.

### Rule 6: One Concern Per Commit

Each commit either adds a test or makes a test pass. Not both. This makes
the git history a readable narrative:

```
feat(ledger): add tests for posting balanced transactions
feat(ledger): implement postTransaction()
feat(ledger): add tests for rejection of invalid transactions
feat(ledger): implement transaction validation
...
```

The bisect history is clean. Any regression is traceable to a single commit.

---

## 5. The TDD Cycle (Fintech Edition)

The standard TDD cycle is red → green → refactor. For a payment engine, it's:

```
1. RED    — Write a failing test from the doc spec
2. GREEN  — Write the minimum code to make it pass
3. CHECK  — Run the god check (SUM debits === SUM credits)
4. REFACTOR — Clean up, extract, simplify — tests still green
5. CHECK  — God check again (refactoring didn't break invariants)
```

The CHECK step is what separates fintech TDD from regular TDD. Regular TDD
verifies behavior. Fintech TDD verifies behavior AND money conservation.

---

## 6. Dependency Graph

This is the import dependency graph. Arrows mean "imports from." No cycles.

```
server.ts
  ├── payments/routes.ts
  │     └── payments/service.ts
  │           ├── payments/state-machine.ts
  │           ├── ledger/service.ts
  │           │     └── shared/db.ts
  │           ├── shared/db.ts
  │           └── shared/errors.ts
  ├── ledger/routes.ts
  │     └── ledger/service.ts
  └── shared/
        ├── middleware/*.ts
        ├── config.ts
        ├── db.ts
        ├── logger.ts
        └── id.ts
```

**Direction:** Arrows only point downward and to `shared/`. If `ledger/service.ts`
ever imports from `payments/`, the architecture is wrong. If `shared/db.ts`
ever imports from `ledger/`, the architecture is wrong.

---

## 7. When Is It Done?

```
□ Phase 1 gate: Server starts, /health returns 200, schema deployed
□ Phase 2 gate: ~25 ledger tests green, god check passes
□ Phase 3 gate: ~165 unit + ~135 integration tests green, god check passes
□ Phase 4 gate: ~30 E2E + load tests green, /docs renders, god check passes
□ Phase 5 gate: ~90 advanced tests green, bun test --bail passes
□ Final gate: All ~420+ tests green in a single bun test run
```

When the final gate passes, the payment engine is complete. Not "working."
Not "mostly done." **Provably correct** — every invariant verified, every
edge case covered, every race condition tested, every amount balanced.

---

Previous: [13 — Database Connection Strategy](./13-database-connection-strategy.md) | Back to: [README](../README.md)
