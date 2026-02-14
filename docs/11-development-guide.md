# Development Guide — Setting Up and Building

Everything you need to go from a fresh clone to a running payment engine.

---

## 1. Database Strategy

We use **two PostgreSQL environments**:

| Environment | Provider | Used For |
|---|---|---|
| **Local** | Docker (`postgres:16-alpine`) | Development, testing, debugging |
| **Remote** | Supabase (managed Postgres) | Production, demo deployment |

**Why both?** Supabase doesn't offer a free testing environment. Running tests
against a remote database adds latency, risks polluting production data, and
fails offline. Docker gives us a disposable, zero-cost Postgres instance for
development — full control, no pausing, no cold starts.

Drizzle ORM abstracts the database layer. The same schemas, migrations, and
queries run identically in both environments. Switching is a `DATABASE_URL`
change — no conditional logic, no provider-specific code.

---

## 2. Prerequisites

| Tool | Version | Installation |
|---|---|---|
| **Bun** | >= 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** | >= 20.0 | [docker.com](https://docs.docker.com/get-docker/) |
| **Docker Compose** | >= 2.0 | Included with Docker Desktop |
| **PostgreSQL client** (optional) | >= 15 | For direct DB access: `brew install postgresql` / `apt install postgresql-client` |

Verify:

```bash
bun --version    # should print 1.x.x
docker --version # should print Docker version 2x.x.x
```

---

## 3. Initial Setup (Local Development)

```bash
# Clone the repo
git clone <repo-url>
cd god-complex/payment-engine

# Install dependencies
bun install

# Copy environment file
cp .env.example .env

# Start local PostgreSQL via Docker
docker compose up -d

# Wait for Postgres to be ready (first time may take a few seconds)
docker compose logs -f db  # ctrl+c when you see "ready to accept connections"

# Run database migrations
bun run db:migrate

# Seed system accounts
bun run db:seed

# Start the dev server
bun run dev
```

You should see:

```
Payment Engine running on http://localhost:3000
API docs available at http://localhost:3000/docs
```

---

## 4. Project Scripts

| Script | Command | What It Does |
|---|---|---|
| `dev` | `bun run --watch src/server.ts` | Start dev server with hot reload |
| `start` | `bun run src/server.ts` | Start production server |
| `test` | `bun test` | Run all tests |
| `test:unit` | `bun test tests/unit/` | Run unit tests only |
| `test:integration` | `bun test tests/integration/` | Run integration tests |
| `test:e2e` | `bun test tests/e2e/` | Run end-to-end tests |
| `db:migrate` | `bun run drizzle-kit migrate` | Run pending migrations |
| `db:generate` | `bun run drizzle-kit generate` | Generate migration from schema changes |
| `db:seed` | `bun run src/shared/seed.ts` | Seed system accounts |
| `db:studio` | `bun run drizzle-kit studio` | Open Drizzle Studio (DB browser) |
| `db:reset` | `bun run scripts/reset-db.ts` | Drop all tables and re-migrate (dev only) |
| `lint` | `bun run biome check .` | Lint and format check |
| `format` | `bun run biome format . --write` | Auto-format code |

---

## 5. Environment Variables

```bash
# .env (local development — Docker Postgres)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_engine
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_engine_test
PORT=3000
LOG_LEVEL=info          # debug | info | warn | error
APP_VERSION=1.0.0
```

```bash
# .env (production — Supabase)
# Use the DIRECT connection (port 5432), not the pooled connection (port 6543).
# The payment engine uses pessimistic locking (SELECT FOR UPDATE) and
# multi-statement transactions, which require a direct connection.
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
PORT=3000
LOG_LEVEL=info
APP_VERSION=1.0.0
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (Docker local or Supabase direct) |
| `TEST_DATABASE_URL` | Yes (for tests) | — | Separate test database (local Docker only) |
| `DATABASE_SSL` | No | `false` | Set to `true` for Supabase/remote Postgres. Never auto-detected. |
| `DB_POOL_SIZE` | No | `10` | Connection pool size. `10` local, `15` Supabase free, `20-30` production. See [13 — Database Connection Strategy](./13-database-connection-strategy.md). |
| `APP_ENV` | No | `development` | `development`, `test`, or `production`. Controls guardrails (e.g., blocks `db:reset` in production). |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Minimum log level |
| `APP_VERSION` | No | `1.0.0` | Reported in `/health` |

> **Note:** `TEST_DATABASE_URL` always points to local Docker Postgres. Tests
> never run against Supabase — there's no free test environment, and running
> tests against a remote database adds latency and risks polluting data.

---

## 6. Connection Setup (`src/shared/db.ts`)

Both environments use the same driver: `postgres` (postgres.js) via
`drizzle-orm/postgres-js`. The only difference is SSL — Supabase requires it,
Docker doesn't. SSL is controlled by the `DATABASE_SSL` environment variable,
not auto-detected.

For the full deep-dive on connection architecture — pool sizing, isolation
levels, startup validation, graceful shutdown, environment guardrails, and
resilience — see [13 — Database Connection Strategy](./13-database-connection-strategy.md).

Quick summary:

```typescript
// src/shared/db.ts (simplified)
const client = postgres(config.DATABASE_URL, {
  ssl: config.DATABASE_SSL ? "require" : false,
  max: config.DB_POOL_SIZE,
  idle_timeout: 30,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  prepare: true,
});

export const db = drizzle(client);
```

**What does NOT change between environments:**
- Schema definitions (`schema.ts`) — pure TypeScript, generates standard SQL
- Migrations — standard PostgreSQL DDL
- All queries — `select()`, `insert()`, `where()`, `FOR UPDATE`
- Test setup — always runs against local Docker Postgres

---

## 7. Docker Compose (Local Development)

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: payment_engine
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql

volumes:
  pgdata:
```

The init script creates the test database automatically:

```sql
-- scripts/init-test-db.sql
CREATE DATABASE payment_engine_test;
```

### Docker Commands

```bash
docker compose up -d      # Start Postgres in background
docker compose down        # Stop Postgres (data preserved)
docker compose down -v     # Stop Postgres and DELETE all data
docker compose logs -f db  # Tail Postgres logs
```

---

## 8. Supabase Setup (Production / Demo)

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings → Database** and copy the **direct connection string**
   (URI format, port 5432 — not the pooled connection on port 6543)
3. Set it as `DATABASE_URL` in your `.env`
4. Run migrations: `bun run db:migrate`
5. Seed accounts: `bun run db:seed`
6. Start the server: `bun run start`

**Important:** Use the direct connection, not the pooled one. The payment
engine relies on `SELECT ... FOR UPDATE` (pessimistic locking) and
multi-statement transactions. Supabase's pooler runs PgBouncer in transaction
mode, which can interfere with session-level features.

**Free tier caveat:** Supabase pauses projects after 7 days of inactivity.
The project unpauses automatically on the next request, but there's a ~1 minute
cold start. This is fine for demos — not for production workloads.

---

## 9. Database Workflow

### Making Schema Changes

1. **Edit the Drizzle schema** in `src/ledger/schema.ts` or
   `src/payments/schema.ts`

2. **Generate a migration:**
   ```bash
   bun run db:generate
   ```
   This creates a new SQL file in `drizzle/` with the diff.

3. **Review the migration** — always read the generated SQL before running it.

4. **Run the migration:**
   ```bash
   bun run db:migrate
   ```

5. **Run on test database too:**
   ```bash
   DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate
   ```

### Inspecting the Database

```bash
# Open Drizzle Studio (web-based DB browser)
bun run db:studio

# Or connect directly with psql
psql postgres://postgres:postgres@localhost:5432/payment_engine
```

Useful queries for development:

```sql
-- See all accounts and their types
SELECT * FROM accounts;

-- Check a payment's current state
SELECT * FROM payments WHERE id = 'pay_01H...';

-- See all ledger entries for a payment
SELECT le.*, lt.description
FROM ledger_entries le
JOIN ledger_transactions lt ON le.transaction_id = lt.id
WHERE lt.reference_id = 'pay_01H...'
ORDER BY le.created_at;

-- Verify system balance (the god check)
SELECT
  SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as total_debits,
  SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as total_credits
FROM ledger_entries;

-- Account balances
SELECT
  a.id,
  a.name,
  a.type,
  COALESCE(SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE 0 END), 0) as debits,
  COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE 0 END), 0) as credits
FROM accounts a
LEFT JOIN ledger_entries le ON a.id = le.account_id
GROUP BY a.id, a.name, a.type;
```

---

## 10. Adding a New Endpoint (End-to-End)

Here's the complete workflow for adding a new endpoint. Follow these steps
exactly.

### Example: Adding `GET /api/v1/accounts`

**Step 1: Define the Zod + OpenAPI schemas**

```typescript
// src/ledger/schemas.ts
import { z } from "@hono/zod-openapi";

export const AccountResponseSchema = z.object({
  id: z.string().openapi({ example: "customer_funds" }),
  object: z.literal("account").openapi({ example: "account" }),
  name: z.string().openapi({ example: "Customer Funds" }),
  type: z.enum(["asset", "liability", "revenue", "expense"]).openapi({ example: "liability" }),
  currency: z.string().openapi({ example: "USD" }),
}).openapi("Account");

export const AccountListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(AccountResponseSchema),
}).openapi("AccountList");
```

**Step 2: Define the route**

```typescript
// src/ledger/routes.ts
import { createRoute } from "@hono/zod-openapi";

export const listAccountsRoute = createRoute({
  method: "get",
  path: "/api/v1/accounts",
  tags: ["Ledger"],
  summary: "List all accounts",
  description: "Returns all ledger accounts in the system.",
  responses: {
    200: {
      description: "List of accounts",
      content: {
        "application/json": { schema: AccountListResponseSchema },
      },
    },
  },
});
```

**Step 3: Implement the service function**

```typescript
// src/ledger/service.ts
export async function listAccounts(db: Database) {
  return await db.select().from(accounts);
}
```

**Step 4: Wire up the route handler**

```typescript
// src/ledger/routes.ts
app.openapi(listAccountsRoute, async (c) => {
  const allAccounts = await ledgerService.listAccounts(db);
  return c.json({
    object: "list" as const,
    data: allAccounts.map(a => ({
      ...a,
      object: "account" as const,
    })),
  }, 200);
});
```

**Step 5: Write tests**

```typescript
// tests/ledger/accounts.test.ts
describe("GET /api/v1/accounts", () => {
  test("returns all system accounts", async () => {
    const res = await app.request("/api/v1/accounts");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].object).toBe("account");
  });
});
```

**Step 6: Verify in docs**

Start the server and open `http://localhost:3000/docs`. Your new endpoint
should appear under the "Ledger" tag with full request/response documentation.

### Checklist for New Endpoints

- [ ] Zod + OpenAPI schema defined in `schemas.ts`
- [ ] Route defined with `createRoute()` including tags, summary, responses
- [ ] Service function implemented with business logic
- [ ] Route handler wired up (thin — just calls service and formats response)
- [ ] Tests written (happy path + error cases)
- [ ] Shows up correctly in `/docs`

---

## 11. Testing Workflow

```bash
# Run all tests
bun test

# Run a specific test file
bun test tests/payments/authorize.test.ts

# Run tests matching a pattern
bun test --grep "capture"

# Run with verbose output
bun test --verbose

# Run and bail on first failure (CI mode)
bun test --bail
```

### Test Database

Tests use `TEST_DATABASE_URL` — a separate database from development. Tests
truncate tables between runs, so your dev data is never affected.

If tests fail with connection errors:

```bash
# Make sure Postgres is running
docker compose up -d

# Make sure test database exists
psql postgres://postgres:postgres@localhost:5432/postgres \
  -c "CREATE DATABASE payment_engine_test;" 2>/dev/null || true

# Run migrations on test database
DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate
```

---

## 12. Code Style

### Formatter: Biome

We use [Biome](https://biomejs.dev/) for formatting and linting. It's fast,
opinionated, and configured once.

```bash
# Check formatting and lint
bun run biome check .

# Auto-fix
bun run biome format . --write
```

### Conventions

| Convention | Rule |
|---|---|
| File naming | `kebab-case.ts` (e.g., `state-machine.ts`) |
| Function naming | `camelCase` (e.g., `postTransaction`) |
| Type naming | `PascalCase` (e.g., `PaymentStatus`) |
| Constants | `UPPER_SNAKE_CASE` (e.g., `MAX_AMOUNT`) |
| Database columns | `snake_case` (e.g., `created_at`) |
| API fields | `snake_case` in JSON (e.g., `payment_id`) |
| Imports | Absolute from `src/` — no relative `../../` chains |

### No `any`

TypeScript `any` is banned. Use `unknown` and narrow, or fix the types.
Financial code with `any` is financial code with hidden bugs.

---

## 13. Common Tasks

### Reset Everything

```bash
docker compose down -v        # Delete database
docker compose up -d          # Recreate database
bun run db:migrate            # Run migrations
bun run db:seed               # Seed accounts
```

### Quick API Testing with curl

```bash
# Authorize a payment
curl -X POST http://localhost:3000/api/v1/payments/authorize \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ik_test_$(date +%s)" \
  -d '{"amount": 10000, "currency": "USD", "description": "Test payment"}'

# Capture (replace PAYMENT_ID)
curl -X POST http://localhost:3000/api/v1/payments/PAYMENT_ID/capture \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ik_cap_$(date +%s)"

# Get payment
curl http://localhost:3000/api/v1/payments/PAYMENT_ID

# View ledger entries
curl http://localhost:3000/api/v1/payments/PAYMENT_ID/ledger

# Check account balance
curl http://localhost:3000/api/v1/accounts/customer_funds/balance

# Health check
curl http://localhost:3000/health
```

---

## 14. Troubleshooting

| Problem | Solution |
|---|---|
| `connection refused` on port 5432 | `docker compose up -d` — Postgres isn't running |
| `database "payment_engine" does not exist` | `docker compose down -v && docker compose up -d` |
| `relation "payments" does not exist` | `bun run db:migrate` — migrations haven't run |
| `no such table: accounts` in tests | `DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate` |
| Port 3000 already in use | `PORT=3001 bun run dev` or kill the other process |
| `bun: command not found` | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| Tests pass locally but fail in CI | Check `TEST_DATABASE_URL` is set in CI environment |
| Supabase: `prepared statement already exists` | You're using the pooled connection (port 6543). Switch to direct (port 5432) |
| Supabase: project paused / connection timeout | Free tier pauses after 7 days of inactivity. Visit the dashboard to unpause |

---

Previous: [10 — Security](./10-security.md) | Next: [12 — Glossary](./12-glossary.md)
