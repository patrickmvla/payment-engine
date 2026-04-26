# Payment Engine

> A production-grade payment processor with a double-entry ledger.
> Authorize → capture → settle → refund, every cent balanced, every retry safe.

```
✓ 447 tests passing      unit · integration · e2e · property · fuzz · reconciliation
✓ ~3000 expect() calls   covering every invariant the spec defines
✓ God check after every  integration test: SUM(debits) === SUM(credits) — always
✓ BigInt money throughout zero floating-point arithmetic in the money path
✓ Race-safe idempotency  retry-deduplicates across all 5 mutation endpoints
✓ Multi-capture model    one auth, N partial captures, hold released once
✓ 7 documented decisions  in .bocek/vault/, each with rejected alternatives
```

**Live API:** `pending Railway deploy — see `[[2026-04-26-deployment-platform-railway]]``
**Walkthrough video:** `pending recording — see `[[2026-04-26-loom-walkthrough-content]]``
**GitHub:** you're here.

---

## What This Is

A payment processor that handles the full payment lifecycle — authorize,
capture, settle, refund, void — backed by a double-entry accounting ledger
that tracks every cent with an immutable audit trail.

This is not a toy. It implements the same patterns used by Stripe, Adyen, and
Square internally:
- Double-entry bookkeeping with balanced transactions
- Idempotent API operations (safe to retry under network failure)
- Pessimistic locking for concurrent safety (`SELECT ... FOR UPDATE`)
- State machine for payment lifecycle (8 states, 13 valid transitions)
- Integer-based money (no floating point, BigInt throughout)
- Multi-capture authorization (split-shipment / incremental fulfillment)
- Per-payment witness reconciliation (independent ledger replay)

## Hardest bug found and fixed: partial-refund double-refund

During a code review against the spec, I noticed `paymentService.refund`
accepted an `Idempotency-Key` header at the route layer but never threaded
it through to the service. The route required the key. The service ignored
it. Same was true for capture, void, and settle.

The state machine allows `partially_refunded → partially_refunded` —
necessary because real merchants issue multiple partial refunds against
one capture (item-by-item return). Without idempotency, a network retry of
a successful partial refund could **double-refund**: the second call would
see the payment in `partially_refunded` state, validate that
`refundedAmount + retryAmount ≤ capturedAmount`, and execute again —
issuing a second ledger transaction debiting `merchant_payable`. Real
money out, twice, with no error to the client.

The fix, in TDD order:

1. **Wrote 4 failing tests** asserting the idempotency contract (RED):
   same-key retry returns identical refund, no extra ledger entries,
   full-refund retry returns original 200, different-amount-same-key
   returns 409.
2. **Built a race-safe idempotency claim helper** at
   `src/shared/idempotency.ts` using `INSERT ... ON CONFLICT DO NOTHING
   RETURNING` — atomic claim, no TOCTOU window.
3. **Wired the key through every mutation** (refund, capture, void,
   settle) — signature changes across ~80 call sites in tests + factories.
4. **All 4 tests turned GREEN.** Full suite confirmed no regressions.

The same audit added 12 retry tests covering all 4 mutations and replaced
4 vacuous "retry" tests that never actually retried (test theater — they
passed by accident, not by validating the contract).

The decision and the rejected alternatives are recorded at
`.bocek/vault/2026-04-26-multi-capture-model.md` and
`.bocek/vault/2026-04-26-vitest-migration.md`.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Framework | Hono + `@hono/zod-openapi` |
| Database | PostgreSQL (Docker local + Supabase production) |
| ORM | Drizzle |
| Validation | Zod (also generates OpenAPI 3.1 spec) |
| API Docs | Scalar (served at `/docs`) |
| Testing | Vitest (correctness) + `vitest bench` (perf, in `bench/`) |

### Database Strategy

We use **two PostgreSQL environments**:

- **Docker (local)** — Development and testing. Full control over Postgres
  configuration, no cold starts, no pausing, works offline. Since Supabase
  doesn't offer a free testing environment, all tests run against a local
  Docker Postgres instance.
- **Supabase (remote)** — Production and demo deployment. Managed Postgres
  with SSL, backups, a dashboard, and connection pooling out of the box.

Drizzle ORM abstracts the database layer — the same schemas, migrations, and
queries work identically in both environments. Switching between them is just
a `DATABASE_URL` change. No conditional logic, no provider-specific code.

## Documentation

Read these in order. Each document builds on the previous one.

| # | Document | What You'll Learn |
|---|---|---|
| 01 | [Core Concepts](./docs/01-core-concepts.md) | Double-entry bookkeeping, debits/credits, ACID, idempotency — the foundations |
| 02 | [Payment Lifecycle](./docs/02-payment-lifecycle.md) | What happens when someone pays: authorize → capture → settle → refund |
| 03 | [Architecture](./docs/03-architecture.md) | Two-layer design, module structure, tech stack rationale |
| 04 | [Data Model](./docs/04-data-model.md) | Every table, every column, every constraint — and why |
| 05 | [API Design](./docs/05-api-design.md) | Every endpoint, request/response shapes, error handling |
| 06 | [Invariants](./docs/06-invariants.md) | The rules that must never break — and how they're enforced |
| 07 | [API Standards](./docs/07-api-standards.md) | Versioning, pagination, rate limiting, tracing, error taxonomy, currency handling |
| 08 | [Testing Strategy](./docs/08-testing-strategy.md) | Unit/integration/e2e split, concurrency tests, the god check |
| 09 | [Observability](./docs/09-observability.md) | Structured logging, what to log, what never to log, request tracing |
| 10 | [Security](./docs/10-security.md) | Input validation, injection prevention, PII handling, OWASP awareness |
| 11 | [Development Guide](./docs/11-development-guide.md) | Local setup, Docker, migrations, adding endpoints, troubleshooting |
| 12 | [Glossary](./docs/12-glossary.md) | Every financial and technical term defined |
| 13 | [Database Connection Strategy](./docs/13-database-connection-strategy.md) | Connection architecture, pool sizing, isolation levels, resilience, environment guardrails |
| 14 | [Development Flow](./docs/14-development-flow.md) | TDD inside-out methodology, phase gates, dependency graph, the rules |
| 15 | [Demo & Presentation](./docs/15-demo-and-presentation.md) | *(superseded — see `.bocek/vault/2026-04-26-loom-walkthrough-content.md`)* |
| 16 | [Deployment](./docs/16-deployment.md) | **Railway** + Supabase (supersedes Fly.io), Dockerfile, health checks, secrets, region pinning |
| 17 | [CI/CD](./docs/17-ci-cd.md) | GitHub Actions pipeline, test execution order, god check as deployment gate, branch protection |
| 18 | [Accounting Model](./docs/18-accounting-model.md) | Industry comparison (Stripe, TigerBeetle, Modern Treasury), complete money flow trace, fee model, edge cases |

## Project Structure

```
payment-engine/
├── src/
│   ├── server.ts              # OpenAPIHono app setup
│   ├── config.ts              # Environment config
│   ├── openapi.ts             # OpenAPI spec config, Scalar UI
│   ├── ledger/                # Layer 1: Double-entry ledger
│   │   ├── schema.ts          # Drizzle table definitions
│   │   ├── service.ts         # Core ledger operations
│   │   ├── types.ts           # TypeScript types
│   │   └── schemas.ts         # Zod + OpenAPI schemas
│   ├── payments/              # Layer 2: Payment business logic
│   │   ├── schema.ts          # Drizzle table definitions
│   │   ├── service.ts         # Payment operations
│   │   ├── routes.ts          # OpenAPIHono route definitions
│   │   ├── types.ts           # TypeScript types
│   │   ├── state-machine.ts   # Status transitions
│   │   └── schemas.ts         # Zod + OpenAPI schemas
│   └── shared/                # Cross-cutting concerns
│       ├── db.ts              # Drizzle client initialization
│       ├── errors.ts          # Custom error types
│       ├── money.ts           # BigInt money operations (no floating point)
│       ├── id.ts              # ULID generation with prefixes (pay_, txn_, ent_)
│       ├── seed.ts            # System account seeding
│       ├── schemas.ts         # Shared Zod + OpenAPI schemas
│       ├── idempotency.ts     # Idempotency key middleware
│       └── middleware.ts      # Error handling, logging
├── tests/
│   ├── unit/                  # Pure logic, no database
│   ├── integration/           # Service + real Postgres
│   │   ├── ledger/            # Ledger operations
│   │   ├── payments/          # Payment lifecycle (incl. multi-capture, idempotency)
│   │   ├── concurrency/       # Race conditions, locks
│   │   └── invariants/        # God check, constraints
│   ├── e2e/                   # Full HTTP via @hono/node-server
│   ├── property/              # Seeded random operation sequences
│   ├── reconciliation/        # Audit trail + witness reconstruction
│   ├── fuzz/                  # Validation boundary testing
│   ├── failure/               # Connection drops, slow queries
│   ├── migration/             # Schema migration safety
│   ├── meta/                  # Test isolation invariants
│   └── helpers/               # Setup, factories, god check, env override
├── bench/                     # Perf measurements (vitest bench) — kept out of test runner
├── docs/                      # 18 spec docs, read in order
├── .bocek/vault/              # Architectural decisions with rejected alternatives
├── drizzle/                   # Migrations
└── docker-compose.yml         # Local Postgres on :5433
```

## Quick Start

### Local Development (Docker)

```bash
# Prerequisites: Bun, Docker

# Install dependencies
bun install

# Copy environment file
cp .env.example .env

# Start local PostgreSQL
docker compose up -d

# Run migrations
bun run db:migrate

# Seed system accounts
bun run db:seed

# Start the dev server
bun run dev

# Run tests (always against local Docker Postgres)
bun run test          # vitest run — correctness suite
bun run test:watch    # vitest — watch mode
bun run bench         # vitest bench — perf measurements (separate from test gate)
```

### Production / Demo (Supabase)

```bash
# Set DATABASE_URL to your Supabase direct connection string
# (use the direct connection on port 5432, not the pooled one on port 6543)
DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"

# Run migrations against Supabase
bun run db:migrate

# Seed system accounts
bun run db:seed

# Start the server
bun run start
```

## API Overview

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/payments/authorize` | Authorize a payment (hold funds) |
| POST | `/api/v1/payments/:id/capture` | Capture an authorized payment |
| POST | `/api/v1/payments/:id/void` | Void an authorized payment |
| POST | `/api/v1/payments/:id/settle` | Settle a captured payment (disburse to merchant) |
| POST | `/api/v1/payments/:id/refund` | Refund a captured/settled payment |
| GET | `/api/v1/payments/:id` | Get payment details |
| GET | `/api/v1/payments` | List payments |
| GET | `/api/v1/payments/:id/ledger` | View payment's ledger entries |
| GET | `/api/v1/accounts/:id/balance` | Query account balance |

## Architecture decisions

Every architectural choice is recorded in `.bocek/vault/` with the rejected
alternative and the reasoning. Quick map:

| Decision | What was chosen | Why |
|---|---|---|
| `2026-04-26-amount-wire-format` | JSON integer, cap 99,999,999 cents | Stripe-shape commitment; crypto out of scope |
| `2026-04-26-multi-capture-model` | Multi-capture v1, hold released on first capture | Marketplace + split-shipment patterns are in lane |
| `2026-04-26-amount-validation-status-code` | 400 (schema), not 422 (runtime) | Aligns with Stripe/Adyen; preserves monitoring signal |
| `2026-04-26-test-category-separation` | `tests/` for correctness, `bench/` for perf | Universal pattern across production-grade engines |
| `2026-04-26-vitest-migration` | Vitest as test runner; Bun stays as production runtime | Ecosystem alignment with Vendure/PayloadCMS/Medusa |
| `2026-04-26-deployment-platform-railway` | Railway $5/mo EU, Supabase EU-West-1 | Existing paid plan + region match |
| `2026-04-26-readme-cli-and-landing-asset` | Skip CLI; asciinema-curl hero; case-study README | Loom + Scalar /docs cover the synchronous demo surface |

---

Built to understand fintech from the ground up.
