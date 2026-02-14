# CLAUDE.md — Payment Engine

## What This Is

A production-grade payment processing engine with a double-entry ledger. Handles
authorize, capture, settle, void, refund — backed by an immutable accounting
ledger that tracks every cent.

**This project is built with strict TDD (Test-Driven Development).** The docs
are the complete implementation spec. Tests are written FIRST from the doc spec,
then code is written to make them pass. No implementation without a failing test.
No exceptions. See `docs/14-development-flow.md` for the full methodology.

## Stack

- **Runtime:** Bun
- **Framework:** Hono + `@hono/zod-openapi`
- **Database:** PostgreSQL (Docker local, Supabase production)
- **ORM:** Drizzle
- **Validation:** Zod (also generates OpenAPI 3.1 spec)
- **API Docs:** Scalar at `/docs`
- **Testing:** bun:test
- **Linter/Formatter:** Biome

## Commands

```bash
bun install                    # Install dependencies
docker compose up -d           # Start local Postgres
bun run db:migrate             # Run Drizzle migrations
bun run db:seed                # Seed 5 system accounts
bun run dev                    # Start dev server
bun run start                  # Start production server
bun test                       # Run all tests
bun test --bail                # Stop on first failure
```

## Architecture

Two-layer design. Ledger (Layer 1) knows nothing about payments. Payments
(Layer 2) calls the ledger. No circular imports.

```
payments/routes.ts  →  payments/service.ts  →  ledger/service.ts  →  shared/db.ts
                       payments/state-machine.ts
```

**Import rules:**
- `ledger/` NEVER imports from `payments/`
- `payments/` imports from `ledger/` and `shared/`
- `shared/` NEVER imports from `ledger/` or `payments/`
- Routes only call service functions — no business logic in routes

## Paradigm: Functional, Not OOP

Pure functions with explicit parameters. No classes, no `this`, no DI containers.

```typescript
// YES
export async function authorize(db: Database, params: AuthorizeParams, key: string) { ... }
export function validateTransition(current: PaymentStatus, action: string): PaymentStatus { ... }

// NO
class PaymentService { constructor(private db: Database) {} ... }
```

## Money Rules

- **All amounts are BigInt integers in the smallest currency unit** (cents for USD)
- **NEVER use floating point for money.** TypeScript `bigint` only.
- Amounts in ledger entries are always positive. Direction (DEBIT/CREDIT) determines sign.
- Fee: `fee = (captured_amount * 3n) / 100n`, `merchant_share = captured_amount - fee`
- When fee rounds to zero (amount <= 33 cents), skip fee entries entirely (CHECK constraint: amount > 0)

## Double-Entry Bookkeeping

Every financial event creates balanced ledger entries: SUM(debits) === SUM(credits).
Entries are immutable — INSERT only, no UPDATE, no DELETE. Corrections use reversing entries.

### System Accounts (seeded at startup)

| Account | Type | Increases With |
|---|---|---|
| `customer_funds` | LIABILITY | CREDIT |
| `customer_holds` | ASSET | DEBIT |
| `merchant_payable` | LIABILITY | CREDIT |
| `platform_cash` | ASSET | DEBIT |
| `platform_fees` | REVENUE | CREDIT |

### Entry Patterns

**Authorize:** DEBIT customer_holds / CREDIT customer_funds (2 entries)
**Capture:** Reverse hold (2) + charge customer split to merchant_payable and platform_fees (2 or 4) = 4 or 6 entries
**Void:** DEBIT customer_funds / CREDIT customer_holds (2 entries, mirror of auth)
**Settle:** DEBIT merchant_payable / CREDIT platform_cash (2 entries)
**Refund:** DEBIT merchant_payable + platform_fees / CREDIT customer_funds (2 or 4 entries)
**Expiry:** Same as void (2 entries)

## Payment State Machine

```
created → authorized → captured → settled → refunded
                    → voided                → partially_refunded → refunded
                    → expired
```

Terminal states: `voided`, `expired`, `refunded`. No backwards transitions.
Enforce with `validateTransition()`. Invalid transitions throw `InvalidStateTransitionError`.

## The God Check

```sql
SELECT
  SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS total_debits,
  SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS total_credits
FROM ledger_entries;
-- total_debits MUST equal total_credits. Always.
```

Run after every integration test. If this fails, stop everything.

## API Endpoints

```
POST /api/v1/payments/authorize        201  Authorize (hold funds)
POST /api/v1/payments/:id/capture      200  Capture authorized payment
POST /api/v1/payments/:id/void         200  Void authorized payment
POST /api/v1/payments/:id/settle       200  Settle captured payment
POST /api/v1/payments/:id/refund       200  Refund captured/settled payment
GET  /api/v1/payments/:id              200  Get payment
GET  /api/v1/payments                  200  List payments (cursor pagination)
GET  /api/v1/payments/:id/ledger       200  Payment's ledger entries
GET  /api/v1/accounts/:id/balance      200  Account balance
GET  /health                           200  Health check
GET  /docs                                  Scalar API docs
GET  /openapi.json                          OpenAPI 3.1 spec
```

All mutations require `Idempotency-Key` header. All responses include `X-Request-ID`.

## API Conventions

- JSON only (`application/json`)
- snake_case in API, camelCase in TypeScript
- Resource IDs: prefixed ULIDs (`pay_`, `txn_`, `ent_`)
- Cursor pagination (not offset): `?limit=20&cursor=pay_01HW...`
- Responses include `"object"` field for type identification
- Errors: `{ error: { type, message, details? } }`

## Error Types

| Type | HTTP | When |
|---|---|---|
| `validation_error` | 400 | Bad input |
| `not_found` | 404 | Resource missing |
| `invalid_state_transition` | 409 | Wrong payment status for action |
| `idempotency_conflict` | 409 | Key reused with different params |
| `invalid_amount` | 422 | Amount exceeds limit |
| `internal_error` | 500 | Bug (should never happen) |

## Concurrency

Pessimistic locking: `SELECT ... FOR UPDATE` on the payment row inside a
transaction. Second concurrent request waits, then sees updated state.

## Database

- **Local:** Docker `postgres:16-alpine` (dev + tests)
- **Production:** Supabase (direct connection port 5432, NOT pooled 6543)
- Drizzle ORM abstracts both — only `DATABASE_URL` changes
- Forward-only migrations (no down migrations)
- Ledger tables: no `updated_at`, no `deleted_at` (immutable)

## Development Flow (Strict TDD, Inside-Out)

**THIS PROJECT IS TEST-DRIVEN. The cycle is: Docs → Tests → Code.**

The docs (08a through 08d) define every test. The tests are the spec. The
code exists only to make tests pass. Never write implementation first.

```
1. RED    — Write a failing test from the doc spec
2. GREEN  — Write the minimum code to make it pass
3. CHECK  — Run the god check (SUM debits === SUM credits)
4. REFACTOR — Clean up — tests still green
5. CHECK  — God check again
```

### Build Phases (each gate must pass before the next begins)

1. **Phase 1: Foundation** — Schema, config, shared utilities. No tests (nothing to test).
2. **Phase 2: Ledger** — postTransaction, getBalance, immutability. ~25 tests.
3. **Phase 3: Payments** — authorize, capture, void, settle, refund, idempotency, concurrency. ~300 tests.
4. **Phase 4: API** — Hono routes, middleware, E2E tests. ~30 tests.
5. **Phase 5: Advanced** — Property-based, fuzz, reconciliation, load. ~90 tests.

### TDD Rules (Non-Negotiable)

- **Test before code.** Write test from doc spec, watch it RED, then implement.
- **God check after every mutation test.** `verifySystemBalance()` in `afterAll`.
- **No phase skipping.** Phase N gate must pass before Phase N+1 begins.
- **No mocks for financial logic.** Real Postgres always. Mocks only for time and external services.
- **Refactor only on green.** All tests passing before and after refactoring.
- **One concern per commit.** Either add a test OR make a test pass, not both.

## Commit Style

```
feat(ledger): add tests for posting balanced transactions
feat(ledger): implement postTransaction()
feat(payments): add integration tests for capture
feat(payments): implement capture with fee split
fix(payments): handle zero-fee edge case for small amounts
```

## Key Invariants

1. Every ledger transaction balances (debits = credits)
2. Ledger entries are immutable (no UPDATE/DELETE)
3. State machine transitions are enforced (no skipping, no backwards)
4. All entry amounts > 0
5. captured_amount <= authorized_amount
6. refunded_amount <= captured_amount
7. Idempotency keys honored (same key + same params = same result)
8. Concurrent ops serialized per payment (SELECT FOR UPDATE)
9. Balances are derived, never stored
10. SUM(all debits) === SUM(all credits) system-wide (the god check)
11. customer_holds = 0 after capture, void, or expiry
12. Authorization expiry enforced (7-day default, on-access in v1)

## Documentation

18 docs in `docs/`. Read in order. Each builds on the previous.
Key references:
- `docs/04-data-model.md` — Every table, column, constraint
- `docs/05-api-design.md` — Every endpoint spec
- `docs/06-invariants.md` — The 12 invariants
- `docs/08-testing-strategy.md` — Test taxonomy (08a-08d sub-docs)
- `docs/14-development-flow.md` — TDD methodology, phase gates
- `docs/18-accounting-model.md` — Industry comparison, complete money flow trace

## What NOT To Do

- Never use floating point for money
- Never UPDATE or DELETE ledger entries
- Never mock the database or ledger service in tests
- Never skip the god check after mutation tests
- Never use classes for service modules
- Never put business logic in route handlers
- Never use offset pagination
- Never store balances (derive from entries)
- Never commit secrets or .env files
