# Observability — Seeing Inside The System

When a payment fails at 2am, you don't get to step through a debugger. You have
logs. You have metrics. You have traces. If those aren't set up correctly, you're
blind. This document defines what we observe and how.

---

## 1. The Three Pillars

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│    Logs      │    │   Metrics   │    │   Traces    │
│              │    │             │    │             │
│ What happened│    │  How much   │    │  How long   │
│ in detail    │    │  and how    │    │  and where  │
│              │    │  often      │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
```

For v1, we focus on **structured logs** and **request tracing**. Metrics and
dashboards are v2 (when there's something to measure at scale).

---

## 2. Structured Logging

### Format: JSON, Always

Every log line is a JSON object. Never a string. Strings can't be searched,
filtered, or aggregated.

```json
{
  "level": "info",
  "timestamp": "2025-01-15T10:30:00.123Z",
  "request_id": "req_01HXYZ...",
  "method": "POST",
  "path": "/api/v1/payments/authorize",
  "message": "Payment authorized",
  "payment_id": "pay_01HABC...",
  "amount": 10000,
  "currency": "USD",
  "duration_ms": 45
}
```

### Log Levels

| Level | When | Example |
|---|---|---|
| `error` | Something broke that shouldn't. Requires investigation. | Ledger imbalance detected, database connection failed |
| `warn` | Something unusual but handled. Worth monitoring. | Idempotency conflict, expired authorization accessed, rate limit hit |
| `info` | Normal business events. The story of what happened. | Payment authorized, payment captured, refund processed |
| `debug` | Detailed internals. Only in development. | SQL query executed, cache hit/miss, request body parsed |

### Rules

1. **One log per event, not per step.** Don't log "starting authorization,"
   "validating input," "creating payment," "inserting entries," "done." Log
   once: "Payment authorized" with all the context attached.

2. **Every log includes `request_id`.** This is how you trace a request through
   the system.

3. **Every payment-related log includes `payment_id`.** This is how you trace
   a payment's full history.

4. **Amounts are logged as integers.** Same as they're stored. No conversion.

5. **Never log at `error` for client mistakes.** A 400 or 409 is not an error —
   it's the system working correctly. Log it at `warn` or `info`.

---

## 3. What To Log

### Request/Response Logging (Middleware)

Every request gets a log entry:

```json
{
  "level": "info",
  "timestamp": "2025-01-15T10:30:00.123Z",
  "request_id": "req_01HXYZ...",
  "method": "POST",
  "path": "/api/v1/payments/authorize",
  "status": 201,
  "duration_ms": 45,
  "idempotency_key": "ik_550e...",
  "user_agent": "PaymentSDK/1.0"
}
```

### Business Events

```json
// Payment authorized
{
  "level": "info",
  "message": "payment.authorized",
  "request_id": "req_01HXYZ...",
  "payment_id": "pay_01HABC...",
  "amount": 10000,
  "currency": "USD"
}

// Payment captured
{
  "level": "info",
  "message": "payment.captured",
  "request_id": "req_01HDEF...",
  "payment_id": "pay_01HABC...",
  "captured_amount": 10000
}

// Refund processed
{
  "level": "info",
  "message": "payment.refunded",
  "request_id": "req_01HGHI...",
  "payment_id": "pay_01HABC...",
  "refund_amount": 3000,
  "total_refunded": 3000
}

// Idempotency key reuse (not an error)
{
  "level": "info",
  "message": "idempotency.cache_hit",
  "request_id": "req_01HJKL...",
  "idempotency_key": "ik_550e...",
  "original_payment_id": "pay_01HABC..."
}

// Invalid state transition attempt
{
  "level": "warn",
  "message": "payment.invalid_transition",
  "request_id": "req_01HMNO...",
  "payment_id": "pay_01HABC...",
  "current_status": "voided",
  "attempted_action": "capture"
}

// Ledger imbalance (CRITICAL)
{
  "level": "error",
  "message": "ledger.imbalance_detected",
  "request_id": "req_01HPQR...",
  "transaction_id": "txn_01HSTU...",
  "total_debits": 10000,
  "total_credits": 7000,
  "difference": 3000
}
```

### Error Logging

```json
// Database error
{
  "level": "error",
  "message": "database.query_failed",
  "request_id": "req_01HVWX...",
  "error": "connection refused",
  "query": "SELECT ... FROM payments WHERE id = $1",
  "duration_ms": 5002
}

// Unhandled error
{
  "level": "error",
  "message": "unhandled_error",
  "request_id": "req_01HYZA...",
  "error": "TypeError: Cannot read property 'id' of undefined",
  "stack": "at PaymentService.capture (src/payments/service.ts:45:12)..."
}
```

---

## 4. What NEVER To Log

This is as important as what you log. Getting this wrong is a compliance
violation.

### Never Log These

| Data | Why | What To Log Instead |
|---|---|---|
| Card numbers | PCI-DSS violation | Last 4 digits at most: `****1234` |
| CVV/CVC | PCI-DSS violation — never stored anywhere | Nothing |
| Full bank account numbers | PII, compliance risk | Masked: `****5678` |
| Customer passwords | Obvious | Nothing |
| API keys / secrets | Security breach | Key prefix only: `sk_live_...` |
| Full request bodies with PII | GDPR/privacy risk | Individual fields, sanitized |
| Customer email addresses | PII in logs is a liability | Hash or omit |
| Customer names | PII in logs is a liability | Customer ID only |

### The Rule

> If you wouldn't want it in a screenshot on Twitter, don't put it in the logs.

Logs are often accessed by many people, exported to third-party services, and
retained for long periods. Treat them as semi-public.

### Implementation

```typescript
// Sanitize before logging
function sanitizeForLog(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...data };

  // Remove sensitive fields entirely
  delete sanitized.cvv;
  delete sanitized.password;
  delete sanitized.api_key;

  // Mask partial fields
  if (sanitized.card_number && typeof sanitized.card_number === "string") {
    sanitized.card_number = "****" + sanitized.card_number.slice(-4);
  }

  return sanitized;
}
```

---

## 5. Request Tracing

### How It Works

Every request gets a unique `request_id`. This ID appears in:
- Every log line during that request
- The HTTP response header (`X-Request-ID`)
- Any ledger transactions created during that request

```
Client sends: POST /authorize (Idempotency-Key: ik_123)
                    │
                    ▼
            request_id: req_01HXYZ generated
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
    Log: request    Log: payment    Log: ledger
    received        authorized      entries created
    req_01HXYZ      req_01HXYZ      req_01HXYZ
                    │
                    ▼
            Response header:
            X-Request-ID: req_01HXYZ
```

### Tracing a Payment's Full History

To see everything that happened to a payment:

```bash
# All logs for a specific payment
grep "pay_01HABC" logs.json

# Result:
# { "message": "payment.authorized", "payment_id": "pay_01HABC...", ... }
# { "message": "payment.captured", "payment_id": "pay_01HABC...", ... }
# { "message": "payment.refunded", "payment_id": "pay_01HABC...", ... }
```

To see everything that happened in a specific request:

```bash
# All logs for a specific request
grep "req_01HXYZ" logs.json
```

---

## 6. Logger Implementation

### Logger Factory

```typescript
// src/shared/logger.ts

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  request_id?: string;
  payment_id?: string;
  [key: string]: unknown;
}

function createLogger() {
  const level = process.env.LOG_LEVEL || "info";

  const shouldLog = (msgLevel: LogLevel): boolean => {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(msgLevel) >= levels.indexOf(level as LogLevel);
  };

  return {
    info(message: string, context: LogContext = {}) {
      if (!shouldLog("info")) return;
      console.log(JSON.stringify({
        level: "info",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      }));
    },

    warn(message: string, context: LogContext = {}) {
      if (!shouldLog("warn")) return;
      console.log(JSON.stringify({
        level: "warn",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      }));
    },

    error(message: string, context: LogContext = {}) {
      if (!shouldLog("error")) return;
      console.error(JSON.stringify({
        level: "error",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      }));
    },

    debug(message: string, context: LogContext = {}) {
      if (!shouldLog("debug")) return;
      console.log(JSON.stringify({
        level: "debug",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      }));
    },
  };
}

export const logger = createLogger();
```

### Middleware Integration

```typescript
// Request logging middleware
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-ID") || generateRequestId();
  const start = performance.now();

  // Attach to context for use in handlers
  c.set("requestId", requestId);

  await next();

  const duration = Math.round(performance.now() - start);

  logger.info("request.completed", {
    request_id: requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: duration,
  });

  // Add to response headers
  c.header("X-Request-ID", requestId);
});
```

---

## 7. Health Metrics (v1 — Lightweight)

The `/health` endpoint reports basic system status:

```typescript
app.get("/health", async (c) => {
  const checks: Record<string, string> = {};

  // Check database connectivity
  try {
    await db.execute(sql`SELECT 1`);
    checks.database = "healthy";
  } catch {
    checks.database = "unreachable";
  }

  const healthy = Object.values(checks).every(v => v === "healthy");

  return c.json({
    status: healthy ? "healthy" : "unhealthy",
    version: process.env.APP_VERSION || "1.0.0",
    uptime_seconds: Math.floor(process.uptime()),
    checks,
  }, healthy ? 200 : 503);
});
```

### Metrics to Consider for v2

| Metric | Type | Why |
|---|---|---|
| `payments_authorized_total` | Counter | Volume tracking |
| `payments_captured_total` | Counter | Conversion tracking |
| `payments_failed_total` | Counter | Error rate |
| `payment_amount_authorized` | Histogram | Value distribution |
| `request_duration_ms` | Histogram | Latency tracking |
| `ledger_entries_total` | Counter | Ledger growth rate |
| `idempotency_cache_hits` | Counter | Retry frequency |
| `db_query_duration_ms` | Histogram | Database performance |

---

## 8. Debugging Playbook

When something goes wrong, follow this sequence:

### "A payment failed"

```
1. Get the payment_id or request_id from the client
2. grep the request_id in logs → see the full request trace
3. Check the HTTP status code:
   - 400 → client sent bad data (check validation error details)
   - 409 → state machine violation (check current_status in logs)
   - 422 → business rule violation (check amount constraints)
   - 500 → our bug (check error + stack trace)
4. If 500: check the ledger entries for that payment
   - Are entries balanced?
   - Is the payment status consistent with the entries?
```

### "A customer was double-charged"

```
1. Get both payment IDs
2. Check idempotency keys — were they different? (client bug)
3. Check timestamps — were they within the same second? (concurrency issue)
4. Check the ledger — are there duplicate entries?
5. Verify the god check — does the system still balance?
```

### "Account balance seems wrong"

```
1. Query the account's ledger entries directly
2. Manually sum debits and credits
3. Compare against the computed balance
4. If they differ → bug in balance computation
5. If they match → the entries themselves are wrong (trace back to which
   transaction created them)
```

---

## 9. Log Retention

| Environment | Retention | Storage |
|---|---|---|
| Development | Current session only | stdout |
| Test | Not retained | stdout (captured by test runner) |
| Production | 90 days minimum | Log aggregation service |

**Operational vs compliance retention:** The 90-day minimum covers debugging
and incident response. Financial audit logs (payment events, ledger mutations,
error trails) require 5-7 years of retention depending on jurisdiction. In v1,
we ensure logs are structured JSON so they can be shipped to a long-term
archival system (e.g., S3 + Athena, BigQuery). The 90-day window is for
immediate access; compliance archival is a production deployment concern.

---

Previous: [08 — Testing Strategy](./08-testing-strategy.md) | Next: [10 — Security](./10-security.md)
