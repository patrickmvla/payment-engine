# Phase 1: Foundation

**Goal:** A runnable project with database schema, config, and shared utilities.
No business logic. No tests (there's nothing to test yet — pure scaffolding).

**Gate:** `docker compose up -d && bun run db:migrate && bun run db:seed` succeeds.
Server starts and `/health` returns 200. All 5 system accounts exist. Test helpers
compile.

---

## Pre-flight

- [ ] Verify Bun installed (`bun --version`)
- [ ] Verify Docker installed and running (`docker --version`)
- [ ] `bun init` completed (package.json, tsconfig.json exist)

---

## 1. Project Configuration

### 1a. Dependencies
- [ ] Install runtime deps: `hono`, `@hono/zod-openapi`, `zod`, `drizzle-orm`, `postgres`, `ulid`
- [ ] Install dev deps: `drizzle-kit`, `@types/bun`, `typescript`, `@biomejs/biome`
- [ ] Install OpenAPI deps: `@asteasolutions/zod-to-openapi`, `@scalar/hono-api-reference`
- [ ] Verify all deps resolve (`bun install` clean)

### 1b. package.json Scripts
- [ ] `dev` — `bun run --watch src/server.ts`
- [ ] `start` — `bun run src/server.ts`
- [ ] `test` — `bun test`
- [ ] `test:unit` — `bun test tests/unit/`
- [ ] `test:integration` — `bun test tests/integration/`
- [ ] `test:e2e` — `bun test tests/e2e/`
- [ ] `db:migrate` — `bun run drizzle-kit migrate`
- [ ] `db:generate` — `bun run drizzle-kit generate`
- [ ] `db:seed` — `bun run src/shared/seed.ts`
- [ ] `db:studio` — `bun run drizzle-kit studio`
- [ ] `db:reset` — `bun run scripts/reset-db.ts`
- [ ] `lint` — `bun run biome check .`
- [ ] `format` — `bun run biome format . --write`

### 1c. TypeScript Config
- [ ] `tsconfig.json` — strict mode, target ESNext, module ESNext, moduleResolution bundler
- [ ] Path aliases if needed (prefer explicit imports from `src/`)

### 1d. Biome Config
- [ ] `biome.json` — formatter (tabs/spaces, line width), linter rules
- [ ] No semicolons or with semicolons — pick one, lock it

### 1e. Environment
- [ ] `.env.example` with all documented variables (see doc 11, section 5)
- [ ] `.env` created from example (gitignored)
- [ ] `.gitignore` — node_modules, .env, dist, drizzle/meta, *.sqlite

### 1f. Drizzle Config
- [ ] `drizzle.config.ts` — schema glob (`./src/**/schema.ts`), out dir (`./drizzle`), dialect postgresql
- [ ] Production migration warning (doc 13, section 9)

---

## 2. Docker & Database

### 2a. Docker Compose
- [ ] `docker-compose.yml` — `postgres:16-alpine`
- [ ] Environment: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
- [ ] Port mapping: 5432:5432
- [ ] Volume: pgdata for persistence
- [ ] Init script mount: `./scripts/init-test-db.sql` -> `/docker-entrypoint-initdb.d/`
- [ ] `docker compose up -d` starts clean

### 2b. Init Script
- [ ] `scripts/init-test-db.sql` — `CREATE DATABASE payment_engine_test;`

### 2c. Reset Script
- [ ] `scripts/reset-db.ts` — drops all tables, re-runs migrations
- [ ] Production guardrail: refuses if `APP_ENV=production`
- [ ] Localhost guardrail: refuses if `DATABASE_URL` not localhost

---

## 3. Shared Utilities (`src/shared/`)

### 3a. Config (`src/shared/config.ts`)
- [ ] Zod schema for all env vars (doc 13, section 2)
- [ ] `DATABASE_URL` — required, string
- [ ] `TEST_DATABASE_URL` — optional, string
- [ ] `DATABASE_SSL` — enum `"true"/"false"`, default `"false"`, transform to boolean
- [ ] `APP_ENV` — enum `"development"/"test"/"production"`, default `"development"`
- [ ] `PORT` — coerce number, default 3000
- [ ] `LOG_LEVEL` — enum `"debug"/"info"/"warn"/"error"`, default `"info"`
- [ ] `APP_VERSION` — string, default `"1.0.0"`
- [ ] `DB_POOL_SIZE` — coerce number, min 1, max 50, default 10
- [ ] `PLATFORM_FEE_PERCENT` — coerce number, default 3
- [ ] `AUTH_EXPIRY_DAYS` — coerce number, default 7
- [ ] Export parsed `config` object
- [ ] Crashes on invalid env at startup (Zod parse, not safeParse)

### 3b. Database Connection (`src/shared/db.ts`)
- [ ] `postgres` client with full options (doc 13, section 3):
  - ssl from `DATABASE_SSL`
  - max from `DB_POOL_SIZE`
  - idle_timeout: 30
  - connect_timeout: 10
  - max_lifetime: 1800 (30 min)
  - prepare: true
- [ ] Export `client` (raw postgres.js) and `db` (drizzle instance)
- [ ] `closeDatabase()` — drain pool with 5s timeout
- [ ] `validateDatabase()` — 4 checks (doc 13, section 4):
  - connection ping (`SELECT 1`)
  - schema tables exist (5 tables)
  - system accounts exist (5 accounts)
  - critical constraints exist (4 constraints)
- [ ] `sanitizeConnectionString()` — mask password in logs

### 3c. Logger (`src/shared/logger.ts`)
- [ ] Structured JSON logger
- [ ] Levels: debug, info, warn, error, fatal
- [ ] Includes timestamp, level, message
- [ ] No PII or connection strings in output

### 3d. ID Generation (`src/shared/id.ts`)
- [ ] Prefixed ULID generator
- [ ] `generateId("pay")` → `"pay_01HX..."`
- [ ] `generateId("txn")` → `"txn_01HX..."`
- [ ] `generateId("ent")` → `"ent_01HX..."`
- [ ] ULIDs are time-sortable and globally unique

### 3e. Money Utilities (`src/shared/money.ts`)
- [ ] All operations use `BigInt` — zero floating point
- [ ] `toCents(dollars: number): bigint` — convert dollar amount to cents (for testing convenience only)
- [ ] `toDisplayAmount(cents: bigint): string` — format for display (`"$100.00"`)
- [ ] `calculateFee(amount: bigint, feePercent: number): bigint` — integer division, truncates
- [ ] `splitAmount(amount: bigint, feePercent: number): { merchantShare: bigint, fee: bigint }` — fee + merchant share = amount exactly
- [ ] No floating point anywhere in money operations

### 3f. Error Classes (`src/shared/errors.ts`)
- [ ] Base `AppError` with `type`, `message`, `statusCode`, `details`
- [ ] `PaymentNotFoundError` — 404, type: `"not_found"`
- [ ] `InvalidStateTransitionError` — 409, type: `"invalid_state_transition"`, details: payment_id, current_status, attempted_action
- [ ] `InvalidAmountError` — 422, type: `"invalid_amount"`
- [ ] `IdempotencyConflictError` — 409, type: `"idempotency_conflict"`
- [ ] `InsufficientFundsError` — 422, type: `"insufficient_funds"`
- [ ] `LedgerImbalanceError` — 500, type: `"ledger_imbalance"` (should never reach production)
- [ ] `ValidationError` — 400, type: `"validation_error"`
- [ ] All errors serialize to the standard error response format (doc 05)

### 3g. Seed Script (`src/shared/seed.ts`)
- [ ] Idempotent — safe to run multiple times (INSERT ... ON CONFLICT DO NOTHING)
- [ ] Creates 5 system accounts:

| ID | Name | Type | Currency |
|---|---|---|---|
| `customer_funds` | Customer Funds | liability | USD |
| `customer_holds` | Customer Holds | asset | USD |
| `merchant_payable` | Merchant Payable | liability | USD |
| `platform_cash` | Platform Cash | asset | USD |
| `platform_fees` | Platform Fees | revenue | USD |

- [ ] Production guardrail: warns and waits 5s before seeding non-local DB
- [ ] Logs which accounts were created vs already existed

---

## 4. Database Schema (Drizzle)

### 4a. Accounts Table (`src/ledger/schema.ts`)
- [ ] `id` — text, primary key (readable IDs: `"customer_funds"`)
- [ ] `name` — text, not null
- [ ] `type` — text, not null, CHECK IN ('asset', 'liability', 'equity', 'revenue', 'expense')
- [ ] `currency` — text, not null, default 'USD'
- [ ] `created_at` — timestamp, not null, default now()

### 4b. Ledger Transactions Table (`src/ledger/schema.ts`)
- [ ] `id` — text, primary key (ULID)
- [ ] `description` — text, not null
- [ ] `reference_type` — text, nullable
- [ ] `reference_id` — text, nullable
- [ ] `created_at` — timestamp, not null, default now()
- [ ] No `updated_at` — immutable

### 4c. Ledger Entries Table (`src/ledger/schema.ts`)
- [ ] `id` — text, primary key (ULID)
- [ ] `transaction_id` — text, not null, FK -> ledger_transactions(id)
- [ ] `account_id` — text, not null, FK -> accounts(id)
- [ ] `direction` — text, not null, CHECK IN ('DEBIT', 'CREDIT')
- [ ] `amount` — bigint, not null, CHECK > 0 (`positive_amount`)
- [ ] `created_at` — timestamp, not null, default now()
- [ ] Index: `idx_entries_account` on account_id
- [ ] Index: `idx_entries_transaction` on transaction_id
- [ ] No `updated_at` — immutable

### 4d. Payments Table (`src/payments/schema.ts`)
- [ ] `id` — text, primary key (ULID)
- [ ] `status` — text, not null, CHECK IN valid statuses (`valid_status`)
- [ ] `amount` — bigint, not null
- [ ] `currency` — text, not null
- [ ] `authorized_amount` — bigint, not null, default 0
- [ ] `captured_amount` — bigint, not null, default 0
- [ ] `refunded_amount` — bigint, not null, default 0
- [ ] `description` — text, nullable
- [ ] `metadata` — jsonb, nullable
- [ ] `idempotency_key` — text, unique, nullable
- [ ] `created_at` — timestamp, not null, default now()
- [ ] `updated_at` — timestamp, not null, default now()
- [ ] `expires_at` — timestamp, nullable
- [ ] CHECK: `non_negative_amounts` (all amount fields >= 0)
- [ ] CHECK: `refund_limit` (refunded_amount <= captured_amount)
- [ ] CHECK: `capture_limit` (captured_amount <= authorized_amount)
- [ ] Index: `idx_payments_status` on status
- [ ] Index: `idx_payments_idempotency` on idempotency_key

### 4e. Idempotency Keys Table (`src/payments/schema.ts`)
- [ ] `key` — text, primary key
- [ ] `resource_type` — text, not null
- [ ] `resource_id` — text, not null
- [ ] `response_code` — integer, not null
- [ ] `response_body` — jsonb, not null
- [ ] `created_at` — timestamp, not null, default now()
- [ ] `expires_at` — timestamp, not null

### 4f. Immutability Triggers (migration SQL)
- [ ] Trigger on `ledger_transactions`: block UPDATE and DELETE
- [ ] Trigger on `ledger_entries`: block UPDATE and DELETE
- [ ] Both raise exceptions with clear error messages

---

## 5. Migration

- [ ] `bun run db:generate` produces `drizzle/0001_initial_schema.sql`
- [ ] Review generated SQL — all tables, constraints, indexes, triggers present
- [ ] `bun run db:migrate` applies cleanly to local Docker Postgres
- [ ] `DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate` applies to test DB
- [ ] All 5 tables exist: accounts, ledger_transactions, ledger_entries, payments, idempotency_keys
- [ ] All 4 CHECK constraints exist: positive_amount, non_negative_amounts, refund_limit, capture_limit
- [ ] All 4 indexes exist
- [ ] Immutability triggers exist on ledger tables

---

## 6. Server Entry Point

### 6a. App Setup (`src/server.ts`)
- [ ] `OpenAPIHono` instance (not base `Hono`)
- [ ] `GET /health` — returns 200 with `{ status: "ok", version, environment, timestamp }`
- [ ] OpenAPI spec at `GET /openapi.json`
- [ ] Scalar docs at `GET /docs`
- [ ] Global error handler middleware
- [ ] Validate database before binding port (`validateDatabase()`)
- [ ] Graceful shutdown on SIGTERM/SIGINT (doc 13, section 8)
- [ ] Log startup info (port, environment, sanitized DB URL)

### 6b. OpenAPI Config (`src/openapi.ts`)
- [ ] OpenAPI 3.1 spec metadata: title, version, description
- [ ] Scalar UI configuration

---

## 7. Seed & Verify

- [ ] `bun run db:seed` creates all 5 system accounts
- [ ] Running seed again is idempotent (no errors, no duplicates)
- [ ] `bun run dev` starts the server
- [ ] `curl http://localhost:3000/health` returns 200
- [ ] `curl http://localhost:3000/docs` renders Scalar UI
- [ ] `curl http://localhost:3000/openapi.json` returns valid OpenAPI spec

---

## 8. Test Helpers (Stubs)

These compile but contain no test logic yet. They're scaffolding for Phase 2+.

### 8a. Setup (`tests/helpers/setup.ts`)
- [ ] `setupTestDB()` — connects to TEST_DATABASE_URL, runs migrations, returns db
- [ ] `teardownTestDB()` — truncates all tables (CASCADE), closes connection
- [ ] `cleanDatabase()` — truncates data tables only (keeps accounts)
- [ ] Uses separate connection from app (doc 13, section 12)
- [ ] Pool size: 5 (tests don't need many connections)

### 8b. Factories (`tests/helpers/factories.ts`)
- [ ] `createAuthorizedPayment(db, overrides?)` — stub, returns placeholder
- [ ] `createCapturedPayment(db, overrides?)` — stub
- [ ] `createSettledPayment(db, overrides?)` — stub
- [ ] All accept optional overrides for amount, currency, description, metadata
- [ ] Documented: "These call real service functions against real Postgres. No mocks."

### 8c. God Check (`tests/helpers/god-check.ts`)
- [ ] `verifySystemBalance(db)` — asserts SUM(debits) === SUM(credits) across all entries
- [ ] `verifyAllTransactionsBalance(db)` — asserts each individual transaction balances
- [ ] `verifyAccountIntegrity(db)` — asserts service balance matches raw SQL for every account
- [ ] All return void on success, throw on violation with diagnostic details

### 8d. Assertions (`tests/helpers/assertions.ts`)
- [ ] `assertEntriesBalance(entries)` — asserts debit sum === credit sum
- [ ] `assertPaymentConsistency(payment)` — asserts amount fields satisfy constraints
- [ ] `assertErrorResponse(response, expectedType, expectedStatus)` — asserts error shape

---

## 9. Final Gate Checklist

- [ ] `docker compose up -d` — Postgres running
- [ ] `bun run db:migrate` — schema deployed (both main and test DB)
- [ ] `bun run db:seed` — 5 system accounts exist
- [ ] `bun run dev` — server starts without errors
- [ ] `/health` returns 200 with correct payload
- [ ] `/docs` renders interactive API documentation
- [ ] `/openapi.json` returns valid spec
- [ ] Test helpers compile (`bun build tests/helpers/setup.ts` — no type errors)
- [ ] `bun run lint` passes
- [ ] Zero business logic exists — no payment service, no ledger service
- [ ] File structure matches architecture doc (doc 03, section 2)

---

**Next:** [Phase 2 — Ledger Layer](./phase-2-ledger.md) (TDD: ~25 tests)
