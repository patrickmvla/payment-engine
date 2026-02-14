# Testing Strategy — Proving The System Is Correct

In fintech, "it works on my machine" means nothing. You need to prove — with
repeatable, automated evidence — that money is never created, destroyed, or
misrouted. This document defines how.

This is the testing hub. The strategy, philosophy, and infrastructure live
here. The actual test implementations live in dedicated sub-documents.

---

## 1. Testing Philosophy

### What We're Proving

We're not just checking that functions return the right values. We're proving:

1. **Money is conserved** — No transaction creates or destroys money
2. **State transitions are valid** — Payments only move through legal states
3. **Concurrency is safe** — Parallel requests don't corrupt data
4. **Idempotency works** — Retries don't create duplicates
5. **Constraints hold** — Invalid data is rejected at every layer
6. **Edge cases are handled** — Zero amounts, max values, expired auths
7. **Ledger is immutable** — Entries cannot be modified or deleted
8. **Balances are always derivable** — Computed balances match entry sums
9. **Error responses are structured** — Every error matches the spec
10. **The system self-heals from retries** — No corrupt state after failures
11. **No operation sequence breaks invariants** — Randomized proof, not manual cases
12. **The ledger tells the complete story** — An independent witness can reconstruct state

### Testing Pyramid

```
          ╱  ╲
         ╱ E2E ╲            Few — full HTTP flows via Hono RPC
        ╱────────╲
       ╱   Load    ╲        Targeted — correctness under concurrency
      ╱──────────────╲
     ╱  Integration   ╲     Medium — service + real Postgres
    ╱──────────────────╲
   ╱   Concurrency      ╲   Targeted — race conditions, locks
  ╱────────────────────────╲
 ╱       Unit Tests         ╲  Many — pure functions, fast, isolated
╱────────────────────────────╲
```

| Layer | What | Database | Speed | Count |
|---|---|---|---|---|
| Unit | Pure logic (state machine, validation, balance math) | No | <1ms each | Many |
| Integration | Service functions against real Postgres | Yes | ~50ms each | Medium |
| Concurrency | Parallel operations on same resources | Yes | ~200ms each | Targeted |
| E2E | Full HTTP via Hono RPC client — type-safe | Yes | ~100ms each | Few |
| Load | Throughput + latency + correctness under concurrency | Yes | Variable | Targeted |
| Advanced | Property-based, fuzz, reconciliation, witness | Varies | Variable | ~90 |

---

## 2. Test Sub-Documents

Read these in order. Each builds on the previous.

| # | Document | What It Covers | Approx Tests |
|---|---|---|---|
| 08a | [Unit Tests](./08a-unit-tests.md) | Money operations, state machine, balance computation, validation, ID generation | ~165 |
| 08b | [Integration Tests](./08b-integration-tests.md) | Ledger, payments, queries, expiration, concurrency, idempotency, invariants, god check | ~155 |
| 08c | [E2E & Load Testing](./08c-e2e-and-load-testing.md) | Hono RPC E2E, custom load harness, optional k6 | ~30 |
| 08d | [Advanced Testing](./08d-advanced-testing.md) | Property-based, failure injection, reconciliation, witness, fuzz, migration, perf, isolation | ~90 |

**Total: ~440+ tests**

---

## 3. Test File Structure

```
tests/
├── unit/
│   ├── state-machine.test.ts        # All state transitions
│   ├── balance-computation.test.ts  # Balance math for all account types
│   ├── validation.test.ts           # Zod schema validation
│   ├── money.test.ts                # Integer money operations
│   └── id-generation.test.ts        # ULID prefix generation
│
├── integration/
│   ├── ledger/
│   │   ├── post-transaction.test.ts # Creating ledger transactions
│   │   ├── balance-query.test.ts    # Querying account balances
│   │   ├── immutability.test.ts     # Proving entries can't be modified
│   │   └── history.test.ts          # Transaction history queries
│   │
│   ├── payments/
│   │   ├── authorize.test.ts        # Authorization tests
│   │   ├── capture.test.ts          # Capture tests (full + partial)
│   │   ├── void.test.ts             # Void tests
│   │   ├── refund.test.ts           # Refund tests (full + partial)
│   │   ├── settle.test.ts           # Settlement tests
│   │   ├── expiration.test.ts       # Authorization expiry
│   │   ├── queries.test.ts          # Get payment, list payments
│   │   └── idempotency.test.ts      # All idempotency scenarios
│   │
│   ├── concurrency/
│   │   ├── double-capture.test.ts   # Two captures on same auth
│   │   ├── capture-void-race.test.ts# Capture vs void race
│   │   ├── double-refund.test.ts    # Concurrent refunds
│   │   ├── parallel-payments.test.ts# Many payments at once
│   │   └── stress.test.ts           # High-volume correctness
│   │
│   └── invariants/
│       ├── god-check.test.ts        # System-wide balance
│       ├── account-integrity.test.ts# Per-account balance integrity
│       └── constraint-tests.test.ts # Database constraint enforcement
│
├── e2e/
│   ├── happy-paths.test.ts          # Golden path flows (Hono RPC)
│   ├── error-responses.test.ts      # Every error shape
│   ├── api-contract.test.ts         # Response shapes match spec
│   └── pagination.test.ts           # Cursor pagination
│
├── load/
│   ├── harness.ts                   # Load test harness (percentiles, reporting)
│   ├── payment-throughput.test.ts   # Throughput + correctness
│   └── concurrent-lifecycle.test.ts # Full lifecycle under load
│
├── property/
│   └── random-sequences.test.ts     # Random operation sequences (50+ seeds)
│
├── failure/
│   ├── connection-drop.test.ts      # Transaction rollback on failure
│   └── slow-query.test.ts           # Invariants under artificial delay
│
├── reconciliation/
│   ├── end-of-day.test.ts           # Audit trail completeness
│   └── witness.test.ts              # Reconstruct state from ledger alone
│
├── fuzz/
│   └── validation-fuzz.test.ts      # Random payloads, prototype pollution
│
├── migration/
│   └── migration-safety.test.ts     # Fresh apply, idempotent, constraints
│
├── performance/
│   └── boundaries.test.ts           # Scale degradation regression guards
│
├── meta/
│   └── isolation.test.ts            # Prove tests don't leak state
│
├── k6/
│   └── payment-flow.js              # Optional k6 script for demos
│
└── helpers/
    ├── setup.ts                     # DB setup/teardown
    ├── factories.ts                 # Test data factories
    ├── god-check.ts                 # System balance verification
    ├── assertions.ts                # Custom test assertions
    └── load-harness.ts              # Percentile calculator + reporter
```

---

## 4. Test Helpers & Factories

Before writing tests, we build the tools that make tests readable and
maintainable.

### Database Setup

Tests always run against **local Docker Postgres** via `TEST_DATABASE_URL` — never
against Supabase. No SSL needed, no remote latency, no risk of polluting
production data.

```typescript
// tests/helpers/setup.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { seedAccounts } from "../../src/shared/seed";

let db: ReturnType<typeof drizzle>;
let sql: ReturnType<typeof postgres>;

export async function setupTestDB() {
  // No SSL — TEST_DATABASE_URL always points to local Docker Postgres
  sql = postgres(process.env.TEST_DATABASE_URL!, {
    max: 5,           // Tests don't need many connections
    idle_timeout: 10,  // Clean up fast between test files
  });
  db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seedAccounts(db);
  return db;
}

export async function teardownTestDB() {
  await sql`TRUNCATE ledger_entries, ledger_transactions,
            payments, idempotency_keys CASCADE`;
  await sql.end();
}

export async function cleanBetweenTests() {
  await sql`TRUNCATE ledger_entries, ledger_transactions,
            payments, idempotency_keys CASCADE`;
}

export { db, sql };
```

### Test Data Factories

Factories eliminate boilerplate and make tests read like specifications.

```typescript
// tests/helpers/factories.ts
import { paymentService } from "../../src/payments/service";
import { ledgerService } from "../../src/ledger/service";
import { createId } from "@paralleldrive/cuid2";

type DB = ReturnType<typeof drizzle>;

export async function createAuthorizedPayment(
  db: DB,
  overrides: {
    amount?: bigint;
    currency?: string;
    description?: string;
    idempotencyKey?: string;
  } = {}
) {
  return paymentService.authorize(db, {
    amount: overrides.amount ?? 10000n,
    currency: overrides.currency ?? "USD",
    description: overrides.description,
  }, overrides.idempotencyKey ?? `ik_test_${createId()}`);
}

export async function createCapturedPayment(
  db: DB,
  overrides: {
    authorizeAmount?: bigint;
    captureAmount?: bigint;
    currency?: string;
  } = {}
) {
  const payment = await createAuthorizedPayment(db, {
    amount: overrides.authorizeAmount ?? 10000n,
    currency: overrides.currency,
  });
  return paymentService.capture(
    db,
    payment.id,
    overrides.captureAmount ? { amount: overrides.captureAmount } : undefined
  );
}

export async function createPartiallyRefundedPayment(
  db: DB,
  overrides: {
    authorizeAmount?: bigint;
    captureAmount?: bigint;
    refundAmount?: bigint;
  } = {}
) {
  const authAmount = overrides.authorizeAmount ?? 10000n;
  const capAmount = overrides.captureAmount ?? authAmount;
  const refAmount = overrides.refundAmount ?? 3000n;

  const payment = await createCapturedPayment(db, {
    authorizeAmount: authAmount,
    captureAmount: capAmount,
  });
  return paymentService.refund(db, payment.id, { amount: refAmount });
}

export async function createVoidedPayment(db: DB) {
  const payment = await createAuthorizedPayment(db);
  return paymentService.void(db, payment.id);
}

export async function createSettledPayment(
  db: DB,
  overrides: {
    authorizeAmount?: bigint;
    captureAmount?: bigint;
    currency?: string;
  } = {}
) {
  const captured = await createCapturedPayment(db, overrides);
  return paymentService.settle(db, captured.id);
}

export function uniqueKey(prefix = "ik_test"): string {
  return `${prefix}_${createId()}`;
}
```

### Custom Assertions

```typescript
// tests/helpers/assertions.ts

export function assertEntriesBalance(entries: LedgerEntry[]) {
  const debits = entries
    .filter(e => e.direction === "DEBIT")
    .reduce((sum, e) => sum + e.amount, 0n);
  const credits = entries
    .filter(e => e.direction === "CREDIT")
    .reduce((sum, e) => sum + e.amount, 0n);

  if (debits !== credits) {
    throw new Error(
      `Entries do not balance: debits=${debits} credits=${credits} diff=${debits - credits}`
    );
  }
}

export function assertPaymentConsistency(payment: Payment) {
  if (payment.capturedAmount > payment.authorizedAmount) {
    throw new Error(
      `captured (${payment.capturedAmount}) > authorized (${payment.authorizedAmount})`
    );
  }
  if (payment.refundedAmount > payment.capturedAmount) {
    throw new Error(
      `refunded (${payment.refundedAmount}) > captured (${payment.capturedAmount})`
    );
  }
  if (payment.authorizedAmount > payment.amount) {
    throw new Error(
      `authorized (${payment.authorizedAmount}) > original (${payment.amount})`
    );
  }
}

export function assertErrorResponse(
  body: unknown,
  expectedType: string,
  expectedStatus?: number
) {
  const err = (body as any).error;
  expect(err).toBeDefined();
  expect(err.type).toBe(expectedType);
  expect(typeof err.message).toBe("string");
  expect(err.message.length).toBeGreaterThan(0);
}
```

### The God Check

```typescript
// tests/helpers/god-check.ts
import { sql } from "drizzle-orm";

export async function verifySystemBalance(db: Database) {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint
        AS total_debits,
      COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint
        AS total_credits
    FROM ledger_entries
  `);

  const row = result[0];
  const totalDebits = BigInt(row.total_debits);
  const totalCredits = BigInt(row.total_credits);

  if (totalDebits !== totalCredits) {
    const entryCount = await db.execute(sql`SELECT COUNT(*) as count FROM ledger_entries`);
    const txnCount = await db.execute(sql`SELECT COUNT(*) as count FROM ledger_transactions`);

    throw new Error(
      `SYSTEM BALANCE VIOLATION\n` +
      `  Total debits:  ${totalDebits}\n` +
      `  Total credits: ${totalCredits}\n` +
      `  Difference:    ${totalDebits - totalCredits}\n` +
      `  Entry count:   ${entryCount[0].count}\n` +
      `  Txn count:     ${txnCount[0].count}\n` +
      `\n` +
      `  This means money was created or destroyed.\n` +
      `  STOP EVERYTHING AND INVESTIGATE.`
    );
  }
}

export async function verifyAllTransactionsBalance(db: Database) {
  const unbalanced = await db.execute(sql`
    SELECT
      transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as debits,
      SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as credits
    FROM ledger_entries
    GROUP BY transaction_id
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) !=
           SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
  `);

  if (unbalanced.length > 0) {
    const details = unbalanced.map((row: any) =>
      `  txn ${row.transaction_id}: debits=${row.debits} credits=${row.credits}`
    ).join("\n");

    throw new Error(
      `UNBALANCED TRANSACTIONS FOUND:\n${details}\n\n` +
      `Every transaction must have equal debits and credits.`
    );
  }
}
```

---

## 5. E2E Testing Stack

We use a two-layer approach for E2E and performance testing:

| Layer | Tool | What It Proves |
|---|---|---|
| **Functional E2E** | Hono RPC (`hc`) | Type-safe correctness, API contract, response shapes |
| **Load + Correctness** | Custom harness (Bun `fetch` + `performance.now()`) | Latency percentiles, throughput, invariants under concurrency |
| **Smoke (optional)** | k6 script | Quick "can this handle real traffic?" for demos |

**Why Hono RPC for E2E?** — The `app.request()` approach used in most Hono
projects bypasses the network layer entirely. It's integration testing
pretending to be E2E. Hono RPC (`hc`) makes real HTTP requests against a
running server, with full type safety — request bodies, response types, URL
params, and headers are all checked at compile time.

**Why a custom load harness instead of k6?** — k6 measures performance.
Our harness measures performance AND verifies correctness simultaneously.
After every load burst, the god check runs. k6 can't do that — it doesn't
know about double-entry bookkeeping.

Details in [08c — E2E & Load Testing](./08c-e2e-and-load-testing.md).

---

## 6. Test Configuration

### package.json Scripts

```json
{
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "start": "bun run src/server.ts",
    "test": "bun test",
    "test:unit": "bun test tests/unit/",
    "test:integration": "bun test tests/integration/",
    "test:e2e": "bun test tests/e2e/",
    "test:load": "bun test tests/load/",
    "test:concurrency": "bun test tests/integration/concurrency/",
    "test:invariants": "bun test tests/integration/invariants/",
    "test:property": "bun test tests/property/",
    "test:fuzz": "bun test tests/fuzz/",
    "test:reconciliation": "bun test tests/reconciliation/",
    "test:perf": "bun test tests/performance/",
    "test:migration": "bun test tests/migration/",
    "test:ci": "bun test --bail",
    "test:full": "bun test --bail tests/unit/ tests/integration/ tests/e2e/ tests/property/ tests/reconciliation/",
    "test:k6": "k6 run tests/k6/payment-flow.js",
    "db:migrate": "bun run drizzle-kit migrate",
    "db:generate": "bun run drizzle-kit generate",
    "db:seed": "bun run src/shared/seed.ts",
    "db:studio": "bun run drizzle-kit studio",
    "db:reset": "bun run scripts/reset-db.ts",
    "lint": "bun run biome check .",
    "format": "bun run biome format . --write"
  }
}
```

### CI Pipeline

For the complete CI/CD pipeline — workflow files, execution order, branch
protection, and the god check as a deployment gate — see
[17 — CI/CD](./17-ci-cd.md). Below is a summary.

```yaml
name: Payment Engine CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: payment_engine_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1

      - run: bun install
      - run: bun run db:migrate
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - run: bun run db:seed
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - name: Unit tests
        run: bun test tests/unit/

      - name: Integration tests
        run: bun test tests/integration/
        env:
          TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - name: E2E tests (Hono RPC)
        run: bun test tests/e2e/
        env:
          TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - name: Load tests
        run: bun test tests/load/
        env:
          TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - name: Property-based tests
        run: bun test tests/property/
        env:
          TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - name: Reconciliation tests
        run: bun test tests/reconciliation/
        env:
          TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

      - name: Fuzz tests
        run: bun test tests/fuzz/

      - name: Migration tests
        run: bun test tests/migration/
        env:
          TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test
```

---

## 7. What NOT To Test

- **Framework internals** — Don't test that Hono routes correctly or Drizzle
  inserts correctly. Trust them. Test YOUR logic.
- **Database constraints in isolation** — They're tested as part of the
  constraint-tests integration suite.
- **Happy-path-only** — If you only test the golden path, you only know it
  works when everything goes right. That's not when it matters.

---

## 8. Coverage Philosophy

We don't chase a coverage percentage. We chase **confidence:**

| What | How We Know It's Covered |
|---|---|
| State machine | Full 8x8 transition matrix tested |
| Validation | Every valid input, every invalid input type, 500 fuzz payloads |
| Ledger balance | Every account type, edge cases, large numbers |
| Authorization | Happy path, amounts, balance effects |
| Capture | Full, partial, boundary, invalid states |
| Void | Happy path, balance reversal, terminal state |
| Refund | Full, partial, multiple, boundary, invalid states |
| Settlement | Status transition, ledger entries, merchant_share computation, platform_cash outflow, invalid states |
| Concurrency | Double capture, capture-void race, refund overflow |
| Idempotency | Cache hit, conflict, ledger dedup, concurrent |
| God check | After every flow, after mixed operations, after concurrency, after random sequences |
| DB constraints | Direct SQL violations caught |
| API contract | Response shapes, headers, timestamps, IDs — type-checked via Hono RPC |
| Pagination | Page size, cursor, ordering, empty results |
| Error responses | Every error type, correct shape, correct status code |
| Random sequences | 50 seeds × 20 ops + 1 extended 1000-op run |
| Failure recovery | Connection drops don't leave partial state, failed ops are retryable |
| Financial reconciliation | Audit trail complete, balances reconstructable, no orphans |
| Authorization expiry | Time manipulation, expiry job, hold release |
| The witness test | Independent function reconstructs payment state from ledger alone |
| Migration safety | Fresh apply, double apply, all constraints and indexes present |
| Performance regression | Balance queries, god check, pagination, concurrent ops don't degrade |
| Load testing | Throughput + latency percentiles + correctness under concurrency |
| Test isolation | Every test starts clean, no state leakage between tests |

If these pass, the system is correct. A 95% coverage number means nothing if
the concurrency tests are missing. A 100% coverage number means nothing if
the property-based tests and witness test aren't there.

---

## 9. Test Count Summary

| Category | Approximate Count |
|---|---|
| Unit: State machine | ~80 |
| Unit: Balance computation | ~15 |
| Unit: Validation | ~30 |
| Unit: Money operations | ~30 |
| Unit: ID generation | ~10 |
| Integration: Ledger | ~27 |
| Integration: Authorize | ~10 |
| Integration: Capture | ~14 |
| Integration: Void | ~8 |
| Integration: Refund | ~14 |
| Integration: Queries | ~10 |
| Integration: Expiration | ~5 |
| Integration: Settlement | ~10 |
| Integration: Idempotency | ~20 |
| Concurrency | ~16 |
| Invariants | ~20 |
| E2E: Hono RPC (happy paths + errors + contract + pagination) | ~20 |
| Load: Throughput + correctness | ~10 |
| Property-based: Random sequences | ~52 |
| Failure injection | ~5 |
| Financial reconciliation | ~6 |
| Time manipulation (expiry) | ~5 |
| Fuzz testing (validation) | ~4 |
| Witness test | ~4 |
| Migration safety | ~4 |
| Performance boundaries | ~4 |
| Test isolation | ~6 |
| **Total** | **~440+** |

---

Previous: [07 — API Standards](./07-api-standards.md) | Next: [08a — Unit Tests](./08a-unit-tests.md)
