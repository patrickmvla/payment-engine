# Phase 2: Ledger Layer — The Source of Truth

Before a single payment exists, the ledger must be provably correct. Not
"it works in my tests" correct. Provably correct — every transaction
balances, every entry is immutable, every balance is derived from first
principles. If the ledger is wrong, everything built on top of it is
a house of cards holding other people's money.

**Goal:** A complete, independently verifiable double-entry ledger service. Post
balanced transactions, query balances, enforce immutability. The ledger doesn't
know payments exist. It never will.

**Gate:** All ~25 ledger tests green. God check passes after every single test
via `afterEach`. The ledger service is a standalone, tested module with zero
payment awareness.

---

## Why the Ledger Comes First

Every tutorial builds the payment endpoints first and treats the ledger as a
storage detail. That's backwards. The ledger is not a storage detail — it IS
the product. When an auditor asks "where did this money go?", you don't point
at a `status` column on a payments table. You point at the ledger.

Inside-out means:
1. The ledger can be tested independently of payments
2. The god check works from this phase onward — every subsequent phase preserves it
3. When `paymentService.capture()` calls `ledgerService.postTransaction()`, it already works. No mocks, no stubs, no "TODO: implement"

---

## Pre-flight

- [ ] Phase 1 gate passed — server starts, `/health` 200, schema deployed
- [ ] All 5 system accounts seeded and verified
- [ ] Docker Postgres running (main + test DB migrated)
- [ ] Test helpers compile
- [ ] `bun run lint` passes

---

## TDD Sequence

Eleven steps. Each odd step writes failing tests, each even step makes them
pass. The god check runs in `afterEach` of every test file — not at the end,
not occasionally, EVERY test.

```
Step 1:  Write tests for posting balanced transactions    → RED (postTransaction doesn't exist)
Step 2:  Implement postTransaction()                      → GREEN
Step 3:  Write tests for rejection of invalid transactions → RED
Step 4:  Implement validation in postTransaction()         → GREEN
Step 5:  Write tests for immutability enforcement          → RED
Step 6:  Verify database triggers block UPDATE/DELETE       → GREEN
Step 7:  Write tests for balance queries                   → RED
Step 8:  Implement getBalance()                            → GREEN
Step 9:  Write tests for transaction history               → RED
Step 10: Implement getTransactionsByReference()             → GREEN
Step 11: Run god check across all tests                    → PASS (SUM debits === SUM credits)
```

---

## 1. The Service — Three Functions, Zero Awareness

**File:** `src/ledger/service.ts`

Three functions. Pure functional — `db` is an explicit parameter. No classes,
no `this`. Exported as a `ledgerService` namespace object. The ledger knows
nothing about payments, fees, state machines, or captures. It knows about
accounts, entries, debits, and credits. That's it.

```typescript
export const ledgerService = {
  postTransaction,   // Post a balanced set of entries atomically
  getBalance,        // Derive an account balance from entries
  getTransactionsByReference,  // Audit trail by reference
};
```

### 1a. `postTransaction(db, input) → TransactionResult`

The core write path. Everything financial flows through this function.

**What it does:**
1. Validates minimum 2 entries (single-entry transactions cannot balance)
2. Validates `SUM(debits) === SUM(credits)` **before touching the database**
3. Validates all referenced accounts exist (bad account → clear error, not FK violation)
4. Generates `txn_` prefixed ULID for the transaction
5. Generates `ent_` prefixed ULID for each entry
6. Inserts transaction + entries inside `db.transaction()` — atomic or nothing

**What it rejects:**
- Empty entries: `"Transaction requires at least 2 entries"` (count: 0)
- Single entry: `"Transaction requires at least 2 entries"` (count: 1)
- Unbalanced: `"Transaction is unbalanced: debits=X, credits=Y"` (with diagnostic amounts)
- Bad account: `"Account 'nonexistent_account' not found"` (with account_id in details)

The validation order matters. Check the structure first (entry count), then the
math (balance), then the database (account existence). Fail fast on the cheapest
check.

### 1b. `getBalance(db, accountId) → bigint`

The core read path. Every balance in the system is derived from this function.
Balances are never stored — always computed from entries.

**The accounting equation:**
- **Debit-normal** accounts (asset, expense): `balance = SUM(debits) - SUM(credits)`
- **Credit-normal** accounts (liability, revenue, equity): `balance = SUM(credits) - SUM(debits)`

Getting the sign wrong inverts every balance in the system. A customer who
deposited $100 would show -$100. A merchant owed $500 would show -$500.
The single `isDebitNormal` branch is the most important conditional in the
entire codebase.

```sql
SELECT
  COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS total_debits,
  COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS total_credits
FROM ledger_entries
WHERE account_id = $1
```

Throws `ValidationError` if the account doesn't exist.

### 1c. `getTransactionsByReference(db, referenceType, referenceId) → TransactionResult[]`

The audit trail. When Phase 3 creates payments, every operation (authorize,
capture, void, refund, settle) posts a transaction with `referenceType: "payment"`
and `referenceId: "pay_..."`. This function retrieves that complete history.

- Filters by `referenceType` AND `referenceId`
- Returns transactions in chronological order (`ORDER BY created_at ASC`)
- Each transaction includes its entries
- Returns empty array for non-existent references (not an error — no history is valid history)

---

## 2. Types — The Contract

**File:** `src/ledger/types.ts`

```typescript
// What goes in
export interface EntryInput {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
}

export interface TransactionInput {
  description: string;
  referenceType?: string;   // "payment", etc.
  referenceId?: string;     // "pay_01HX...", etc.
  entries: EntryInput[];
}

// What comes out
export interface EntryResult {
  id: string;               // ent_01HX...
  transactionId: string;    // txn_01HX...
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
  createdAt: Date;
}

export interface TransactionResult {
  id: string;               // txn_01HX...
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
  entries: EntryResult[];
}
```

`EntryInput` has 3 fields. `EntryResult` has 6. The delta is generated state:
`id`, `transactionId`, `createdAt`. This is the pattern — inputs are minimal,
outputs are complete.

---

## 3. Integration Tests — Posting Balanced Transactions (5 tests)

**File:** `tests/integration/ledger/post-transaction.test.ts`
**Source:** Doc 08b, Section 1a

Every ledger test file uses the same setup pattern. Shown once here, referenced
everywhere after:

```typescript
let db: Awaited<ReturnType<typeof setupTestDB>>;

beforeAll(async () => { db = await setupTestDB(); });
afterAll(async () => { await teardownTestDB(); });
afterEach(async () => {
  await verifySystemBalance(getTestSQL());   // God check. Every. Single. Test.
  await cleanBetweenTests();
});
```

The god check in `afterEach` is not optional. It's not a "run it at the end"
thing. Every test that modifies the ledger gets verified immediately. If a test
creates money or destroys money, we know within milliseconds — not three phases
later when someone notices the reconciliation is off.

**The tests:**

- [ ] Creates a two-entry balanced transaction — `txn_` prefix, 2 entries, `assertEntriesBalance` passes
- [ ] Creates a multi-entry transaction with fee split — 3 entries, debits and credits both sum to 10000n
- [ ] Creates a transaction with reference links — `referenceType` and `referenceId` preserved for audit trail
- [ ] Accepts the minimum amount of 1 cent — 1n, the smallest representable amount
- [ ] Accepts a large amount without overflow — 99999999n ($999,999.99), BigInt handles it

---

## 4. Integration Tests — Rejection of Invalid Transactions (6 tests)

**File:** `tests/integration/ledger/post-transaction.test.ts` (continued)
**Source:** Doc 08b, Section 1b

Every rejection test verifies the error type AND the message pattern.
`.rejects.toThrow()` alone proves nothing — the service could be throwing a
`TypeError` from a null dereference and the test would still pass. We match the
message to prove the rejection was intentional.

- [ ] Rejects unbalanced transaction where debits exceed credits — `/balance|unbalanced/i`
- [ ] Rejects unbalanced transaction where credits exceed debits — same pattern, different direction
- [ ] Rejects a transaction with a single entry — `/entries|balance|minimum/i`
- [ ] Rejects a transaction with empty entries — `/entries|empty|required/i`
- [ ] Rejects a transaction referencing a non-existent account — `/account|not found|exist/i`
- [ ] Failed transaction leaves zero entries — atomicity. After a failed unbalanced insert, both `customer_holds` and `customer_funds` balances are 0n. The `db.transaction()` rollback left no trace.

That last test is critical. It proves atomicity isn't aspirational — it's
enforced. A partial write (transaction created, entries failed) would corrupt
the entire system. The test proves it can't happen.

---

## 5. Integration Tests — Immutability Enforcement (5 tests)

**File:** `tests/integration/ledger/immutability.test.ts`
**Source:** Doc 08b, Section 1c

The ledger is append-only. No updates, no deletes. Not "we don't do that" —
the database physically rejects it. Belt (service API), suspenders (database
triggers), and a third thing (the tests that prove both work).

- [ ] Does not expose `updateEntry` or `deleteEntry` on the service — `typeof` check against the namespace object
- [ ] Does not expose `deleteTransaction` on the service — same pattern
- [ ] `UPDATE` on `ledger_entries` is rejected by immutability trigger — raw SQL via `getTestSQL()`, matches `/immut/i`
- [ ] `DELETE` on `ledger_entries` is rejected by immutability trigger — same pattern
- [ ] Correcting a mistake uses reversal pattern — post wrong amount ($100), reverse it, post correct ($75), net balance is $75. All three transactions exist in the audit trail. Nothing was modified.

The trigger tests use `getTestSQL()` (raw postgres.js client) instead of
Drizzle because Drizzle intentionally doesn't expose mutations on immutable
tables. We need to go around the ORM to prove the database itself enforces
the rule.

The reversal test is the accounting proof. In double-entry bookkeeping, you
never erase a mistake — you record a correction. The audit trail is the sum
of everything that happened, not a snapshot of the current state. Three
transactions for a $75 hold is correct. One modified transaction is fraud.

---

## 6. Integration Tests — Balance Queries (4 tests)

**File:** `tests/integration/ledger/balance-query.test.ts`
**Source:** Doc 08b, Section 1d

The balance query tests verify that derived balances are correct. These are the
foundation that Phase 3 builds on — when `paymentService.capture()` checks if a
merchant is owed money, it calls `getBalance()`. If this is wrong, the payment
service does the wrong thing with correct logic.

- [ ] Returns the correct balance after a single transaction — both `customer_holds` (asset, debit-normal: 10000n) and `customer_funds` (liability, credit-normal: 10000n)
- [ ] Accumulates across multiple transactions — 5000 + 3000 + 2000 = 10000
- [ ] Returns zero for an untouched account — `platform_fees` with no entries
- [ ] Matches raw SQL sum of entries — service balance === manual SQL computation. This is the trust-but-verify test. The service uses the same SQL internally, but this test proves it by computing the answer independently.

**Deferred to Phase 3:** The doc (08b §1d) specifies lifecycle consistency tests
(auth + capture + refund nets to zero, auth + capture + settle balances
correctly). These require `paymentService` which doesn't exist yet. They'll
run in Phase 3 — the ledger's balance function is ready for them.

---

## 7. Integration Tests — Transaction History (5 tests)

**File:** `tests/integration/ledger/history.test.ts`
**Source:** Doc 08b, Section 1e

Transaction history is the audit trail. When a payment goes through authorize →
capture → refund, the ledger stores three separate transactions. This function
retrieves them in order, with entries grouped correctly.

- [ ] `getTransactionsByReference` returns transactions for a reference — post a transaction with `referenceType: "payment"`, query by that reference, get 1 result
- [ ] Returns empty array for non-existent reference — not an error, just empty history
- [ ] Multiple transactions for same reference are in chronological order — post 2 transactions for the same reference, verify `createdAt` ordering
- [ ] Entries are grouped per transaction — every entry's `transactionId` matches its parent transaction's `id`
- [ ] Descriptions are preserved in history — the description you wrote is the description you get back

**Deferred to Phase 3:** Lifecycle history tests (auth + capture = 2 txns, auth +
capture + refund = 3 txns, auth + capture + settle + refund = 4 txns) require
`paymentService`. The ledger's history function is ready — it just needs
something to create the history.

---

## 8. Test Infrastructure

### 8a. Setup (`tests/helpers/setup.ts`)

The setup pattern is shared across all test files. It connects to the test
database, runs migrations, seeds the 5 system accounts, and provides cleanup
functions.

- [ ] `setupTestDB()` — connects to `TEST_DATABASE_URL`, runs Drizzle migrations, seeds 5 accounts, returns `db`
- [ ] `teardownTestDB()` — truncates all data tables (`CASCADE`), closes connection pool
- [ ] `cleanBetweenTests()` — truncates data tables only (keeps accounts). Used in `afterEach` to ensure test isolation
- [ ] `getTestSQL()` — returns raw postgres.js client for direct SQL (immutability trigger tests, god check)
- [ ] Pool size: 5. Tests don't need 10+ connections. Keep it small, keep it fast
- [ ] `prepare: false` — avoids prepared statement name collisions across test runs

Why `cleanBetweenTests()` truncates in `afterEach` instead of `beforeEach`: if
a test fails mid-execution, the next test starts with a dirty database and fails
for the wrong reason. Cleaning AFTER each test means the next test always starts
clean, even after a failure.

### 8b. God Check (`tests/helpers/god-check.ts`)

Three functions. All return void on success, throw with diagnostic details on
failure. The god check is the nuclear option — if it fails, everything stops.

- [ ] `verifySystemBalance(sql)` — `SUM(debits) === SUM(credits)` across all entries. If this fails: `"GOD CHECK FAILED: System is unbalanced! Total debits: X, Total credits: Y, Difference: Z"`
- [ ] `verifyAllTransactionsBalance(sql)` — each individual transaction balances. Uses `GROUP BY transaction_id HAVING debits != credits` to find violators. Returns all offenders, not just the first
- [ ] `verifyAccountIntegrity(sql)` — every account's balance is computable from its entries using the correct accounting convention (debit-normal vs credit-normal)

### 8c. Assertions (`tests/helpers/assertions.ts`)

Purpose-built assertion functions that check the things that matter.

- [ ] `assertEntriesBalance(entries)` — debits sum === credits sum. Used in every test that creates a transaction
- [ ] `assertPaymentConsistency(payment)` — all amount fields non-negative, captured ≤ authorized, refunded ≤ captured. Ready for Phase 3
- [ ] `assertErrorResponse(body, type, status?)` — error shape matches `{ error: { type, message } }`. Ready for Phase 4

### 8d. Factories (`tests/helpers/factories.ts`)

Still stubs in Phase 2. They throw `"Not implemented until Phase 3"`. This is
intentional — Phase 2 tests use `ledgerService.postTransaction()` directly. The
factories exist so that Phase 3 tests can call `createAuthorizedPayment(db)` and
get a real payment against real Postgres.

---

## 9. Schema — The Tables

### 9a. Accounts

```
accounts
├── id         TEXT PRIMARY KEY     ("customer_funds", "customer_holds", etc.)
├── name       TEXT NOT NULL        ("Customer Funds", "Customer Holds", etc.)
├── type       TEXT NOT NULL        CHECK IN ('asset', 'liability', 'equity', 'revenue', 'expense')
├── currency   TEXT NOT NULL        DEFAULT 'USD'
└── created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Readable IDs, not ULIDs. `customer_funds` is clearer than `acc_01HX...` when
you're debugging at 2am.

### 9b. Ledger Transactions

```
ledger_transactions
├── id             TEXT PRIMARY KEY  (txn_01HX...)
├── description    TEXT NOT NULL     ("Authorize payment pay_01HX...", etc.)
├── reference_type TEXT              ("payment" — nullable for standalone transactions)
├── reference_id   TEXT              ("pay_01HX..." — nullable)
└── created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

No `updated_at`. No `deleted_at`. These columns don't exist because these
operations don't exist. The schema enforces the invariant.

### 9c. Ledger Entries

```
ledger_entries
├── id             TEXT PRIMARY KEY  (ent_01HX...)
├── transaction_id TEXT NOT NULL     FK → ledger_transactions(id)
├── account_id     TEXT NOT NULL     FK → accounts(id)
├── direction      TEXT NOT NULL     CHECK IN ('DEBIT', 'CREDIT')
├── amount         BIGINT NOT NULL   CHECK > 0 (positive_amount constraint)
└── created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

`amount` is always positive. Direction determines sign. An entry of
`{ direction: "DEBIT", amount: 10000n }` is +10000 for asset accounts and
-10000 for liability accounts. The sign is derived from `(direction, account_type)`,
never stored.

**Indexes:** `idx_entries_account` on `account_id`, `idx_entries_transaction` on
`transaction_id`. Balance queries hit the account index. History queries hit the
transaction index.

No `updated_at`. No `deleted_at`. Same reason as transactions — the operations
that would need these columns are illegal.

### 9d. Immutability Triggers

Database triggers on both `ledger_transactions` and `ledger_entries` that raise
exceptions on `UPDATE` and `DELETE`. The error message matches `/immut/i` which
the tests assert against.

This is the database-level backstop. Even if someone bypasses the service layer
(raw SQL, database migration, admin panel), the triggers prevent modification.
The audit trail is tamper-proof at the storage layer.

---

## 10. File Structure

```
src/ledger/
├── schema.ts        # Drizzle schema: accounts, ledger_transactions, ledger_entries
├── service.ts       # postTransaction, getBalance, getTransactionsByReference
└── types.ts         # EntryInput, TransactionInput, EntryResult, TransactionResult

tests/integration/ledger/
├── post-transaction.test.ts   # 11 tests (5 posting + 6 rejection)
├── immutability.test.ts       # 5 tests
├── balance-query.test.ts      # 4 tests
└── history.test.ts            # 5 tests

tests/helpers/
├── setup.ts         # setupTestDB, teardownTestDB, cleanBetweenTests, getTestSQL
├── god-check.ts     # verifySystemBalance, verifyAllTransactionsBalance, verifyAccountIntegrity
├── assertions.ts    # assertEntriesBalance, assertPaymentConsistency, assertErrorResponse
└── factories.ts     # Stubs (Phase 3)
```

---

## 11. Import Architecture

```
ledger/service.ts
  ├── ledger/schema.ts     (table definitions)
  ├── ledger/types.ts      (TypeScript interfaces)
  ├── shared/db.ts         (Database type)
  ├── shared/errors.ts     (ValidationError)
  └── shared/id.ts         (generateId)
```

The arrow points one direction: down and into `shared/`. The ledger never
imports from `payments/`. Not now, not in Phase 3, not ever. If it did, the
architecture would be wrong — the foundation can't depend on the thing built
on top of it.

---

## 12. Commit Strategy

One concern per commit. Tests or implementation, never both.

```
feat(ledger): add tests for posting balanced transactions (5 tests)
feat(ledger): implement postTransaction()
feat(ledger): add tests for rejection of invalid transactions (6 tests)
feat(ledger): implement transaction validation
feat(ledger): add tests for immutability enforcement (5 tests)
feat(ledger): verify immutability triggers
feat(ledger): add tests for balance queries (4 tests)
feat(ledger): implement getBalance()
feat(ledger): add tests for transaction history (5 tests)
feat(ledger): implement getTransactionsByReference()
```

The git log reads like a narrative. Any regression is traceable to a single
commit. `git bisect` works because each commit changes one thing.

---

## 13. Final Gate Checklist

- [ ] All ~25 integration tests green (`bun run test:integration`)
- [ ] God check passes after every test (`verifySystemBalance` in `afterEach`)
- [ ] Every individual transaction balances (`verifyAllTransactionsBalance`)
- [ ] Immutability triggers block UPDATE and DELETE on ledger tables
- [ ] Balance computation respects account type (debit-normal vs credit-normal)
- [ ] `postTransaction` is atomic — failed inserts leave zero entries
- [ ] Transaction history returns chronological order
- [ ] No `updated_at` or `deleted_at` on ledger tables — the columns don't exist
- [ ] Ledger service has zero payment awareness (no imports from `payments/`)
- [ ] Ledger service exports exactly 3 functions: `postTransaction`, `getBalance`, `getTransactionsByReference`
- [ ] `bun run lint` passes
- [ ] `bun test --bail` exits 0

When this gate passes, the ledger is complete. Not "good enough." Complete. Every
transaction balances. Every entry is immutable. Every balance is derived. The
foundation is solid. Now Phase 3 can build on it without ever wondering if
`postTransaction()` actually works.

---

Previous: [Phase 1 — Foundation](./phase-1-foundation.md) | Next: [Phase 3 — Payment Layer](./phase-3-payments.md)
