# Phase 4: API Layer — The Thin Shell That Ships

The ledger is correct. The payment service moves money safely. Now we give the
world a way to talk to it. Phase 4 is the thinnest layer in the stack — HTTP
route handlers that validate input, call the payment service, and format the
response. No business logic lives here. Not one line.

If the service layer is the engine, the API layer is the steering wheel. It
translates HTTP requests into service calls and service responses into HTTP
responses. It adds the things that only matter over the wire: idempotency
checking, error formatting, request tracing, rate limiting, security headers,
and OpenAPI documentation. All of it is middleware — composable, testable,
independent of the financial logic below.

This is also where `@hono/zod-openapi` earns its keep. Every route is defined
with Zod schemas that simultaneously validate requests at runtime, provide
TypeScript types at compile time, and generate the OpenAPI 3.1 spec that powers
the interactive docs at `/docs`. One source of truth, three outputs.

~30 tests. The E2E tests use Hono's type-safe RPC client (`hc<AppType>`) over
real TCP connections. The load tests use a custom harness that fuses throughput
measurement with invariant verification — every load burst ends with a god check.

**Goal:** HTTP endpoints via Hono + OpenAPI. Thin route handlers that delegate to
the payment service. Middleware for error formatting, request tracing, idempotency
header checking, and rate limiting. Interactive API docs at `/docs`. Every endpoint
returns correct status codes, headers, and error shapes.

**Gate:** All E2E tests green. All load tests pass with acceptable latency. `/docs`
renders the full OpenAPI spec. Every endpoint returns correct status codes, headers,
and error shapes. God check passes after load testing. `bun test --bail` exits 0.

---

## Why Routes Are a Separate Layer

Every payment operation already works. `paymentService.authorize(db, params, key)`
creates a payment, posts ledger entries, and returns a `PaymentResponse`. Phase 3
proved it. So why not just call the service from `server.ts` and be done?

Because HTTP is not a function call. HTTP adds concerns that don't belong in the
service layer:

1. **Header extraction** — The `Idempotency-Key` is an HTTP header, not a service
   parameter. The route handler extracts it and passes it to the service.
2. **Status codes** — `authorize` returns `201 Created`, `capture` returns `200 OK`.
   The service doesn't know about HTTP status codes. The route handler does.
3. **Error formatting** — The service throws `InvalidStateTransitionError`. The
   error middleware catches it and formats `{ error: { type, message, details } }`
   with the correct HTTP status code.
4. **Response transformation** — The service returns camelCase TypeScript objects.
   The API returns snake_case JSON with an `object` field. The route handler
   transforms between the two.
5. **Request tracing** — Every response gets an `X-Request-ID` header. The service
   doesn't know about request IDs.
6. **OpenAPI metadata** — Descriptions, examples, tags, response schemas. None of
   this belongs in the service layer.

The route handler is the adapter between HTTP and the domain. It's thin, it's
boring, and that's exactly right. The interesting logic is in Phase 3.

---

## Pre-flight

- [ ] Phase 3 gate passed — all ~165 unit tests green, all ~135 integration tests green
- [ ] God check passes after every operation type
- [ ] Concurrent operations don't corrupt state
- [ ] Payment service is standalone with correct idempotency + concurrency
- [ ] `server.ts` exists with health check, OpenAPI spec, Scalar docs
- [ ] Docker Postgres running, both main and test DBs migrated and seeded
- [ ] `bun run lint` passes

---

## TDD Sequence

Eleven steps. The E2E tests come first — they drive the route implementation. The
load tests come last — they prove the whole stack holds up under pressure. The god
check runs after load testing, not after individual E2E tests, because the E2E
tests use `cleanBetweenTests()` in `afterEach` which resets the database between
tests.

```
Step 1:  Write E2E happy path tests (Hono RPC)       → RED (routes don't exist)
Step 2:  Implement route handlers + wire to service   → GREEN
Step 3:  Write E2E error response tests               → RED
Step 4:  Implement error middleware                    → GREEN
Step 5:  Write API contract tests (shapes, headers)   → RED
Step 6:  Wire OpenAPI schemas, security headers, X-Request-ID → GREEN
Step 7:  Write pagination tests                       → RED
Step 8:  Implement GET /payments with cursor pagination → GREEN
Step 9:  Write E2E idempotency + settle tests         → RED
Step 10: Wire idempotency header checking + settle route → GREEN
Step 11: Write + run load tests (harness + god check) → PASS
```

Notice: no god check after steps 2-10. The E2E tests call `cleanBetweenTests()`
after each test, which truncates data tables. The god check in `afterAll` would
verify an empty database — meaningless. The load tests in step 11 are the ones
that accumulate real data and verify the god check under pressure.

---

## 1. The E2E Test Setup — Real HTTP, Type-Safe Client

**File:** `tests/e2e/setup.ts`
**Source:** Doc 08c, Section 2

The test setup starts a real `Bun.serve()` instance and creates a Hono RPC client
bound to the full route type graph. This is not `app.request()`. This is real TCP.

```typescript
import { app } from "../../src/server";
import { hc } from "hono/client";
import type { AppType } from "../../src/server";

let server: ReturnType<typeof Bun.serve>;
let client: ReturnType<typeof hc<AppType>>;

const TEST_PORT = 4567;
const BASE_URL = `http://localhost:${TEST_PORT}`;

export async function startTestServer() {
  server = Bun.serve({ fetch: app.fetch, port: TEST_PORT });
  client = hc<AppType>(BASE_URL);
  return client;
}

export async function stopTestServer() {
  server.stop();
}

export { client, BASE_URL };
```

Key details:

- `AppType` is exported from `server.ts`. It carries the complete route type
  graph — every route, every parameter, every request body, every response shape.
- `hc<AppType>(BASE_URL)` creates a client that mirrors the route tree as nested
  objects. `client.api.v1.payments.authorize.$post(...)` is type-checked against
  the actual route definition.
- Port 4567 avoids conflicting with the dev server on 3000.
- `Bun.serve` binds the same `app.fetch` handler that production uses. No
  test-specific configuration — what you test is what you ship.

The Hono RPC client catches contract violations at **compile time**. If a route's
Zod schema says `amount` is `z.number()` and you pass `"not a number"`, TypeScript
rejects it before `bun test` ever executes. This is the contract enforcement that
`app.request()` with untyped `Request` objects cannot provide.

---

## 2. Route Architecture — `createRoute()` + Handlers

**Files:** `src/payments/routes.ts`, `src/ledger/routes.ts`
**Source:** Doc 05 (API Design), Doc 07 (API Standards), Doc 15 (OpenAPI)

Every route is defined with `createRoute()` from `@hono/zod-openapi`. This single
definition validates the request, provides TypeScript types, and generates the
OpenAPI spec entry. One definition, three outputs.

### Route Definition Pattern

```typescript
import { createRoute, z } from "@hono/zod-openapi";

const authorizeRoute = createRoute({
  method: "post",
  path: "/api/v1/payments/authorize",
  tags: ["Payments"],
  summary: "Authorize a payment",
  description: "Creates a new payment and places a hold on the customer's funds.",
  request: {
    body: {
      content: { "application/json": { schema: AuthorizeBodySchema } },
      required: true,
    },
    headers: z.object({
      "Idempotency-Key": z.string().min(1).max(255),
    }),
  },
  responses: {
    201: {
      description: "Payment authorized",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    400: { description: "Validation error", content: { ... } },
    409: { description: "Idempotency conflict", content: { ... } },
  },
});
```

### Handler Pattern

Route handlers are thin. Extract, delegate, transform, respond. No business logic.

```typescript
app.openapi(authorizeRoute, async (c) => {
  const body = c.req.valid("json");
  const idempotencyKey = c.req.header("Idempotency-Key")!;

  const result = await paymentService.authorize(db, {
    amount: BigInt(body.amount),
    currency: body.currency,
    description: body.description,
    metadata: body.metadata,
  }, idempotencyKey);

  return c.json(toPaymentResponse(result), 201);
});
```

Four lines of meaningful code: extract input, call service, transform output,
respond. The route handler doesn't know about ledger entries, state machines, or
fee calculations. It knows about HTTP.

### Response Transformation

The service returns camelCase TypeScript objects. The API returns snake_case JSON.
A single `toPaymentResponse()` function bridges the gap:

```typescript
function toPaymentResponse(payment: PaymentResult) {
  return {
    id: payment.id,
    object: "payment" as const,
    status: payment.status,
    amount: Number(payment.amount),
    currency: payment.currency,
    authorized_amount: Number(payment.authorizedAmount),
    captured_amount: Number(payment.capturedAmount),
    refunded_amount: Number(payment.refundedAmount),
    description: payment.description,
    metadata: payment.metadata,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
    expires_at: payment.expiresAt?.toISOString() ?? null,
  };
}
```

BigInt to Number conversion happens here — at the API boundary. Internally,
everything is BigInt. Over the wire, everything is a JSON number. This is the
only place the conversion happens.

---

## 3. Routes — Every Endpoint

### 3a. Payment Mutations (`src/payments/routes.ts`)

| Route | Method | Handler | Status |
|---|---|---|---|
| `/api/v1/payments/authorize` | POST | `authorize(db, params, key)` | 201 |
| `/api/v1/payments/:id/capture` | POST | `capture(db, id, params)` | 200 |
| `/api/v1/payments/:id/void` | POST | `voidPayment(db, id)` | 200 |
| `/api/v1/payments/:id/refund` | POST | `refund(db, id, params)` | 200 |
| `/api/v1/payments/:id/settle` | POST | `settle(db, id)` | 200 |

All five require the `Idempotency-Key` header. All five extract the payment ID
from the URL parameter (except authorize, which creates the payment). All five
delegate to the corresponding service function and transform the result with
`toPaymentResponse()`.

### 3b. Payment Queries (`src/payments/routes.ts`)

| Route | Method | Handler | Status |
|---|---|---|---|
| `/api/v1/payments/:id` | GET | `getPayment(db, id)` | 200 |
| `/api/v1/payments` | GET | `listPayments(db, options)` | 200 |
| `/api/v1/payments/:id/ledger` | GET | `getTransactionsByReference(db, "payment", id)` | 200 |

No idempotency key required — reads are naturally idempotent.

The list endpoint returns the collection envelope:
```json
{
  "object": "list",
  "data": [ ... ],
  "has_more": true,
  "next_cursor": "pay_01HW..."
}
```

### 3c. Ledger Queries (`src/ledger/routes.ts`)

| Route | Method | Handler | Status |
|---|---|---|---|
| `/api/v1/accounts/:id/balance` | GET | `getBalance(db, id)` | 200 |

Returns the balance envelope:
```json
{
  "account_id": "customer_funds",
  "account_name": "Customer Funds",
  "account_type": "liability",
  "currency": "USD",
  "balance": 50000,
  "as_of": "2025-01-15T10:35:00Z"
}
```

### 3d. System Routes (`src/server.ts`)

| Route | Method | Handler | Status |
|---|---|---|---|
| `/health` | GET | Health check | 200 |
| `/docs` | GET | Scalar API docs | — |
| `/openapi.json` | GET | OpenAPI 3.1 spec | 200 |

These already exist from Phase 1. Phase 4 ensures they're wired correctly with
the full route tree registered.

---

## 4. Middleware — The HTTP Concerns

**Directory:** `src/shared/middleware/`

Four middleware functions. Each handles one HTTP concern. They compose in order:
request tracing first (so every log line has a request ID), then security headers,
then rate limiting, then error handling (outermost catch).

### 4a. Error Handler (`src/shared/middleware/error-handler.ts`)

The global error handler catches every thrown error and formats it into the
standard error response shape. This is the single place where `AppError` subclasses
are mapped to HTTP responses.

```typescript
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({
      error: {
        type: err.type,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    }, err.statusCode);
  }

  // Unknown error — 500 internal_error
  return c.json({
    error: {
      type: "internal_error",
      message: "An unexpected error occurred",
    },
  }, 500);
});
```

The mapping:

| Error Class | HTTP | `error.type` |
|---|---|---|
| `ValidationError` | 400 | `validation_error` |
| `PaymentNotFoundError` | 404 | `not_found` |
| `InvalidStateTransitionError` | 409 | `invalid_state_transition` |
| `IdempotencyConflictError` | 409 | `idempotency_conflict` |
| `InvalidAmountError` | 422 | `invalid_amount` |
| `InsufficientFundsError` | 422 | `insufficient_funds` |
| `LedgerImbalanceError` | 500 | `ledger_imbalance` |
| Unknown `Error` | 500 | `internal_error` |

Unknown errors never leak stack traces or internal details to the client. The
500 response is generic. The actual error is logged server-side with the request
ID for debugging.

### 4b. Request Tracing (`src/shared/middleware/security.ts`)

Every response gets an `X-Request-ID` header. If the client sent one, echo it
back. If not, generate one.

```typescript
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-ID") || generateId("req");
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-ID", requestId);
});
```

This is the first middleware in the chain. Every subsequent middleware and handler
can access the request ID via `c.get("requestId")`. Every log line includes it.

### 4c. Security Headers (`src/shared/middleware/security.ts`)

Standard security headers on every response:

```typescript
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});
```

### 4d. Rate Limiting (`src/shared/middleware/rate-limit.ts`)

In-memory per-IP rate limiter for v1. The response includes the standard rate
limit headers:

```
RateLimit-Limit: 1000
RateLimit-Remaining: 997
RateLimit-Reset: 42
```

When exceeded:
```
429 Too Many Requests
Retry-After: 12

{
  "error": {
    "type": "rate_limit_exceeded",
    "message": "Rate limit exceeded. Retry after 12 seconds.",
    "retry_after": 12
  }
}
```

Not tested in E2E (rate limiting is configurable and would make tests
non-deterministic). Tested manually or via dedicated rate-limit unit tests if
needed.

---

## 5. OpenAPI Integration

**Source:** Doc 07, Section 15

The OpenAPI spec is generated from the same Zod schemas that validate requests.
Change a schema, the docs update. No separate spec file to maintain.

```
Zod Schema ──┬──▶ Runtime validation (rejects bad requests)
             ├──▶ TypeScript types (compile-time safety)
             └──▶ OpenAPI 3.1 spec (auto-generated docs)
```

### Spec Metadata

```typescript
app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Payment Engine API",
    version: "1.0.0",
    description: "A payment processing engine with double-entry ledger",
  },
  servers: [
    { url: "http://localhost:3000", description: "Local development" },
  ],
});
```

### Tags

| Tag | Endpoints |
|---|---|
| `Payments` | authorize, capture, void, refund, settle, get, list |
| `Ledger` | payment ledger entries, account balances |
| `System` | health check |

### Scalar UI

Interactive docs at `/docs`. Developers can browse endpoints, see schemas with
field-level documentation, try requests from the browser, and download the spec
for client SDK generation.

---

## 6. E2E Tests — Happy Paths (~4 tests)

**File:** `tests/e2e/happy-paths.test.ts`
**Source:** Doc 08c, Section 3.1

Full lifecycle tests over real HTTP. Every request goes through TCP, HTTP parsing,
middleware, route handler, service, database, and back. If Phase 3 proved the
service works, these tests prove the HTTP layer doesn't break it.

```typescript
beforeAll(async () => {
  await setupTestDB();
  await startTestServer();
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDB();
});
afterEach(async () => { await cleanBetweenTests(); });
```

- [ ] **Full lifecycle: authorize -> capture -> refund** — 201 on auth, 200 on capture,
  200 on refund. Status transitions are `authorized` → `captured` → `refunded`.
  Payment ID matches `/^pay_/`.
- [ ] **Authorize -> void** — 200 on void. Status becomes `voided`.
- [ ] **Authorize -> capture -> settle -> refund** — Four operations, all succeed.
  Settle produces `settled`, refund after settlement produces `refunded`.
- [ ] **Authorize -> partial capture -> partial refund -> refund remainder** —
  Partial capture records correct `captured_amount`. First refund produces
  `partially_refunded`. Final refund produces `refunded` with
  `refunded_amount === captured_amount`.

These tests use the Hono RPC client. Every request body, response shape, and URL
parameter is type-checked at compile time. If the route's Zod schema changes,
these tests fail at `tsc` time — before they even run.

---

## 7. E2E Tests — Error Responses (~6 tests)

**File:** `tests/e2e/error-responses.test.ts`
**Source:** Doc 08c, Section 3.2

Error tests verify that the API returns correct HTTP status codes and error shapes.
The error middleware is the single place where `AppError` subclasses become HTTP
responses. These tests prove that mapping works.

- [ ] **Missing idempotency key → 400** — Raw `fetch` (bypassing RPC type safety).
  Response body has `error.type === "validation_error"`.
- [ ] **Invalid state transition → 409** — Authorize, void, then try to capture.
  Response has `error.type === "invalid_state_transition"` and
  `error.details.current_status === "voided"`.
- [ ] **Non-existent payment → 404** — GET for `pay_nonexistent`. Status 404.
- [ ] **Capture exceeding authorization → 422** — Authorize $100, try to capture
  $200. Status 422.
- [ ] **Settle non-captured payment → 409** — Authorize, then try to settle.
  `error.type === "invalid_state_transition"`.
- [ ] **Idempotency conflict → 409** — Same key, different amount. Status 409.

The missing-idempotency-key test uses raw `fetch` instead of the RPC client
because the RPC client would enforce the header at the type level — the test
would fail at compile time, not runtime. We need to test what happens when
the header is genuinely missing over the wire.

---

## 8. E2E Tests — API Contract (~6 tests)

**File:** `tests/e2e/api-contract.test.ts`
**Source:** Doc 08c, Section 3.3

Contract tests verify the shape and conventions of API responses. These are the
tests that catch accidental breaking changes — a renamed field, a missing header,
a wrong timestamp format.

- [ ] **Response includes `object` field** — `body.object === "payment"`. Every
  single-resource response includes this field for type identification.
- [ ] **Response includes `X-Request-ID` header** — `res.headers.get("X-Request-ID")`
  is defined. Every response, every time.
- [ ] **List endpoint returns correct shape** — `body.object === "list"`,
  `body.data` is an array, `body.has_more` is a boolean.
- [ ] **Timestamps are ISO 8601 UTC** — `body.created_at` matches
  `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/`. Always UTC, always Z
  suffix.
- [ ] **Payment IDs are prefixed ULIDs** — `body.id` matches `/^pay_/`.
- [ ] **Health check returns correct shape** — Raw `fetch` to `/health`. Status
  200, `body.status === "healthy"`, `body.version` is a string.

These tests are the API's regression guard. If someone renames `created_at` to
`createdAt` or drops the `object` field, these tests catch it before it ships.

---

## 9. E2E Tests — Pagination (~3 tests)

**File:** `tests/e2e/pagination.test.ts`
**Source:** Doc 08c, Section 3.4

Pagination tests verify cursor-based pagination behavior. Offset pagination is
O(n) and breaks when records are inserted between pages. Cursor pagination is
O(1) and stable.

- [ ] **Returns correct page size** — Create 5 payments, request `limit=3`.
  `body.data` has length 3, `body.has_more` is `true`.
- [ ] **Cursor pagination returns next page without overlap** — Page 1 has 3
  payments, page 2 has 2 payments. `page2.has_more` is `false`. No ID from
  page 1 appears in page 2 (set intersection is empty).
- [ ] **Empty results return 200 with empty data** — No payments exist. Status
  200, `body.data === []`, `body.has_more === false`.

The overlap test is the important one. If cursor pagination has an off-by-one,
the same payment appears on two pages, or a payment disappears between pages.
The set intersection check catches both.

---

## 10. Load Tests — Throughput + Correctness (~7 tests)

**Files:** `tests/load/payment-throughput.test.ts`, `tests/load/concurrent-lifecycle.test.ts`
**Source:** Doc 08c, Sections 4-5

The load tests use the custom harness from `tests/helpers/load-harness.ts`. The
critical difference from k6: after every load burst, the god check runs. High
throughput numbers are meaningless if the database is inconsistent.

### Load Harness (`tests/helpers/load-harness.ts`)

```typescript
export interface LoadResult {
  totalRequests: number;
  succeeded: number;
  failed: number;
  duration: number;
  rps: number;
  latencies: { p50, p95, p99, max, min, avg };
  errors: Map<string, number>;
}

export async function runLoad(
  name: string,
  concurrency: number,
  totalRequests: number,
  operation: () => Promise<Response>
): Promise<LoadResult>
```

Requests are sent in waves of `concurrency` size. Latency is tracked per request
(including failures — no survivor bias). Errors are bucketed by HTTP status code
or exception message. A human-readable report is printed after every run.

### 10a. Payment Throughput (`tests/load/payment-throughput.test.ts`)

- [ ] **100 concurrent authorizations: all succeed + system balances** — 20
  concurrency, 100 total. All 100 succeed (0 failed). p95 latency under 500ms.
  God check passes after the burst.
- [ ] **50 authorize + capture pairs: all succeed + system balances** — Each
  operation authorizes then captures. All 50 succeed. God check passes.

### 10b. Concurrent Lifecycles (`tests/load/concurrent-lifecycle.test.ts`)

- [ ] **20 full lifecycles (auth→capture→refund) under concurrency** — 20
  concurrent lifecycles via `Promise.allSettled`. All 20 complete. God check
  passes. Because every payment was fully refunded, all account balances should
  net to zero.
- [ ] **Mixed load: 30 auths + 15 captures + 10 voids simultaneously** — Phase 1
  creates 30 authorized payments. Phase 2 fires 15 captures and 10 voids
  concurrently on different payments. God check passes after the mixed burst.

### 10c. Performance Regression Guards

- [ ] **p95 latency for authorization stays under 200ms** — 10 concurrency, 50
  requests. p95 < 200ms, p99 < 500ms. These thresholds are generous enough for
  CI machines but tight enough to catch genuine regressions (dropped indexes,
  N+1 queries, accidental sequential scans).

The god check after load testing is the capstone of Phase 4. 100 concurrent
authorizations, 50 capture pairs, 20 full lifecycles, mixed operations — and
after all of it, `SUM(debits) === SUM(credits)`. The system doesn't just handle
load. It handles load correctly.

---

## 11. The `server.ts` Update — Wiring Everything Together

Phase 1 created `server.ts` with a health check and OpenAPI setup. Phase 4
registers the route handlers and middleware, making it the composition root.

```typescript
// src/server.ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { paymentRoutes } from "./payments/routes";
import { ledgerRoutes } from "./ledger/routes";
// ... middleware imports

const app = new OpenAPIHono();

// Middleware (order matters)
app.use("*", requestTracing);
app.use("*", securityHeaders);
app.use("/api/*", rateLimiter);

// Routes
app.route("/", paymentRoutes);
app.route("/", ledgerRoutes);

// Health, OpenAPI, Scalar
app.get("/health", ...);
app.doc("/openapi.json", { ... });
app.get("/docs", apiReference({ ... }));

// Error handler (outermost)
app.onError(errorHandler);

export type AppType = typeof app;
export { app };
```

The `AppType` export is what makes Hono RPC work. The E2E tests import it to
create a type-safe client that mirrors the entire route tree. If a route is
added, renamed, or its schema changes, the client types update automatically.

---

## 12. File Structure

```
src/
├── server.ts                   # Updated: composition root, middleware + routes
├── openapi.ts                  # Already exists (Phase 1)
│
├── payments/
│   ├── routes.ts               # NEW: OpenAPI route definitions + handlers
│   ├── service.ts              # Existing (Phase 3)
│   ├── state-machine.ts        # Existing (Phase 3)
│   ├── schemas.ts              # Existing (Phase 3) — Zod schemas with .openapi()
│   ├── types.ts                # Existing (Phase 3)
│   └── schema.ts               # Existing (Phase 1) — Drizzle schema
│
├── ledger/
│   ├── routes.ts               # NEW: Account balance + payment ledger routes
│   ├── service.ts              # Existing (Phase 2)
│   ├── balance.ts              # Existing (Phase 2)
│   ├── types.ts                # Existing (Phase 2)
│   └── schema.ts               # Existing (Phase 1)
│
└── shared/
    ├── middleware/
    │   ├── error-handler.ts    # NEW: AppError → HTTP error response
    │   ├── security.ts         # NEW: X-Request-ID, security headers
    │   └── rate-limit.ts       # NEW: In-memory per-IP rate limiter
    ├── config.ts               # Existing
    ├── db.ts                   # Existing
    ├── errors.ts               # Existing (Phase 3)
    ├── id.ts                   # Existing
    ├── logger.ts               # Existing
    ├── money.ts                # Existing
    └── seed.ts                 # Existing

tests/e2e/
├── setup.ts                    # NEW: startTestServer, stopTestServer, hc client
├── happy-paths.test.ts         # NEW: ~4 tests — full lifecycle over HTTP
├── error-responses.test.ts     # NEW: ~6 tests — error codes + shapes
├── api-contract.test.ts        # NEW: ~6 tests — response conventions
└── pagination.test.ts          # NEW: ~3 tests — cursor pagination

tests/load/
├── payment-throughput.test.ts  # NEW: ~3 tests — auth + capture load
└── concurrent-lifecycle.test.ts # NEW: ~4 tests — full lifecycle + mixed load

tests/helpers/
├── load-harness.ts             # NEW: runLoad, computePercentiles, LoadResult
├── setup.ts                    # Existing
├── god-check.ts                # Existing
├── assertions.ts               # Existing
└── factories.ts                # Existing (Phase 3)
```

New files in Phase 4: 10 files. The route handlers, middleware, E2E tests, load
tests, and the test harness. Everything else already exists.

---

## 13. Import Architecture

```
server.ts (composition root)
  ├── payments/routes.ts
  │     ├── payments/service.ts        (authorize, capture, void, refund, settle)
  │     ├── payments/schemas.ts        (Zod schemas with .openapi() metadata)
  │     └── shared/errors.ts           (AppError subclasses — for type narrowing)
  ├── ledger/routes.ts
  │     ├── ledger/service.ts          (getBalance, getTransactionsByReference)
  │     └── shared/errors.ts
  ├── shared/middleware/error-handler.ts
  │     └── shared/errors.ts           (AppError → HTTP status code mapping)
  ├── shared/middleware/security.ts
  │     └── shared/id.ts              (generateId for X-Request-ID)
  └── shared/middleware/rate-limit.ts
```

The direction is still one-way: routes import from services, services import from
shared. The middleware imports only from shared. Routes never import from each
other. `ledger/routes.ts` never imports from `payments/`. The same architectural
constraint from Phase 2 holds at every layer.

**The critical rule:** Routes call service functions. Routes do NOT contain
business logic. If a route handler has an `if` statement about payment status or
a BigInt calculation, it's in the wrong layer.

---

## 14. Response Conventions Checklist

Every route handler must produce responses that satisfy these conventions:

- [ ] Single-resource responses include `"object": "payment"` field
- [ ] Collection responses use envelope: `{ object: "list", data: [...], has_more, next_cursor }`
- [ ] All JSON fields are `snake_case` (not camelCase)
- [ ] All timestamps are ISO 8601 UTC with Z suffix
- [ ] All money amounts are integers (BigInt → Number at the boundary)
- [ ] All resource IDs are prefixed ULIDs (`pay_`, `txn_`, `ent_`)
- [ ] `X-Request-ID` header on every response
- [ ] `Idempotency-Key` echoed back as `X-Idempotency-Key` on mutation responses
- [ ] `Content-Type: application/json` on every response
- [ ] Authorize returns `201 Created`, all other mutations return `200 OK`
- [ ] Error responses use `{ error: { type, message, details? } }` — never raw strings

---

## 15. Commit Strategy

One concern per commit. Tests or implementation, never both. The route layer is
simpler than Phases 2-3, so the commit count is lower.

```
feat(api): add E2E test setup (Hono RPC server + client)
feat(api): add happy path E2E tests (~4 tests)
feat(api): implement payment routes (authorize, capture, void, refund, settle)
feat(api): implement ledger routes (balance, payment ledger)
feat(api): add error response E2E tests (~6 tests)
feat(api): implement error handler middleware
feat(api): add API contract E2E tests (~6 tests)
feat(api): wire OpenAPI schemas, X-Request-ID, security headers
feat(api): add pagination E2E tests (~3 tests)
feat(api): implement GET /payments with cursor pagination
feat(api): add load test harness
feat(api): add load tests (~7 tests)
```

12 commits. Each tells the story: test first, implementation second, infrastructure
when needed. `git bisect` finds any regression in log₂(12) ≈ 4 steps.

---

## 16. Optional: k6 Script

k6 stays in the repo for stakeholder demos and deep-dive profiling sessions. It
produces polished terminal output that non-engineers can read. But it is NOT the
backbone of the testing strategy — the custom harness is.

k6 cannot run the god check. k6 cannot verify database invariants. k6 tells you
"the system handled 500 RPS at p95 < 100ms" — it cannot tell you whether those
500 responses left the database in a consistent state.

**File:** `tests/k6/payment-flow.js`

Use the custom harness for CI. Use k6 for demos.

---

## 17. Final Gate Checklist

- [ ] All ~19 E2E tests green (`bun run test:e2e`)
- [ ] All ~7 load tests pass with acceptable latency
- [ ] God check passes after load testing (system balanced under pressure)
- [ ] `/docs` renders interactive Scalar API documentation
- [ ] `/openapi.json` returns valid OpenAPI 3.1 spec
- [ ] Every mutation endpoint requires `Idempotency-Key` header
- [ ] Every response includes `X-Request-ID` header
- [ ] Every error response uses `{ error: { type, message, details? } }` shape
- [ ] Response bodies use `snake_case` field names
- [ ] Response bodies include `object` field for type identification
- [ ] Timestamps are ISO 8601 UTC (`...Z` suffix)
- [ ] Authorize returns 201, all other mutations return 200
- [ ] Routes contain zero business logic (no state checks, no amount math)
- [ ] No circular imports (routes → services → shared, never backwards)
- [ ] `bun run lint` passes
- [ ] `bun test --bail` exits 0 (all ~330 tests: unit + integration + E2E + load)

When this gate passes, the payment engine has a public API. Clients can authorize
payments, capture funds, void holds, refund charges, settle with merchants, and
query the full audit trail — all over standard HTTP with type-safe contracts,
idempotency guarantees, and interactive documentation. And after 100 concurrent
requests, 50 capture pairs, and 20 full lifecycles, `SUM(debits) === SUM(credits)`.

---

Previous: [Phase 3 — Payment Layer](./phase-3-payments.md) | Next: [Phase 5 — Advanced Testing](./phase-5-advanced.md)
