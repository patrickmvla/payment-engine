# Payment Engine

A production-grade payment processing engine with a double-entry ledger system.
Built from the ground up to demonstrate how money actually moves in fintech.

Part of the **god-complex** project collection.

---

## What This Is

A payment processor that handles the full payment lifecycle — authorization,
capture, refund, void — backed by a double-entry accounting ledger that tracks
every cent with an immutable audit trail.

This is not a toy. It implements the same patterns used by Stripe, Adyen, and
Square internally:
- Double-entry bookkeeping with balanced transactions
- Idempotent API operations (safe to retry)
- Pessimistic locking for concurrent safety
- State machine for payment lifecycle
- Integer-based money (no floating point)

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Framework | Hono + `@hono/zod-openapi` |
| Database | PostgreSQL (Docker local + Supabase production) |
| ORM | Drizzle |
| Validation | Zod (also generates OpenAPI 3.1 spec) |
| API Docs | Scalar (served at `/docs`) |
| Testing | bun:test |

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
| 15 | [Demo & Presentation](./docs/15-demo-and-presentation.md) | 5-minute CTO demo structure, CLI harness, what to show and what not to |
| 16 | [Deployment](./docs/16-deployment.md) | Fly.io hosting, Dockerfile, health checks, secrets, CI/CD, cost breakdown |
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
│   │   ├── payments/          # Payment lifecycle
│   │   ├── concurrency/       # Race conditions, locks
│   │   └── invariants/        # God check, constraints
│   ├── e2e/                   # Full HTTP via Hono RPC
│   ├── load/                  # Throughput + correctness
│   ├── property/              # Random operation sequences
│   ├── reconciliation/        # Audit trail + witness test
│   ├── fuzz/                  # Validation boundary testing
│   └── helpers/               # Setup, factories, god check
├── docs/
├── drizzle/
└── docker-compose.yml
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
bun test
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

---

Built to understand fintech from the ground up.
