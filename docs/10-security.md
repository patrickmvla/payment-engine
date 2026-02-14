# Security Considerations — Protecting Money and Data

We're not building authentication in v1, but that doesn't mean security is an
afterthought. A payment engine that's careless with data or vulnerable to
injection is worse than no engine at all. This document covers what we protect
against and how.

---

## 1. Threat Model

What could go wrong and who might cause it:

| Threat | Actor | Impact | Our Mitigation |
|---|---|---|---|
| SQL injection | Malicious client | Full database access | Parameterized queries via Drizzle |
| Mass assignment | Malicious client | Overwrite protected fields | Zod schema validation (allowlist) |
| Integer overflow | Malicious client | Corrupt amounts | BigInt + database constraints |
| State machine bypass | Malicious client | Skip payment steps | Server-side state enforcement |
| Double-spending | Malicious/buggy client | Financial loss | Pessimistic locking + idempotency |
| PII exposure | Internal mistake | Compliance violation | Sanitized logging, no PII in errors |
| Timing attacks | External attacker | Information leakage | Constant-time comparisons for keys |
| Denial of service | External attacker | Service unavailable | Rate limiting |
| Dependency vulnerability | Supply chain | Various | Minimal dependencies, audit |

---

## 2. Input Validation

### Defense: Allowlist, Not Blocklist

Every request body is validated against a Zod schema. Only fields defined in the
schema are accepted. Everything else is silently stripped.

```typescript
// This schema ONLY allows these fields. Nothing else gets through.
const AuthorizeSchema = z.object({
  amount: z.number().int().positive().max(99999999),  // max ~$999,999.99
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  description: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
```

What this prevents:
- Passing `status: "captured"` to skip authorization → stripped, ignored
- Passing `amount: -1` to create negative charges → rejected by `.positive()`
- Passing `amount: 99.99` (float) → rejected by `.int()`
- Passing `currency: "'; DROP TABLE payments;--"` → rejected by regex

### Amount Boundaries

```typescript
const MIN_AMOUNT = 1;          // 1 cent minimum
const MAX_AMOUNT = 99_999_999; // $999,999.99 maximum per transaction

// Enforced in schema
amount: z.number().int().min(MIN_AMOUNT).max(MAX_AMOUNT)
```

Why a maximum? Unbounded amounts can cause:
- Integer overflow in downstream systems
- Accidental massive charges from client bugs
- Resource exhaustion in balance computations

---

## 3. SQL Injection Prevention

### Defense: Parameterized Queries via Drizzle

We never construct SQL from strings. Drizzle uses parameterized queries:

```typescript
// SAFE — Drizzle parameterizes automatically
const payment = await db.select()
  .from(payments)
  .where(eq(payments.id, paymentId));

// Generated: SELECT * FROM payments WHERE id = $1
// With parameter: ['pay_01HXYZ...']
```

Even when using raw SQL (for `FOR UPDATE`):

```typescript
// SAFE — tagged template literal, parameters are escaped
const result = await db.execute(
  sql`SELECT * FROM payments WHERE id = ${paymentId} FOR UPDATE`
);

// Generated: SELECT * FROM payments WHERE id = $1 FOR UPDATE
```

### What We NEVER Do

```typescript
// NEVER — string interpolation in queries
const result = await db.execute(
  `SELECT * FROM payments WHERE id = '${paymentId}'`  // VULNERABLE
);
```

This pattern doesn't exist in our codebase. Drizzle's API makes the safe path
the easy path.

---

## 4. Mass Assignment Protection

### Defense: Explicit Schema Validation

The Zod schemas act as an allowlist. Only declared fields are accepted:

```typescript
// Client sends:
{
  "amount": 10000,
  "currency": "USD",
  "status": "captured",        // ← attacker trying to skip auth
  "id": "pay_custom_id",      // ← attacker trying to control ID
  "refunded_amount": 10000    // ← attacker trying to fake refund
}

// After Zod validation, we have:
{
  "amount": 10000,
  "currency": "USD"
}
// Everything else was stripped.
```

Server-controlled fields (`id`, `status`, `created_at`, etc.) are NEVER
accepted from the client. They're generated server-side.

---

## 5. Money Safety

### Integer Overflow

JavaScript `Number.MAX_SAFE_INTEGER` is 9,007,199,254,740,991. That's ~$90
trillion in cents. Probably safe, but we use `BigInt` anyway:

```typescript
// BigInt has no upper limit
const amount = 10000n;       // $100.00
const huge = 999999999999n;  // No overflow, no precision loss
```

At the database level, PostgreSQL `BIGINT` holds up to 9,223,372,036,854,775,807.
That's $92 quadrillion. Overflow is not a practical concern.

### Negative Amount Attacks

```
POST /authorize { amount: -10000 }
→ 400: amount must be positive (Zod rejects)

POST /refund { amount: -5000 }
→ 400: amount must be positive (Zod rejects)
```

Even if validation somehow failed, the database constraint catches it:

```sql
CHECK (amount > 0)  -- on ledger_entries
```

Defense in depth. The same attack must bypass Zod AND the database.

---

## 6. State Machine Security

### Defense: Server-Side State Enforcement

The client never tells us what state a payment should be in. They request
actions, and we determine the state transition:

```
Client says: POST /payments/:id/capture
We check:    payment.status === "authorized" ? → proceed : → 409 reject
We set:      payment.status = "captured"
```

There is no endpoint that accepts `{ status: "captured" }`. The state machine
is enforced entirely server-side.

### Why This Matters

Without this, a malicious client could:
1. Create a payment (status: created)
2. Send `{ status: "settled" }` directly → money appears to have been received
3. Demand goods/services based on a fabricated settlement

Our system: impossible. The only way to reach "settled" is through the full
authorize → capture → settle chain, each with its own validation.

---

## 7. Secrets Management

### What Goes in `.env`

```bash
# .env — NEVER committed to git

# Local development (Docker Postgres)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_engine
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_engine_test

# Production (Supabase) — use the direct connection, not pooled
# DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres

PORT=3000
LOG_LEVEL=info
APP_VERSION=1.0.0
```

### What Goes in `.gitignore`

```
.env
.env.local
.env.production
*.pem
*.key
```

### Rules

1. **No secrets in code.** Ever. Not even "temporary" ones.
2. **No secrets in logs.** The logger sanitizes sensitive fields.
3. **No secrets in error responses.** Internal errors return generic messages.
4. **`.env.example` exists** with placeholder values for documentation:

```bash
# .env.example — committed to git, shows required variables
DATABASE_URL=postgres://user:password@localhost:5432/payment_engine
TEST_DATABASE_URL=postgres://user:password@localhost:5432/payment_engine_test
PORT=3000
LOG_LEVEL=info
```

---

## 8. Error Response Safety

### Defense: Never Expose Internals

Error responses include enough information for the client to fix their request,
but never expose system internals:

```json
// GOOD — tells the client what went wrong
{
  "error": {
    "type": "invalid_state_transition",
    "message": "Cannot capture a payment with status 'voided'."
  }
}

// BAD — exposes internals
{
  "error": {
    "message": "Error at PaymentService.capture:45 — SELECT * FROM payments WHERE id='pay_01H' returned status='voided', expected 'authorized'. Stack: ..."
  }
}
```

### Rules

1. **No stack traces in responses.** Stack traces go to logs, not to clients.
2. **No SQL in responses.** Query details are internal.
3. **No server paths in responses.** File paths reveal server structure.
4. **Generic 500 errors.** When something unexpected happens:

```json
{
  "error": {
    "type": "internal_error",
    "message": "An unexpected error occurred. Please contact support with request ID: req_01HXYZ..."
  }
}
```

The `request_id` lets support find the real error in logs without exposing it
to the client.

---

## 9. Rate Limiting

### Defense: Token Bucket Per Client

Even without authentication, rate limiting prevents:
- Brute-force enumeration of payment IDs
- Resource exhaustion (creating millions of test payments)
- Denial of service

```typescript
// Simple in-memory rate limiter for v1
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

app.use("/api/*", async (c, next) => {
  const clientIP = c.req.header("x-forwarded-for") || "unknown";
  const now = Date.now();
  const window = 60_000; // 1 minute
  const limit = 1000;

  let bucket = rateLimiter.get(clientIP);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + window };
    rateLimiter.set(clientIP, bucket);
  }

  bucket.count++;

  c.header("RateLimit-Limit", String(limit));
  c.header("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
  c.header("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));

  if (bucket.count > limit) {
    return c.json({
      error: {
        type: "rate_limit_exceeded",
        message: "Too many requests. Please retry later.",
      }
    }, 429);
  }

  await next();
});
```

---

## 10. Dependency Security

### Minimal Dependencies

The fewer dependencies, the smaller the attack surface:

| Dependency | Why It's Needed | Can We Remove It? |
|---|---|---|
| `hono` | HTTP framework | No — core framework |
| `@hono/zod-openapi` | OpenAPI integration | No — core for API docs |
| `drizzle-orm` | Database queries | No — core for data access |
| `zod` | Validation | No — core for input safety |
| `@scalar/hono-api-reference` | API docs UI | No — required for `/docs` |
| `postgres` | PostgreSQL driver | No — required for DB |
| `@paralleldrive/cuid2` | ID generation | No — required for IDs |

That's it. Seven dependencies. Every one is essential.

### Audit

```bash
# Check for known vulnerabilities
bun audit

# Or manually check on https://security.snyk.io
```

### Lockfile

`bun.lockb` is committed to git. This ensures everyone gets the exact same
dependency versions. No surprises from floating version ranges.

---

## 11. Security Headers

Even though we're an API (no browser UI), we set defensive headers:

```typescript
app.use("*", async (c, next) => {
  await next();

  // Prevent MIME type sniffing
  c.header("X-Content-Type-Options", "nosniff");

  // No caching for API responses (financial data)
  c.header("Cache-Control", "no-store");

  // Prevent embedding in iframes
  c.header("X-Frame-Options", "DENY");
});
```

### Why No-Cache?

Financial data should never be cached by intermediaries (proxies, CDNs, browser
caches). A cached balance or payment status could show stale data, leading to
incorrect decisions.

---

## 12. OWASP Top 10 Awareness

| # | Vulnerability | Our Status |
|---|---|---|
| A01 | Broken Access Control | v1 has no auth — acknowledged limitation. API is for local/trusted use. |
| A02 | Cryptographic Failures | No sensitive data stored unencrypted. Passwords/keys in `.env` only. |
| A03 | Injection | Parameterized queries via Drizzle. No string concatenation in SQL. |
| A04 | Insecure Design | State machine enforced server-side. Defense in depth on all invariants. |
| A05 | Security Misconfiguration | Minimal config. No default credentials. `.env.example` documents all vars. |
| A06 | Vulnerable Components | 7 dependencies, all actively maintained. Lockfile committed. |
| A07 | Auth Failures | No auth in v1 — out of scope. Would use API keys + HMAC in production. |
| A08 | Data Integrity Failures | Immutable ledger. Database constraints. Idempotency keys. |
| A09 | Logging Failures | Structured logging. PII sanitization. Request tracing. |
| A10 | SSRF | No outbound HTTP requests in v1. No user-provided URLs processed. |

---

## 13. What Production Would Add

These are out of scope for v1 but documented for awareness:

| Feature | Why |
|---|---|
| API key authentication | Identify and authorize clients |
| HMAC request signing | Prevent request tampering |
| TLS/HTTPS | Encrypt data in transit |
| Database encryption at rest | Protect stored data |
| Secrets manager (Vault, AWS SSM) | No `.env` files in production |
| WAF (Web Application Firewall) | Block known attack patterns |
| IP allowlisting | Restrict API access by network |
| PCI-DSS compliance | Required for handling real card data |
| SOC 2 controls | Required for enterprise fintech |

---

Previous: [09 — Observability](./09-observability.md) | Next: [11 — Development Guide](./11-development-guide.md)
