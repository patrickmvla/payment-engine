# Database Connection Strategy — The Layer Everyone Gets Wrong

Most tutorials treat the database connection as a one-liner: `postgres(url)`,
done. That's fine for a blog app. For a payment engine, the connection layer is
where money gets lost, transactions get corrupted, and 3am incidents start.

This document covers how we connect to PostgreSQL, why every configuration
choice exists, and what happens when things go wrong — because in fintech, they
will.

---

## 1. Dual Environment Model

We run two PostgreSQL environments from a single codebase:

```
┌──────────────────────────────────────────────────────────┐
│                    Application Code                       │
│   schemas, queries, migrations, services — all identical │
├──────────────────────────────────────────────────────────┤
│                    Drizzle ORM                            │
│          drizzle-orm/postgres-js (same driver)           │
├──────────────┬───────────────────────────────────────────┤
│   db.ts      │   db.ts                                   │
│  ssl: false  │  ssl: "require"                           │
├──────────────┼───────────────────────────────────────────┤
│   Docker     │   Supabase                                │
│  postgres:16 │  Managed Postgres                         │
│   Local      │   Remote                                  │
│  Dev + Test  │  Production + Demo                        │
└──────────────┴───────────────────────────────────────────┘
```

### Why Not Just One?

**Supabase has no free testing environment.** If you run tests against a remote
database, you get:
- 50-200ms latency per query (vs <1ms local) — test suite goes from 10s to 10min
- Risk of polluting production data with test artifacts
- Tests fail when offline — can't develop on a plane
- Connection limits on the free tier — parallel tests exhaust them

**Docker has no production story.** It's local-only. No SSL, no backups, no
dashboard, no connection pooling infrastructure.

So we use both. Drizzle abstracts the query layer — schemas, migrations, and
all business logic are identical. The only difference lives in `db.ts`: one
configuration flag.

### The Rule

```
Tests       → always Docker (TEST_DATABASE_URL)
Development → always Docker (DATABASE_URL → localhost)
Production  → always Supabase (DATABASE_URL → supabase direct connection)
```

No exceptions. No "let me just run this one test against prod real quick."

---

## 2. Environment Configuration — Explicit, Not Magical

The naive approach:

```typescript
// DON'T DO THIS — string sniffing is fragile
const isRemote = connectionString.includes("supabase");
const ssl = isRemote ? "require" : false;
```

What happens when you use a custom domain? A different managed provider? A
Supabase URL that doesn't contain "supabase"? It breaks silently — the worst
kind of bug in a payment system.

### Our Approach: Explicit Environment Declaration

```typescript
// src/shared/config.ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection string"),
  TEST_DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  APP_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_VERSION: z.string().default("1.0.0"),
  DB_POOL_SIZE: z.coerce.number().min(1).max(50).default(10),
});

export const config = envSchema.parse(process.env);
```

```bash
# .env (local development)
APP_ENV=development
DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_engine
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_engine_test
DATABASE_SSL=false
DB_POOL_SIZE=10

# .env (production — Supabase)
APP_ENV=production
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
DATABASE_SSL=true
DB_POOL_SIZE=15
```

**Why this matters:**
- `DATABASE_SSL` is explicit. No guessing. No string matching. You set it or
  the default is safe (off for local).
- `APP_ENV` controls behavior across the entire application — not just the DB
  connection.
- `DB_POOL_SIZE` is configurable because the right value depends on your
  deployment (see Section 5).
- Zod validates everything at startup. Typo in `APP_ENV`? Process crashes
  immediately with a clear error — not 6 hours later when a payment fails.

---

## 3. The Connection (`db.ts`)

```typescript
// src/shared/db.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config";
import { logger } from "./logger";

// --- Connection Configuration ---

const connectionOptions: postgres.Options<{}> = {
  // SSL: explicit from environment, never auto-detected
  ssl: config.DATABASE_SSL ? "require" : false,

  // Pool size: see Section 5 for sizing rationale
  max: config.DB_POOL_SIZE,

  // Idle timeout: close connections sitting unused for 30s.
  // Prevents holding Postgres connections you're not using —
  // critical on Supabase where connection limits are real.
  idle_timeout: 30,

  // Connection timeout: fail fast if Postgres is unreachable.
  // A payment request waiting 30s for a connection is already failed
  // from the user's perspective.
  connect_timeout: 10,

  // Max lifetime: recycle connections every 30 minutes.
  // Guards against stale connections, memory leaks in long-lived
  // connections, and Supabase's connection resets during maintenance.
  max_lifetime: 60 * 30,

  // Prepare: named prepared statements.
  // Works with direct connections (Docker and Supabase port 5432).
  // Must be set to false if using Supabase's pooled connection (port 6543)
  // because PgBouncer in transaction mode doesn't support them.
  // We use direct connections, so this stays true for performance.
  prepare: true,

  // Transform: convert Postgres snake_case to camelCase in results.
  // We DON'T do this. Our Drizzle schemas handle the mapping.
  // Implicit transforms in the connection layer hide what's happening.
  // In financial code, explicitness wins.

  // Connection lifecycle hooks
  onnotice: (notice) => {
    logger.debug({ notice: notice.message }, "postgres_notice");
  },
};

// --- Client and Drizzle Instance ---

export const client = postgres(config.DATABASE_URL, connectionOptions);
export const db = drizzle(client);

// --- Shutdown ---

export async function closeDatabase(): Promise<void> {
  logger.info("Draining database connection pool...");
  await client.end({ timeout: 5 });
  logger.info("Database connections closed.");
}
```

### Why Every Option Is There

| Option | Value | Reason |
|---|---|---|
| `ssl` | from `DATABASE_SSL` | Explicit. Supabase requires it, Docker doesn't. Never guessed. |
| `max` | from `DB_POOL_SIZE` | See Section 5 — pool size is a tuning parameter, not a magic number. |
| `idle_timeout` | 30s | Release unused connections. Supabase free tier has limited connections. |
| `connect_timeout` | 10s | Fail fast. A payment API that hangs is worse than one that errors. |
| `max_lifetime` | 30min | Recycle connections. Guards against stale state after DB maintenance. |
| `prepare` | true | Named prepared statements for performance. Only works on direct connections. |

### What We Don't Configure (And Why)

| Option | Why Not |
|---|---|
| `transform` | Implicit column renaming hides the data shape. Drizzle handles mapping explicitly in schemas. |
| `debug` | Use structured logging (see observability doc), not query dumping to stdout. |
| `fetch_types` | Default behavior (fetch on first connect) is correct. Custom type handling adds complexity we don't need. |

---

## 4. Startup Validation — Don't Accept Payments Against a Broken Database

The server should **refuse to start** if the database isn't ready. A payment
engine that boots successfully but can't process payments is more dangerous
than one that crashes on startup — it accepts requests and then fails them.

```typescript
// src/shared/db.ts (continued)

export async function validateDatabase(): Promise<void> {
  const checks: Array<{ name: string; check: () => Promise<void> }> = [
    {
      name: "connection",
      check: async () => {
        // Can we reach Postgres at all?
        const result = await client`SELECT 1 as ping`;
        if (result[0]?.ping !== 1) throw new Error("Ping failed");
      },
    },
    {
      name: "schema",
      check: async () => {
        // Do the required tables exist?
        const tables = await client`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name IN (
            'accounts', 'ledger_transactions', 'ledger_entries',
            'payments', 'idempotency_keys'
          )
        `;
        const found = tables.map((t) => t.table_name);
        const required = [
          "accounts",
          "ledger_transactions",
          "ledger_entries",
          "payments",
          "idempotency_keys",
        ];
        const missing = required.filter((t) => !found.includes(t));
        if (missing.length > 0) {
          throw new Error(`Missing tables: ${missing.join(", ")}. Run migrations first.`);
        }
      },
    },
    {
      name: "accounts",
      check: async () => {
        // Are system accounts seeded?
        const accounts = await client`SELECT id FROM accounts`;
        const required = [
          "customer_funds",
          "customer_holds",
          "merchant_payable",
          "platform_cash",
          "platform_fees",
        ];
        const found = accounts.map((a) => a.id);
        const missing = required.filter((a) => !found.includes(a));
        if (missing.length > 0) {
          throw new Error(`Missing system accounts: ${missing.join(", ")}. Run db:seed first.`);
        }
      },
    },
    {
      name: "constraints",
      check: async () => {
        // Are critical constraints in place?
        const constraints = await client`
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_schema = 'public'
          AND constraint_name IN (
            'positive_amount', 'non_negative_amounts',
            'refund_limit', 'capture_limit'
          )
        `;
        const found = constraints.map((c) => c.constraint_name);
        const required = [
          "positive_amount",
          "non_negative_amounts",
          "refund_limit",
          "capture_limit",
        ];
        const missing = required.filter((c) => !found.includes(c));
        if (missing.length > 0) {
          throw new Error(
            `Missing database constraints: ${missing.join(", ")}. ` +
            `Schema is incomplete — migrations may have partially failed.`
          );
        }
      },
    },
  ];

  logger.info("Running database validation checks...");

  for (const { name, check } of checks) {
    try {
      await check();
      logger.info({ check: name }, "Database check passed");
    } catch (error) {
      logger.fatal({ check: name, error }, "Database validation failed");
      throw new Error(
        `Database validation failed [${name}]: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  logger.info("All database validation checks passed.");
}
```

### What This Catches

| Check | What It Prevents |
|---|---|
| `connection` | Deploying against an unreachable database. Catches wrong `DATABASE_URL`, firewall issues, Supabase project paused. |
| `schema` | Deploying before migrations have run. A common CI/CD mistake — container starts before migration job finishes. |
| `accounts` | Deploying before seed data exists. Without system accounts, the first payment will fail with a cryptic foreign key error. |
| `constraints` | Partially applied migrations. If `positive_amount` constraint is missing, the ledger can accept negative entries — silent corruption. |

### When This Runs

```typescript
// src/server.ts
import { validateDatabase } from "./shared/db";

// Validate BEFORE binding the HTTP port.
// If this fails, the process exits. No half-alive server.
await validateDatabase();

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "Payment Engine running");
});
```

The server never accepts a single request until the database is verified.
A crashed process is visible. A silently broken one is not.

---

## 5. Connection Pool Sizing — Why Not Just `max: 10`?

Most projects pick a pool size out of thin air. For a payment engine, pool size
directly affects throughput, latency, and deadlock risk.

### The Math

```
Pool size = (concurrent payment operations) + (read queries) + (headroom)
```

**What consumes a connection:**
- Every `SELECT ... FOR UPDATE` transaction holds a connection for its entire
  duration (typically 5-50ms)
- Read queries (GET /payments, GET /balance) hold a connection briefly
- The idempotency check holds a connection for the key lookup

**What happens when the pool is exhausted:**
- New requests wait in a queue for a connection
- If all connections are held by `FOR UPDATE` locks waiting on each other →
  **deadlock**
- If wait exceeds `connect_timeout` → request fails with a timeout error

### Sizing for Our Use Case

```
Docker (local dev):
  - Single developer, maybe running tests in parallel
  - Pool size: 10 (generous for local)

Supabase free tier:
  - Connection limit: ~60 direct connections
  - But other services (dashboard, Supabase Auth, Realtime) consume some
  - Safe budget for our app: ~15-20 connections
  - Pool size: 15

Supabase Pro / Production:
  - Connection limit: ~200+ (depends on compute size)
  - Pool size: 20-30 (scale based on load testing)
```

### Why This Is Configurable

```bash
DB_POOL_SIZE=10   # Local
DB_POOL_SIZE=15   # Supabase free tier
DB_POOL_SIZE=25   # Production under load
```

Hardcoding pool size means redeploying to tune it. An environment variable
means you can adjust without touching code — critical during an incident when
you discover your pool is too small (or too large and exhausting Postgres).

---

## 6. Transaction Isolation Levels — The Conversation Nobody Has

PostgreSQL supports four isolation levels. Most developers never think about
this. For a payment engine, the wrong isolation level means money moves
incorrectly under concurrency.

### PostgreSQL Isolation Levels

| Level | Dirty Reads | Non-Repeatable Reads | Phantom Reads | Performance |
|---|---|---|---|---|
| `READ UNCOMMITTED` | Possible | Possible | Possible | Fastest |
| `READ COMMITTED` | No | Possible | Possible | Fast |
| `REPEATABLE READ` | No | No | Possible (not in PG) | Medium |
| `SERIALIZABLE` | No | No | No | Slowest |

### What We Use: `READ COMMITTED` + Explicit Locking

PostgreSQL's default is `READ COMMITTED`. We keep it — but supplement it with
`SELECT ... FOR UPDATE` where needed.

**Why not `SERIALIZABLE`?**

`SERIALIZABLE` makes every transaction behave as if it ran alone. Sounds
perfect for payments, right? But:

1. **Serialization failures require retries.** PostgreSQL will abort
   transactions that conflict and return `ERROR 40001: could not serialize
   access`. Your application must catch this and retry — adding complexity.
2. **Performance drops under contention.** Every concurrent payment operation
   on the same resources triggers serialization checks.
3. **We already have explicit locks.** `SELECT ... FOR UPDATE` gives us
   exactly the isolation we need, on exactly the rows we need, without the
   overhead of full serialization.

```sql
-- Our approach: READ COMMITTED + explicit locking
BEGIN;
  -- Lock the specific payment row. Other transactions wait here.
  SELECT * FROM payments WHERE id = $1 FOR UPDATE;

  -- Safe zone: no other transaction can modify this payment.
  -- Validate state transition.
  -- Update payment status.
  -- Create ledger entries.
COMMIT;
-- Lock released. Waiting transactions proceed.
```

**Why not `REPEATABLE READ`?**

`REPEATABLE READ` prevents non-repeatable reads (re-reading a row gives the
same result within a transaction). But we don't re-read — we read once, lock,
mutate, commit. `REPEATABLE READ` would add snapshot overhead without benefit.

### Where Isolation Level Actually Matters

```
Balance queries: READ COMMITTED is fine.
  We SUM all entries for an account. Even if new entries are added
  during our SUM, the result is consistent as of the query start.

Payment mutations: READ COMMITTED + FOR UPDATE.
  We lock the payment row. No other transaction can mutate it.
  The lock provides stronger isolation than any isolation level alone.

Ledger insertions: READ COMMITTED.
  We validate balance within a transaction. The CHECK constraints
  catch any violation the application misses.
```

### The Key Insight

`SERIALIZABLE` is a global hammer. `FOR UPDATE` is a surgical scalpel. For a
payment engine, you want the scalpel — precise locking on the exact rows you're
mutating, without paying the performance cost on every query in the system.

---

## 7. Connection Resilience — What Happens When Things Break

### Failure Modes

| Failure | What Happens | How We Handle It |
|---|---|---|
| Postgres unreachable at startup | `validateDatabase()` fails → process exits → orchestrator restarts | Crash fast, don't serve broken traffic |
| Connection drops mid-transaction | `postgres.js` surfaces a connection error → transaction rolls back automatically | ACID guarantees: partial writes are impossible |
| Supabase maintenance window | Connections reset → in-flight transactions abort | Client retries with same idempotency key → gets the same result OR re-processes safely |
| Connection pool exhausted | New requests wait up to `connect_timeout` (10s) → timeout error | 503 response with Retry-After header |
| Supabase free tier pauses | First connection after pause takes ~60s → `connect_timeout` fires | Startup validation fails → process crashes → user unpauses in dashboard → restart |

### Why We Don't Add Application-Level Retries on the Connection

Some ORMs add retry logic: "if the connection fails, retry N times with
backoff." We don't, and here's why:

1. **Payment operations must not silently retry.** If an `authorize` call fails
   midway, the idempotency system handles the retry — not the connection layer.
   A connection-level retry might re-execute a partially committed transaction.

2. **`postgres.js` already handles connection recovery.** If a connection in the
   pool drops, it's replaced transparently on the next use. We don't need to
   add another layer.

3. **Fail-fast is better than fail-slow for payments.** A 500ms error response
   that the client retries with an idempotency key is better than a 30s hang
   while we retry connections internally.

### What Idempotency Gives Us for Free

When a connection drops mid-transaction:

```
1. Client sends POST /authorize { idempotency_key: "ik_abc" }
2. Transaction starts → connection drops → transaction rolls back
3. Payment was NOT created (ACID rollback)
4. Client retries:  POST /authorize { idempotency_key: "ik_abc" }
5. Key "ik_abc" not found (nothing was committed)
6. Payment processes normally
7. 201 Created
```

The idempotency system and ACID transactions together make the system
self-healing on retries. The connection layer doesn't need to be clever.

---

## 8. Graceful Shutdown — Don't Kill Transactions

When the process receives SIGTERM (deploy, scale-down, restart), we need to:

1. Stop accepting new HTTP requests
2. Wait for in-flight payment transactions to complete
3. Drain the connection pool
4. Exit cleanly

```typescript
// src/server.ts
import { closeDatabase } from "./shared/db";

const server = app.listen(config.PORT);

async function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Shutdown signal received");

  // 1. Stop accepting new connections
  server.stop();
  logger.info("Stopped accepting new connections");

  // 2. Wait for in-flight requests (Bun handles this with server.stop())
  // server.stop() waits for pending responses by default.

  // 3. Close database connections (with 5s timeout)
  await closeDatabase();

  // 4. Exit
  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
```

### Why This Matters for Payments

Without graceful shutdown:

```
1. Payment authorize starts → BEGIN transaction
2. SIGTERM arrives → process killed immediately
3. Transaction is in limbo
4. PostgreSQL detects the dead connection (after tcp_keepalive timeout)
5. Transaction rolls back automatically

Result: The payment was never created. Client gets a connection reset error.
On retry with the same idempotency key, it processes normally.
```

With graceful shutdown:

```
1. Payment authorize starts → BEGIN transaction
2. SIGTERM arrives → stop accepting new requests
3. In-flight transaction completes → COMMIT
4. Connection pool drains
5. Process exits cleanly

Result: The payment was created. Zero user-visible errors.
```

Both are correct (ACID guarantees correctness either way), but graceful
shutdown means **zero dropped requests during deployments**.

**Behind a load balancer:** In production, the process sits behind a load
balancer (nginx, ALB, etc.). The LB should health-check `/health`. When
graceful shutdown begins and the server stops accepting connections, the next
health check fails and the LB stops routing new traffic. Set the health check
interval shorter than the shutdown drain timeout (5s) to avoid sending requests
to a draining instance.

---

## 9. Environment Guardrails — Preventing Catastrophic Mistakes

One wrong `DATABASE_URL` and a `db:reset` wipes production. These guardrails
make that impossible.

### Dangerous Operations Check Environment

```typescript
// scripts/reset-db.ts
import { config } from "../src/shared/config";

if (config.APP_ENV === "production") {
  console.error("REFUSING to reset database in production environment.");
  console.error("APP_ENV is set to 'production'. This operation is blocked.");
  process.exit(1);
}

if (!config.DATABASE_URL.includes("localhost")) {
  console.error("REFUSING to reset a non-local database.");
  console.error(`DATABASE_URL points to: ${config.DATABASE_URL.split("@")[1]}`);
  console.error("Only localhost databases can be reset.");
  process.exit(1);
}

// ... proceed with reset
```

### Seed Script Warns on Non-Local Databases

```typescript
// src/shared/seed.ts
import { config } from "./config";

if (config.APP_ENV === "production") {
  console.warn("WARNING: Seeding production database.");
  console.warn("This will INSERT system accounts if they don't exist.");
  console.warn("This will NOT delete or modify existing data.");
  console.warn("Press Ctrl+C within 5 seconds to abort.");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
```

### Migration Script Confirms on Production

```typescript
// drizzle.config.ts
import { config } from "./src/shared/config";

if (config.APP_ENV === "production") {
  console.warn("PRODUCTION MIGRATION");
  console.warn(`Target: ${config.DATABASE_URL.split("@")[1]}`);
  console.warn("Ensure you have reviewed the migration SQL.");
}

export default {
  schema: "./src/**/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
  },
};
```

### Connection String Sanitization in Logs

Never log the full connection string — it contains the password.

```typescript
function sanitizeConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid connection string]";
  }
}

logger.info(
  { database: sanitizeConnectionString(config.DATABASE_URL) },
  "Connecting to database"
);
// Output: { database: "postgres://postgres:***@localhost:5432/payment_engine" }
```

---

## 10. Supabase-Specific Considerations

### Direct Connection vs Pooled Connection

Supabase offers two connection endpoints:

| | Direct | Pooled |
|---|---|---|
| Port | 5432 | 6543 |
| Protocol | Raw Postgres | PgBouncer (transaction mode) |
| Prepared statements | Yes | No |
| `SELECT FOR UPDATE` | Full support | Works (transaction mode) |
| Session variables | Yes | No (reset between transactions) |
| Advisory locks | Yes | No (session-based, reset on return to pool) |
| Connection limit | ~60 (free tier) | Higher (shared pool) |

**We use direct (port 5432).** The payment engine needs prepared statements
for performance and could use advisory locks for idempotency in the future.
The connection limit is manageable with proper pool sizing.

### Free Tier Caveats

| Limitation | Impact | Mitigation |
|---|---|---|
| Pauses after 7 days inactivity | First request after pause takes ~60s | Startup validation catches this; use a cron ping for demos |
| 500 MB storage | Sufficient for demo/testing | Monitor usage; ledger entries grow linearly with transactions |
| ~60 direct connections | Must size pool carefully | `DB_POOL_SIZE=15` leaves room for dashboard and other services |
| Shared compute | Latency varies | Acceptable for demos; not for production payment processing |

### SSL Certificate Handling

Supabase uses certificates from a public CA. `ssl: "require"` is sufficient —
we don't need to pin certificates or provide custom CA bundles. The `postgres`
driver validates the certificate against the system's trusted CA store.

```typescript
// This is enough for Supabase:
ssl: config.DATABASE_SSL ? "require" : false

// You do NOT need:
ssl: { rejectUnauthorized: false }  // NEVER — disables certificate validation
ssl: { ca: fs.readFileSync(...) }   // unnecessary — Supabase uses public CAs
```

`rejectUnauthorized: false` is the equivalent of "yeah I know the padlock is
broken but let me in anyway." For a payment engine, no.

---

## 11. Docker-Specific Considerations

### Why `postgres:16-alpine`

| Decision | Reason |
|---|---|
| Version 16 | Latest stable. Matches what Supabase runs. Features we use (BIGINT, JSONB, CTEs) have existed since PG 9.4, but staying current avoids surprises when deploying to Supabase. |
| Alpine variant | 80MB vs 400MB image. Faster pulls. Same Postgres. |

### Volume Persistence

```yaml
volumes:
  - pgdata:/var/lib/postgresql/data
```

Data survives `docker compose down` (stops containers, network removed, volume
preserved). Only `docker compose down -v` destroys the volume and all data.
This means you can restart Docker without re-running migrations and seeds.
Use `down -v` when you need a clean slate (schema changes, corrupt state).

### Init Script

```sql
-- scripts/init-test-db.sql
-- Runs automatically on first docker compose up
CREATE DATABASE payment_engine_test;
```

This creates the test database alongside the main one. Both live in the same
Postgres instance but are completely isolated — different schemas, different
data, truncated independently.

---

## 12. Test Connection Setup

Tests use a separate, purpose-built connection:

```typescript
// tests/helpers/setup.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";

let db: ReturnType<typeof drizzle>;
let sql: ReturnType<typeof postgres>;

export async function setupTestDB() {
  // Always local Docker. No SSL. No pool size tuning.
  // Tests are the one place simplicity wins over configurability.
  sql = postgres(process.env.TEST_DATABASE_URL!, {
    max: 5,           // Tests don't need many connections
    idle_timeout: 10,  // Clean up fast between test files
  });
  db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

export async function teardownTestDB() {
  // Truncate, don't drop. Faster, and schema stays intact.
  await sql`TRUNCATE ledger_entries, ledger_transactions,
            payments, idempotency_keys CASCADE`;
  await sql.end();
}
```

### Why Tests Don't Use `db.ts`

Tests import their own connection, not the application's `db.ts`. Reasons:

1. **Isolation.** Tests need `TEST_DATABASE_URL`, not `DATABASE_URL`. Importing
   `db.ts` would connect to the dev database.
2. **Lifecycle control.** Tests need to setup, truncate, and teardown the
   connection. The application connection is managed by the server lifecycle.
3. **No config validation overhead.** Tests don't need startup checks — they
   create their own state.

---

## 13. Monitoring the Connection Layer

### What to Log

```typescript
// On startup
logger.info({
  pool_size: config.DB_POOL_SIZE,
  ssl: config.DATABASE_SSL,
  database: sanitizeConnectionString(config.DATABASE_URL),
  environment: config.APP_ENV,
}, "Database connection configured");

// After validation
logger.info({
  tables_verified: 5,
  accounts_verified: 5,
  constraints_verified: 4,
}, "Database validation complete");

// On shutdown
logger.info({ drain_timeout: 5 }, "Closing database connections");
```

### What to Watch For

| Signal | Meaning | Action |
|---|---|---|
| `connect_timeout` errors spiking | Pool exhausted or Postgres overloaded | Increase `DB_POOL_SIZE` or investigate slow queries |
| Validation failures on deploy | Migration or seed step was skipped in CI/CD | Fix the deployment pipeline |
| `ssl` errors on Supabase | Certificate issue or using pooled port with wrong config | Verify `DATABASE_SSL=true` and port 5432 |
| Idle connections climbing | Pool isn't releasing connections | Check for uncommitted transactions (missing COMMIT/ROLLBACK) |

### What NEVER to Log

- Full connection strings (contains password)
- Query parameters (may contain PII or financial data)
- SSL certificate contents

---

## Summary

The database connection for a payment engine is not a one-liner. It's:

- **Explicitly configured** — no string sniffing, no magic defaults
- **Validated at startup** — refuses to serve traffic against a broken database
- **Properly sized** — pool tuned for the workload, not a random number
- **Isolation-aware** — `READ COMMITTED` + `FOR UPDATE`, not blind `SERIALIZABLE`
- **Resilient by design** — idempotency + ACID handle connection failures, not retry loops
- **Gracefully shutting down** — zero dropped requests during deployments
- **Guarded against mistakes** — destructive operations blocked in production
- **Monitored** — connection health is observable without exposing secrets

Every line of `db.ts` exists for a reason. Every configuration option has a
justification. That's what separates a payment engine from a CRUD app.

---

Previous: [12 — Glossary](./12-glossary.md) | Next: [14 — Development Flow](./14-development-flow.md)
