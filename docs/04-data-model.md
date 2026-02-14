# Data Model — Every Table, Every Column, Every Reason

Nothing in this schema is arbitrary. Every table, column, and constraint exists
because a real financial system needs it. This document explains what AND why.

---

## Overview

```
┌─────────────────────┐       ┌──────────────────────────┐
│     accounts        │       │    idempotency_keys      │
├─────────────────────┤       ├──────────────────────────┤
│ id                  │       │ key                      │
│ name                │       │ resource_type            │
│ type                │       │ resource_id              │
│ currency            │       │ response_code            │
│ created_at          │       │ response_body            │
└────────┬────────────┘       │ created_at               │
         │ 1:N                │ expires_at               │
         │                    └──────────────────────────┘
┌────────▼────────────┐
│   ledger_entries    │       ┌──────────────────────────┐
├─────────────────────┤       │       payments           │
│ id                  │       ├──────────────────────────┤
│ transaction_id  ────┼──┐    │ id                       │
│ account_id          │  │    │ status                   │
│ direction           │  │    │ amount                   │
│ amount              │  │    │ currency                 │
│ created_at          │  │    │ authorized_amount        │
└─────────────────────┘  │    │ captured_amount          │
                         │    │ refunded_amount          │
┌────────────────────────▼┐   │ description              │
│  ledger_transactions    │   │ metadata                 │
├─────────────────────────┤   │ idempotency_key          │
│ id                      │   │ created_at               │
│ description             │   │ updated_at               │
│ reference_type          │   │ expires_at               │
│ reference_id            │   └──────────────────────────┘
│ created_at              │
└─────────────────────────┘
```

---

## Table: `accounts`

The buckets where money sits. These are created at system initialization and
rarely change.

```sql
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,           -- e.g., "customer_funds"
  name        TEXT NOT NULL,              -- Human-readable: "Customer Funds"
  type        TEXT NOT NULL,              -- "asset" | "liability" | "revenue" | "expense"
  currency    TEXT NOT NULL DEFAULT 'USD',-- ISO 4217 currency code
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
```

| Column | Type | Why |
|---|---|---|
| `id` | TEXT | Readable IDs like `customer_funds` instead of UUIDs. These are system accounts, not user-generated. Easier to reference in code and debug. |
| `name` | TEXT | Human label for admin/debugging. |
| `type` | TEXT | Determines debit/credit behavior. Assets and expenses increase with debits. Liabilities, equity, and revenue increase with credits. The five types form the fundamental accounting equation: Assets = Liabilities + Equity + (Revenue - Expenses). Get this wrong and your balances are inverted. |
| `currency` | TEXT | Each account holds one currency. Multi-currency = separate accounts per currency. No mixing USD and EUR in one account. |
| `created_at` | TIMESTAMP | Audit trail. When was this account established? |

**Why not auto-increment IDs?** — Account IDs are referenced throughout the
codebase. `"customer_funds"` is self-documenting. `42` is not.

### Seed Data

These accounts are created during migration/setup:

```
customer_funds      LIABILITY    -- Money customers have deposited with us
customer_holds      ASSET        -- Authorized but uncaptured funds
merchant_payable    LIABILITY    -- Money we owe to merchants
platform_cash       ASSET        -- Our operating funds
platform_fees       REVENUE      -- Fees we've earned
```

---

## Table: `ledger_transactions`

Groups related ledger entries into an atomic financial event.

```sql
CREATE TABLE ledger_transactions (
  id              TEXT PRIMARY KEY,       -- ULID: sortable, unique
  description     TEXT NOT NULL,          -- e.g., "Authorize $100.00 for pay_01HX..."
  reference_type  TEXT,                   -- "payment", "refund", "adjustment"
  reference_id    TEXT,                   -- ID of the payment/refund this relates to
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
```

| Column | Type | Why |
|---|---|---|
| `id` | TEXT (ULID) | ULIDs are time-sortable. You can query "all transactions today" without a date filter. Globally unique without coordination. |
| `description` | TEXT | Human-readable description of what happened. Format: `"{Action} ${amount} for {payment_id}"`. For refunds with a reason, the reason is appended: `"Refund $30.00 for pay_01HX...: customer_request"`. This is where refund reasons live — not as a separate column on the payments table. Essential for debugging and audit. |
| `reference_type` + `reference_id` | TEXT | Links back to the business event that caused this transaction. "This ledger transaction exists because of payment X." Without this, the ledger is correct but unexplainable. |
| `created_at` | TIMESTAMP | Immutable. Once created, never changes. |

**No `updated_at`** — Ledger transactions are immutable. If there's nothing to
update, there's no update timestamp.

---

## Table: `ledger_entries`

The actual debit and credit lines. This is the heart of the system.

```sql
CREATE TABLE ledger_entries (
  id              TEXT PRIMARY KEY,       -- ULID
  transaction_id  TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  direction       TEXT NOT NULL,          -- "DEBIT" | "CREDIT"
  amount          BIGINT NOT NULL,        -- Always positive. Direction determines sign.
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Critical: enforce that amount is always positive
ALTER TABLE ledger_entries ADD CONSTRAINT positive_amount CHECK (amount > 0);

-- Index for balance queries: "sum all entries for account X"
CREATE INDEX idx_entries_account ON ledger_entries(account_id);

-- Index for transaction lookups: "show me all entries in transaction Y"
CREATE INDEX idx_entries_transaction ON ledger_entries(transaction_id);
```

| Column | Type | Why |
|---|---|---|
| `id` | TEXT (ULID) | Unique identifier for each entry. |
| `transaction_id` | TEXT (FK) | Groups entries together. All entries in a transaction must balance. |
| `account_id` | TEXT (FK) | Which account this entry affects. |
| `direction` | TEXT | `DEBIT` or `CREDIT`. Stored as a string, not a boolean, because it's self-documenting and less error-prone than `is_debit: true`. |
| `amount` | BIGINT | **Always positive.** The direction tells you the sign. This prevents confusion: is -100 a credit or a correction? With our model, 100 + CREDIT is unambiguous. |
| `created_at` | TIMESTAMP | When this entry was recorded. Immutable. |

### Why BIGINT, Not DECIMAL?

- `DECIMAL` invites fractional amounts. Money in the smallest unit is always a
  whole number.
- `BIGINT` is faster for arithmetic operations.
- Application code uses `bigint` (TypeScript) — no type conversion needed.
- Range: up to 9.2 quintillion cents. That's $92 quadrillion. Enough.

### Why No `updated_at` or `deleted_at`?

**Ledger entries are immutable.** No updates. No deletes. Ever. Adding these
columns would imply they could change, which violates the core invariant.

---

## Table: `payments`

The business-level view of a payment. While the ledger tracks money movement,
this table tracks the payment lifecycle.

```sql
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,      -- ULID
  status            TEXT NOT NULL,         -- State machine state
  amount            BIGINT NOT NULL,       -- Original requested amount
  currency          TEXT NOT NULL,         -- ISO 4217
  authorized_amount BIGINT NOT NULL DEFAULT 0,  -- How much was authorized
  captured_amount   BIGINT NOT NULL DEFAULT 0,  -- How much was captured
  refunded_amount   BIGINT NOT NULL DEFAULT 0,  -- How much was refunded
  description       TEXT,                  -- Optional merchant description
  metadata          JSONB,                 -- Arbitrary merchant data
  idempotency_key   TEXT UNIQUE,           -- Links to idempotency_keys table
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMP              -- Authorization expiry
);

-- Index for listing payments by status
CREATE INDEX idx_payments_status ON payments(status);

-- Index for idempotency lookups
CREATE INDEX idx_payments_idempotency ON payments(idempotency_key);
```

| Column | Type | Why |
|---|---|---|
| `id` | TEXT (ULID) | Payment identifier, prefixed in the API as `pay_...` |
| `status` | TEXT | Current state machine state. See lifecycle doc for valid transitions. |
| `amount` | BIGINT | The original amount requested. Never changes after creation. |
| `currency` | TEXT | Locked at creation. Can't change currency mid-payment. |
| `authorized_amount` | BIGINT | May differ from `amount` if the bank authorized less (partial auth). |
| `captured_amount` | BIGINT | Running total of all captures. Allows partial capture. |
| `refunded_amount` | BIGINT | Running total of all refunds. Allows partial refund. Constraint: `refunded_amount <= captured_amount`. |
| `description` | TEXT | Merchant-provided description ("Order #12345"). |
| `metadata` | JSONB | Arbitrary key-value data from the merchant. We store it, we don't interpret it. |
| `idempotency_key` | TEXT (UNIQUE) | Ensures this payment was only created once. |
| `created_at` | TIMESTAMP | When the payment was first created. |
| `updated_at` | TIMESTAMP | When the payment status last changed. Unlike ledger entries, payments DO update (status changes). |
| `expires_at` | TIMESTAMP | When an authorization expires. NULL for non-authorized states. |

### Why Separate Amount Fields?

You might wonder why we have `amount`, `authorized_amount`, `captured_amount`,
and `refunded_amount` separately. Because:

```
Original request:   amount = 10000 ($100)
Bank authorized:    authorized_amount = 10000
Merchant captured:  captured_amount = 7000 ($70, partial capture)
Customer refunded:  refunded_amount = 3000 ($30, partial refund)

Current state: merchant has $40, customer got $30 back, $30 was released.
```

You can reconstruct the full story from these four numbers. With a single
"balance" field, you'd lose this context.

---

## Table: `idempotency_keys`

Prevents duplicate operations from creating duplicate financial events.

```sql
CREATE TABLE idempotency_keys (
  key            TEXT PRIMARY KEY,         -- Client-provided unique key
  resource_type  TEXT NOT NULL,            -- "payment"
  resource_id    TEXT NOT NULL,            -- The payment ID that was created
  response_code  INTEGER NOT NULL,         -- HTTP status code of original response
  response_body  JSONB NOT NULL,           -- Full original response
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMP NOT NULL        -- Keys expire after 24h
);
```

| Column | Type | Why |
|---|---|---|
| `key` | TEXT (PK) | The client-provided idempotency key. Primary key ensures uniqueness. |
| `resource_type` | TEXT | What kind of resource was created. Future-proofs for non-payment operations. |
| `resource_id` | TEXT | The ID of the resource that was created. |
| `response_code` | INTEGER | The HTTP status code returned originally. A retry should get the same status. |
| `response_body` | JSONB | The complete response body. A retry returns this exact response. |
| `created_at` | TIMESTAMP | When the key was first used. |
| `expires_at` | TIMESTAMP | Keys expire after 24 hours. After that, the same key can be reused (different request). |

### How It Works

```
Request 1: POST /authorize
  Headers: Idempotency-Key: abc
  Body: { amount: 10000, currency: "USD" }
  → Key "abc" not found
  → Process payment
  → Store result in idempotency_keys
  → Return 201 { id: "pay_01HX..." }

Request 2: POST /authorize
  Headers: Idempotency-Key: abc
  Body: { amount: 10000, currency: "USD" }
  → Key "abc" found
  → Return stored response: 201 { id: "pay_01HX..." }
  → No second payment created
```

---

## Constraints and Invariants (Database Level)

These are enforced by PostgreSQL, not just application code:

```sql
-- 1. Ledger entry amounts must be positive
ALTER TABLE ledger_entries
  ADD CONSTRAINT positive_amount CHECK (amount > 0);

-- 2. Payment amounts must be non-negative
ALTER TABLE payments
  ADD CONSTRAINT non_negative_amounts CHECK (
    amount >= 0 AND
    authorized_amount >= 0 AND
    captured_amount >= 0 AND
    refunded_amount >= 0
  );

-- 3. Refunded amount can never exceed captured amount
ALTER TABLE payments
  ADD CONSTRAINT refund_limit CHECK (refunded_amount <= captured_amount);

-- 4. Captured amount can never exceed authorized amount
ALTER TABLE payments
  ADD CONSTRAINT capture_limit CHECK (captured_amount <= authorized_amount);

-- 5. Payment status must be a valid state
--    Note: 'created' is the initial state within the authorize transaction
--    (transient — the API always returns 'authorized' or an error).
--    'settled' creates ledger entries (DEBIT merchant_payable / CREDIT
--    platform_cash) to record merchant disbursement.
ALTER TABLE payments
  ADD CONSTRAINT valid_status CHECK (
    status IN (
      'created', 'authorized', 'captured', 'settled',
      'voided', 'expired', 'refunded', 'partially_refunded'
    )
  );

-- 6. Account type must be valid (all 5 fundamental accounting types)
ALTER TABLE accounts
  ADD CONSTRAINT valid_account_type CHECK (
    type IN ('asset', 'liability', 'equity', 'revenue', 'expense')
  );

-- 7. Entry direction must be valid
ALTER TABLE ledger_entries
  ADD CONSTRAINT valid_direction CHECK (direction IN ('DEBIT', 'CREDIT'));
```

### Application-Level Invariants (Enforced in Code)

```
- SUM(debits) == SUM(credits) for every ledger_transaction
- Payment state transitions follow the state machine (no skipping states)
- Idempotency key + same request body = same response
- Idempotency key + different request body = 409 Conflict error
- No account balance goes below zero (for liability accounts)
```

---

## Indexes — Why These, Why Not More

| Index | Query It Serves |
|---|---|
| `idx_entries_account` | "What's the balance of account X?" — SUM all entries for an account. Hit constantly. |
| `idx_entries_transaction` | "Show me all entries for transaction Y." — Used when displaying a transaction's details. |
| `idx_payments_status` | "Show me all authorized payments" — Used for expiration jobs and admin queries. |
| `idx_payments_idempotency` | "Has this idempotency key been used?" — Hit on every API request. Must be fast. |

We don't add indexes speculatively. Each index slows down writes. We add them
when there's a query that needs them.

---

## Migration Strategy

Migrations are managed by `drizzle-kit`. Each migration is:
- Versioned (timestamped)
- Forward-only (no down migrations — they're dangerous with financial data)
- Reviewed before running (never auto-migrate in production)

Migration order:
1. Create `accounts` table + seed system accounts
2. Create `ledger_transactions` table
3. Create `ledger_entries` table + constraints + indexes
4. Create `payments` table + constraints + indexes
5. Create `idempotency_keys` table

---

Previous: [03 — Architecture](./03-architecture.md) | Next: [05 — API Design](./05-api-design.md)
