# Architecture — How The System Is Designed

This document explains the architecture: what the layers are, why they're
separated, how data flows, and the tech decisions behind everything.

---

## 1. Two-Layer Architecture

The system is split into two distinct layers with a clear boundary:

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP Layer                            │
│  Routes → Validation → Middleware (idempotency, auth)   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │            Payment Service (Layer 2)              │  │
│  │                                                   │  │
│  │  • authorize()    • capture()                     │  │
│  │  • refund()       • void()       • settle()       │  │
│  │  • getPayment()   • listPayments()                │  │
│  │                                                   │  │
│  │  Owns: payment state machine, business rules,     │  │
│  │        idempotency, payment records               │  │
│  │                                                   │  │
│  │  Depends on: Ledger Service ↓                     │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │ calls                         │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │            Ledger Service (Layer 1)               │  │
│  │                                                   │  │
│  │  • postTransaction()   • getBalance()             │  │
│  │  • getEntries()        • getTransactionHistory()  │  │
│  │                                                   │  │
│  │  Owns: accounts, entries, transactions,           │  │
│  │        balance computation, balance invariants    │  │
│  │                                                   │  │
│  │  Depends on: Database only                        │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                    PostgreSQL                           │
└─────────────────────────────────────────────────────────┘
```

### Why Two Layers?

**Separation of concerns:**
- The ledger doesn't know what a "payment" is. It just knows accounts, debits,
  and credits. It enforces that every transaction balances.
- The payment service doesn't know how ledger entries work. It just says "move
  $100 from account A to account B" and the ledger handles it.

**The ledger is reusable.** If you later add subscriptions, payouts, or wallet
top-ups, they all use the same ledger. You don't rebuild accounting logic for
each feature.

**Testability.** You can test the ledger in isolation (does it balance? does it
reject bad entries?) and test payments in isolation (does the state machine work?
are business rules enforced?).

---

## 2. Module Breakdown

```
src/
├── server.ts                  # App entrypoint, OpenAPIHono setup
├── config.ts                  # Environment variables, constants
├── openapi.ts                 # OpenAPI spec config, Scalar UI setup
│
├── ledger/                    # Layer 1: Financial foundation
│   ├── schema.ts              # Drizzle table definitions
│   ├── service.ts             # Core ledger operations
│   ├── types.ts               # TypeScript types
│   └── schemas.ts             # Zod + OpenAPI schemas (validation + docs)
│
├── payments/                  # Layer 2: Payment business logic
│   ├── schema.ts              # Drizzle table definitions
│   ├── service.ts             # Payment operations (authorize, capture, etc.)
│   ├── routes.ts              # OpenAPIHono route definitions
│   ├── types.ts               # TypeScript types
│   ├── state-machine.ts       # Payment status transitions
│   └── schemas.ts             # Zod + OpenAPI schemas (validation + docs)
│
├── shared/                    # Cross-cutting concerns
│   ├── db.ts                  # Drizzle client initialization
│   ├── errors.ts              # Custom error types
│   ├── money.ts               # BigInt money operations (no floating point)
│   ├── id.ts                  # ULID generation with prefixes (pay_, txn_, ent_)
│   ├── seed.ts                # System account seeding
│   ├── schemas.ts             # Shared Zod + OpenAPI schemas (errors, pagination)
│   ├── idempotency.ts         # Idempotency key middleware
│   └── middleware.ts          # Error handling, logging
│
tests/
├── unit/                      # Pure logic, no database
│   ├── money.test.ts          # BigInt arithmetic, IEEE 754 proof
│   ├── state-machine.test.ts  # Full 8×8 transition matrix
│   ├── balance-computation.test.ts  # Balance math for all account types
│   ├── validation.test.ts     # Zod schema validation
│   └── id-generation.test.ts  # ULID prefix generation
│
├── integration/               # Service + real Postgres
│   ├── ledger/
│   │   ├── post-transaction.test.ts
│   │   ├── balance-query.test.ts
│   │   ├── immutability.test.ts
│   │   └── history.test.ts
│   ├── payments/
│   │   ├── authorize.test.ts
│   │   ├── capture.test.ts
│   │   ├── void.test.ts
│   │   ├── refund.test.ts
│   │   ├── expiration.test.ts
│   │   ├── queries.test.ts
│   │   └── idempotency.test.ts
│   ├── concurrency/
│   │   ├── double-capture.test.ts
│   │   ├── capture-void-race.test.ts
│   │   ├── double-refund.test.ts
│   │   ├── parallel-payments.test.ts
│   │   └── stress.test.ts
│   └── invariants/
│       ├── god-check.test.ts
│       ├── account-integrity.test.ts
│       └── constraint-tests.test.ts
│
├── e2e/                       # Real HTTP via Hono RPC
│   ├── happy-paths.test.ts
│   ├── error-responses.test.ts
│   ├── api-contract.test.ts
│   └── pagination.test.ts
│
├── load/                      # Throughput + correctness
│   ├── harness.ts
│   ├── payment-throughput.test.ts
│   └── concurrent-lifecycle.test.ts
│
├── property/                  # Random operation sequences
│   └── random-sequences.test.ts
│
└── helpers/
    ├── setup.ts               # DB setup/teardown
    ├── factories.ts           # Test data factories
    ├── god-check.ts           # System balance verification
    ├── assertions.ts          # Custom test assertions
    └── load-harness.ts        # Percentile calculator + reporter
```

Each schema file uses Zod's `.openapi()` extension to add descriptions,
examples, and metadata. These schemas serve triple duty: runtime validation,
TypeScript types, and OpenAPI documentation.

### Rules

1. `ledger/` never imports from `payments/`
2. `payments/` can import from `ledger/` and `shared/`
3. `shared/` never imports from `ledger/` or `payments/`
4. Routes only call service functions — no business logic in routes
5. Services own all business logic — routes are thin wrappers

---

## 3. Tech Stack — Why Each Choice

### Bun (Runtime)

- Faster startup than Node.js
- Built-in TypeScript support (no build step)
- Built-in test runner (`bun:test`)
- Built-in SQLite for potential local dev (we use Postgres, but it's there)
- Native `fetch`, `crypto`, and other Web APIs

### Hono + `@hono/zod-openapi` (HTTP Framework + API Docs)

- Bun-native, designed for lightweight runtimes
- ~14kb — no bloat
- Middleware is just functions — easy to understand and test
- No decorators, no DI container, no magic
- `@hono/zod-openapi` replaces base Hono router with `OpenAPIHono`
- Routes are defined with Zod schemas attached — the same schemas that validate
  requests also generate the OpenAPI 3.1 spec automatically
- Zero drift between docs and code — the spec IS the code
- Serves interactive API docs at `/docs` (via Scalar) and raw spec at
  `/openapi.json`

### PostgreSQL (Database)

- ACID compliance — non-negotiable for financial data
- `SELECT ... FOR UPDATE` — row-level locking for concurrency
- Constraints and triggers — database-level invariant enforcement
- Battle-tested at every scale
- Rich type system (enums, arrays, JSONB)

**Two environments, one codebase:**

| Environment | Provider | Purpose |
|---|---|---|
| Local | Docker (`postgres:16-alpine`) | Development and testing |
| Remote | Supabase (managed Postgres) | Production and demo deployment |

Supabase doesn't offer a free testing environment, so all tests run against
local Docker Postgres. Drizzle abstracts the database layer — the same schemas,
migrations, and queries work in both environments. The only difference is
`DATABASE_URL`.

When using Supabase, use the **direct connection** (port 5432), not the pooled
connection (port 6543). The payment engine relies on pessimistic locking
(`SELECT ... FOR UPDATE`) and multi-statement transactions, which require a
direct connection — Supabase's connection pooler (PgBouncer in transaction mode)
can interfere with session-level features.

### Drizzle ORM (Query Builder)

- Type-safe SQL — your queries are checked at compile time
- SQL-like syntax — you see the actual query being built
- Lightweight — no query engine, no entity manager
- Raw SQL escape hatch — when you need `FOR UPDATE` or CTEs
- Migrations built-in via `drizzle-kit`
- Same driver (`drizzle-orm/postgres-js`) for both Docker and Supabase — the
  only difference is SSL configuration, handled in `db.ts`

### Zod + `@asteasolutions/zod-to-openapi` (Validation + Schema Generation)

- Runtime type checking for API inputs
- Composable schemas — build complex types from simple ones
- `.openapi()` method on every schema for adding examples and descriptions
- One schema does three jobs: validates requests, types TypeScript, documents API
- Single source of truth — change the schema, the validation AND docs update

### Scalar (API Documentation UI)

- Modern alternative to Swagger UI — cleaner, faster, better DX
- Renders the OpenAPI spec as interactive, browseable documentation
- Try-it-out functionality for testing endpoints directly from the browser
- Served at `/docs` — no separate deployment needed

---

## 4. Data Flow

### Request Lifecycle

```
Client Request
     │
     ├── GET /docs ──────────▶ Scalar UI (interactive API docs)
     ├── GET /openapi.json ──▶ Raw OpenAPI 3.1 spec
     │
     ▼
┌─── OpenAPIHono Router ┐
│                        │
│  1. Route match        │
│  2. Zod validation     │
│     (auto from schema) │
│  3. Middleware:         │
│     - Error handler    │
│     - Idempotency      │
│                        │
└────────┬───────────────┘
         │
         ▼
┌─── Route Handler ──┐
│                     │
│  Parse & validate   │
│  Call service        │
│  Format response    │
│                     │
└────────┬────────────┘
         │
         ▼
┌─── Payment Service ─┐
│                      │
│  Validate state      │
│  Apply business rules│
│  Call ledger         │
│  Update payment      │
│                      │
└────────┬─────────────┘
         │
         ▼
┌─── Ledger Service ──┐
│                      │
│  Validate entries    │
│  Begin DB transaction│
│  Insert entries      │
│  Verify balance      │
│  Commit              │
│                      │
└────────┬─────────────┘
         │
         ▼
    PostgreSQL
```

### Example: Authorize $100

```
1. POST /payments/authorize
   Headers: Idempotency-Key: abc123
   Body: { amount: 10000, currency: "USD" }

2. Idempotency middleware:
   - Read key from Idempotency-Key header
   - Check if "abc123" exists in idempotency_keys table
   - If yes → return cached response
   - If no → continue

3. Validation middleware:
   - Zod validates: amount > 0, currency is valid, key is present
   - Invalid → 400 error

4. Route handler:
   - Calls paymentService.authorize({ amount: 10000, currency: "USD" })

5. Payment service:
   - Generates payment ID (ULID)
   - Creates payment record with status AUTHORIZED
   - Calls ledgerService.postTransaction([
       { account: "customer_holds", direction: "DEBIT", amount: 10000 },
       { account: "customer_funds", direction: "CREDIT", amount: 10000 }
     ])

6. Ledger service:
   - Validates entries balance (10000 === 10000) ✓
   - BEGIN transaction
   - INSERT ledger_transaction
   - INSERT ledger_entries (2 rows)
   - COMMIT

7. Response: 201 Created
   { id: "pay_01HX...", status: "authorized", amount: 10000 }
```

---

## 5. Error Handling Strategy

### Error Types

```typescript
// Business logic errors (client's fault)
PaymentNotFoundError        → 404
InvalidStateTransitionError → 409 (Conflict)
InsufficientFundsError      → 422
InvalidAmountError          → 422
DuplicateIdempotencyError   → 409

// Validation errors (bad input)
ValidationError             → 400

// System errors (our fault)
LedgerImbalanceError        → 500 (this should NEVER happen)
DatabaseError               → 500
```

### Error Response Format

```json
{
  "error": {
    "type": "invalid_state_transition",
    "message": "Cannot capture a payment with status 'voided'",
    "details": {
      "payment_id": "pay_01HX...",
      "current_status": "voided",
      "attempted_action": "capture"
    }
  }
}
```

`error.type` and `error.message` are always present. `error.details` carries
context that varies by error type. See [05 — API Design](./05-api-design.md)
for the full error taxonomy.

---

## 6. Concurrency Model

Financial systems must handle concurrent requests safely. Our approach:

### Pessimistic Locking (SELECT FOR UPDATE)

When modifying a payment:

```sql
BEGIN;
  SELECT * FROM payments WHERE id = $1 FOR UPDATE;
  -- Row is now locked. Other transactions wait.
  -- Validate state transition
  -- Update payment status
  -- Create ledger entries
COMMIT;
-- Lock released
```

This prevents:
- Two concurrent captures on the same authorization
- A refund and a void racing on the same payment
- Double-spending from concurrent requests

### Why Not Optimistic Locking?

Optimistic locking (version column + retry on conflict) works for low-contention
scenarios. But for payments:
- A failed attempt still briefly created invalid state
- Retries add latency for the customer
- The window for errors is larger

Pessimistic locking is simpler, safer, and the right tool for financial data.

---

## 7. What We're NOT Building (And Why)

| Omitted | Reason |
|---|---|
| Authentication/Authorization | Separate concern. Would distract from the payment logic. |
| Rate limiting | Important but not core. Easy to add later. |
| Webhook delivery system | Would need a queue, retry logic, and delivery tracking. Good v2 feature. |
| Multi-tenant isolation | Adds complexity without teaching new payment concepts. |
| Real bank integration | Not the point. Our mock is sufficient to demonstrate the architecture. |
| Frontend | The API is the product. A UI adds no engineering signal. |

These are all important in production. But this project is about demonstrating
that you understand **how money moves and how to track it correctly**. Everything
else is infrastructure.

---

Previous: [02 — Payment Lifecycle](./02-payment-lifecycle.md) | Next: [04 — Data Model](./04-data-model.md)
