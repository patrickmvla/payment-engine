# API Standards — The Contract Between Us and Every Client

A payment API isn't just endpoints. It's a contract. Every header, status code,
error shape, and versioning decision tells the client developer: "you can trust
this system." This document defines that contract.

---

## 1. Versioning Strategy

### Approach: URL Path Versioning

```
/api/v1/payments/authorize
/api/v2/payments/authorize    ← future
```

**Why URL path versioning over alternatives?**

| Strategy | Example | Verdict |
|---|---|---|
| URL path | `/api/v1/...` | **Chosen.** Explicit, visible, easy to route, impossible to forget. |
| Header (`Accept-Version: v1`) | `Accept-Version: v1` | Hidden. Clients forget it. Debugging is harder. |
| Query param (`?version=1`) | `/payments?version=1` | Pollutes query string. Caching is awkward. |
| Content negotiation (`Accept: application/vnd.api.v1+json`) | — | Overly complex for no real benefit at our scale. |

Every fintech that matters (Stripe, Square, Adyen) uses URL path versioning.
It's battle-tested.

### Versioning Rules

1. **v1 is the only version at launch.** Don't pre-build v2 infrastructure.
2. **A new version is created ONLY when breaking changes are necessary:**
   - Removing a field from a response
   - Changing a field's type
   - Changing the meaning of a status code
   - Restructuring the response shape
3. **Non-breaking changes do NOT require a new version:**
   - Adding a new optional field to a request
   - Adding a new field to a response
   - Adding a new endpoint
   - Adding a new enum value (if clients handle unknown values gracefully)
4. **Old versions are supported for a minimum deprecation period** (see
   Deprecation Policy below).

### Version Lifecycle

```
v1 ACTIVE ──────────────────────────────────────────▶ v1 DEPRECATED ──▶ v1 SUNSET
                    v2 ACTIVE ──────────────────────────────────────────▶ ...

                    │◀── deprecation notice ──▶│◀── sunset period ──▶│
                           (6 months)                 (3 months)
```

- **ACTIVE** — Fully supported. Receiving bug fixes and security patches.
- **DEPRECATED** — Still functional. Clients receive `Sunset` and
  `Deprecation` headers. No new features.
- **SUNSET** — Removed. Requests return `410 Gone`.

---

## 2. Request Conventions

### Content Type

```
Content-Type: application/json
```

All requests and responses use JSON. No XML. No form encoding. No exceptions.

Requests without `Content-Type: application/json` on mutation endpoints receive:

```
415 Unsupported Media Type
```

### Request Headers

| Header | Required | Purpose | Example |
|---|---|---|---|
| `Content-Type` | Yes (mutations) | Must be `application/json` | `application/json` |
| `Idempotency-Key` | Yes (mutations) | Prevents duplicate operations | `ik_a1b2c3d4e5` |
| `X-Request-ID` | No | Client-provided request trace ID | `req_f6g7h8i9` |

### Idempotency Key Format

Clients can use any string up to 255 characters, but we recommend:

```
ik_{uuid_v4}
```

Example: `ik_550e8400-e29b-41d4-a716-446655440000`

**Rules:**
- Required on all `POST` endpoints (mutations)
- Ignored on `GET` endpoints (reads are naturally idempotent)
- Keys expire after **24 hours** — reuse after expiry creates a new operation
- Max length: 255 characters
- Case-sensitive: `ik_ABC` and `ik_abc` are different keys
- **Globally scoped** — keys are unique across all operations. Using `ik_abc`
  for authorize and then reusing `ik_abc` for capture is a conflict. Each
  distinct operation requires its own unique key.

---

## 3. Response Conventions

### Standard Response Envelope

**Single resource:**
```json
{
  "id": "pay_01HXYZ...",
  "object": "payment",
  "status": "authorized",
  "amount": 10000,
  "currency": "USD",
  ...
}
```

**Collection:**
```json
{
  "object": "list",
  "data": [
    { "id": "pay_01HX...", "object": "payment", ... },
    { "id": "pay_01HW...", "object": "payment", ... }
  ],
  "has_more": true,
  "next_cursor": "pay_01HW..."
}
```

**Why the `object` field?** — When a client receives a response, they
immediately know what type of resource they're looking at without checking the
URL or inferring from fields. Stripe does this. It makes client SDK development
significantly easier.

### JSON Field Naming

All JSON fields use **snake_case**: `authorized_amount`, `created_at`,
`has_more`, `next_cursor`. TypeScript code uses camelCase internally, but the
API boundary is always snake_case. This applies to request bodies, response
bodies, error details, and query parameters.

### Response Headers

Every response includes:

| Header | Purpose | Example |
|---|---|---|
| `Content-Type` | Response format | `application/json` |
| `X-Request-ID` | Our trace ID for this request (or echo of client's) | `req_01HXYZ...` |
| `X-Idempotency-Key` | Echo of the key used (confirms it was processed) | `ik_550e8400...` |
| `RateLimit-Limit` | Max requests per window | `1000` |
| `RateLimit-Remaining` | Remaining requests in window | `997` |
| `RateLimit-Reset` | Seconds until window resets | `42` |

**On deprecated API versions, also include:**

| Header | Purpose | Example |
|---|---|---|
| `Deprecation` | Date when deprecation was announced | `Sat, 01 Mar 2025 00:00:00 GMT` |
| `Sunset` | Date when this version will be removed | `Sun, 01 Sep 2025 00:00:00 GMT` |
| `Link` | URL to migration guide | `<https://docs.api.com/migrate/v2>; rel="successor-version"` |

---

## 4. Resource Naming & ID Format

### Resource IDs

Every resource has a **prefixed ULID**:

| Resource | Prefix | Example |
|---|---|---|
| Payment | `pay_` | `pay_01HXYZ9ABC123...` |
| Ledger Transaction | `txn_` | `txn_01HXYZ9DEF456...` |
| Ledger Entry | `ent_` | `ent_01HXYZ9GHI789...` |

**Why prefixed?**
- A log line saying `"processing 01HXYZ..."` is useless. Is it a payment? A
  transaction? An entry?
- `"processing pay_01HXYZ..."` — immediately clear.
- Prevents accidentally passing a transaction ID where a payment ID is expected.

**Why ULID over UUID?**
- Time-sortable — natural ordering without a separate timestamp index
- Shorter than UUID (26 chars vs 36)
- Monotonically increasing — better for database index performance
- URL-safe — no hyphens needed

### URL Naming

```
POST   /api/v1/payments/authorize      ← action as verb (creates a resource)
POST   /api/v1/payments/:id/capture    ← action on existing resource
POST   /api/v1/payments/:id/void
POST   /api/v1/payments/:id/refund
GET    /api/v1/payments/:id            ← read single
GET    /api/v1/payments                ← read collection
GET    /api/v1/payments/:id/ledger     ← sub-resource
GET    /api/v1/accounts/:id/balance    ← computed sub-resource
```

**Why POST for actions instead of PATCH/PUT?**
- `capture`, `void`, and `refund` are not "updates" — they're domain actions
  that trigger complex side effects (ledger entries, state transitions).
- Using `PATCH /payments/:id { status: "captured" }` would imply the client
  controls state directly. They don't. The system enforces the state machine.
- POST for commands, GET for queries. Clean separation.

---

## 5. Pagination

### Cursor-Based Pagination

```
GET /api/v1/payments?limit=20
GET /api/v1/payments?limit=20&cursor=pay_01HW...
```

| Param | Type | Default | Range | Description |
|---|---|---|---|---|
| `limit` | integer | 20 | 1-100 | Number of results per page |
| `cursor` | string | — | — | ID of the last item from previous page |

**Response:**
```json
{
  "object": "list",
  "data": [ ... ],
  "has_more": true,
  "next_cursor": "pay_01HW..."
}
```

**Why cursor pagination, not offset?**

| | Offset (`?page=3&per_page=20`) | Cursor (`?cursor=pay_01HW...`) |
|---|---|---|
| New records inserted | Duplicates or missed items across pages | Stable — always picks up where you left off |
| Performance at scale | `OFFSET 10000` scans and discards 10k rows | `WHERE id < cursor` uses index, constant speed |
| Bookmarkable | Page 3 means different things at different times | Cursor always points to the same boundary |

For a financial system where new transactions are constantly being created,
cursor pagination is the only correct choice.

### Sort Order

Results are always returned in **reverse chronological order** (newest first).
Since ULIDs are time-sorted, this is `ORDER BY id DESC`.

No configurable sort order in v1. Financial data is almost always queried
newest-first.

### Edge Cases

| Request | Behavior |
|---|---|
| `limit=0` | `400` — minimum is 1 |
| `limit=150` | `400` — maximum is 100 |
| `cursor=nonexistent_id` | `200` with empty `data` and `has_more: false` |
| `cursor=invalid_format` | `400` — cursor must be a valid payment ID format |
| No results match filters | `200` with `data: []`, `has_more: false`, `next_cursor: null` |

---

## 6. Filtering

```
GET /api/v1/payments?status=authorized
GET /api/v1/payments?status=captured&currency=USD
GET /api/v1/payments?created_after=2025-01-01T00:00:00Z
GET /api/v1/payments?created_before=2025-01-31T23:59:59Z
```

| Param | Type | Description |
|---|---|---|
| `status` | string | Filter by payment status |
| `currency` | string | Filter by currency code |
| `created_after` | ISO 8601 | Payments created after this timestamp |
| `created_before` | ISO 8601 | Payments created before this timestamp |

**Rules:**
- Unknown filter params are silently ignored (not an error)
- Multiple filters are combined with AND logic
- Empty results return `200` with `"data": []`, not `404`

---

## 7. Rate Limiting

### Strategy: Token Bucket Per API Key

```
Rate: 1000 requests per minute (configurable)
Burst: Up to 50 requests in a single second
```

| Header | Description |
|---|---|
| `RateLimit-Limit` | Total requests allowed per window |
| `RateLimit-Remaining` | Remaining requests in current window |
| `RateLimit-Reset` | Seconds until the window resets |

**When rate limited:**

```
429 Too Many Requests

{
  "error": {
    "type": "rate_limit_exceeded",
    "message": "Rate limit exceeded. Retry after 12 seconds.",
    "retry_after": 12
  }
}
```

Also includes `Retry-After: 12` header.

**v1 implementation:** In-memory per-IP rate limiter (no API key auth yet).
The token bucket per-API-key approach described above is the v2 target.
Production would use Redis with a sliding window algorithm. See
[10 — Security](./10-security.md) for the v1 middleware implementation.

---

## 8. Request Tracing

Every request gets a unique trace ID for debugging and support:

### Flow

```
Client sends:    X-Request-ID: req_client_123     (optional)
Server generates: X-Request-ID: req_01HXYZ...     (always)

If client provides an ID → server echoes it back AND logs both
If client doesn't → server generates one and returns it
```

### Why This Matters

When a client says "my payment failed," you ask: "What's the request ID?"

```
Support: "Give me the request ID"
Client:  "req_01HXYZ..."
You:     grep req_01HXYZ... in logs → full trace of what happened
```

Without request IDs, debugging is guesswork.

### Logging Format

Every log line includes the request ID:

```json
{
  "request_id": "req_01HXYZ...",
  "method": "POST",
  "path": "/api/v1/payments/authorize",
  "status": 201,
  "duration_ms": 45,
  "idempotency_key": "ik_550e...",
  "payment_id": "pay_01HABC..."
}
```

Structured JSON logs. Not strings. Structured logs are searchable, parseable,
and aggregatable.

---

## 9. Error Standards

### Error Response Shape (RFC 7807 Inspired)

```json
{
  "error": {
    "type": "invalid_state_transition",
    "message": "Cannot capture a payment with status 'voided'.",
    "details": {
      "payment_id": "pay_01HXYZ...",
      "current_status": "voided",
      "attempted_action": "capture",
      "allowed_actions": []
    }
  }
}
```

### Error Type Taxonomy

```
validation_error          400   Input failed schema validation
invalid_request           400   Malformed request (bad JSON, wrong content type)
authentication_error      401   Missing or invalid API key (future)
not_found                 404   Resource does not exist
method_not_allowed        405   HTTP method not supported on this endpoint
idempotency_conflict      409   Key reused with different parameters
invalid_state_transition  409   Action not allowed in current payment state
invalid_amount            422   Amount violates business rules
rate_limit_exceeded       429   Too many requests
internal_error            500   Unexpected server failure
```

### Validation Error Detail

When input validation fails, the error includes per-field details:

```json
{
  "error": {
    "type": "validation_error",
    "message": "Request validation failed.",
    "details": {
      "fields": [
        {
          "field": "amount",
          "message": "Must be a positive integer",
          "received": -500
        },
        {
          "field": "currency",
          "message": "Must be a valid ISO 4217 currency code",
          "received": "DOLLARS"
        }
      ]
    }
  }
}
```

Clients can programmatically map errors to form fields. No string parsing.

### Not Found Detail

```json
{
  "error": {
    "type": "not_found",
    "message": "Payment not found.",
    "details": {
      "resource_type": "payment",
      "resource_id": "pay_01HXYZ..."
    }
  }
}
```

### Idempotency Conflict Detail

```json
{
  "error": {
    "type": "idempotency_conflict",
    "message": "Idempotency key already used with different parameters.",
    "details": {
      "idempotency_key": "ik_550e8400...",
      "existing_resource_id": "pay_01HABC..."
    }
  }
}
```

### Invalid Amount Detail

```json
{
  "error": {
    "type": "invalid_amount",
    "message": "Capture amount exceeds remaining authorized amount.",
    "details": {
      "requested_amount": 15000,
      "maximum_allowed": 10000,
      "reason": "exceeds_authorized"
    }
  }
}
```

Possible `reason` values: `exceeds_authorized`, `exceeds_refundable`,
`below_minimum`, `above_maximum`.

### Invalid State Transition Detail

Shown in the section 9 example above. Fields in `details`:

| Field | Description |
|---|---|
| `payment_id` | The payment that was targeted |
| `current_status` | The payment's current status |
| `attempted_action` | The action that was attempted (`capture`, `void`, `refund`) |
| `allowed_actions` | Actions valid in the current status (empty for terminal states) |

---

## 10. Timestamp Format

All timestamps use **ISO 8601 in UTC**:

```
2025-01-15T10:30:00Z
```

- Always UTC (Z suffix). Never local time. Never ambiguous.
- Seconds precision minimum. Implementations may include millisecond
  precision (e.g., `2025-01-15T10:30:00.123Z`). Clients must parse both.
- Stored as `TIMESTAMP WITH TIME ZONE` in PostgreSQL (microsecond precision
  internally).

**Why not Unix timestamps?**
- ISO 8601 is human-readable in logs and debuggers
- No ambiguity about seconds vs milliseconds
- Every language has native ISO 8601 parsing

---

## 11. Currency Handling

### Rules

1. Currency is always **ISO 4217** uppercase: `USD`, `EUR`, `GBP`, `JPY`
2. Amount is always in the **smallest currency unit**:

| Currency | Unit | $10.50 represented as |
|---|---|---|
| USD | cents | `1050` |
| EUR | cents | `1050` |
| GBP | pence | `1050` |
| JPY | yen (no subunit) | `10` |
| BHD | fils (1/1000) | `10500` |

3. Currency is **locked at authorization** — you cannot capture in a different
   currency than you authorized.
4. Amounts in responses always include the currency for unambiguous
   interpretation.

### Zero-Decimal Currencies

Some currencies have no fractional unit (JPY, KRW, VND). The API handles this
transparently — the client always sends the amount in the smallest unit. For
JPY, 1000 means 1000 yen, not 10 yen.

We maintain a currency configuration that knows the decimal places for each
currency:

```typescript
const CURRENCY_DECIMALS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,   // no subunit
  BHD: 3,   // three decimal places
}
```

**Validation behavior:**
- Unsupported currency codes return `400 validation_error`
- v1 supports: `USD`, `EUR`, `GBP`, `JPY`, `BHD`
- Currency is validated against the configuration, not hardcoded in Zod schemas
- Must be uppercase: `usd` is rejected, `USD` is accepted

---

## 12. Webhook Design (v2)

Not implemented in v1, but designed for:

### Event Types

```
payment.authorized
payment.captured
payment.voided
payment.refunded
payment.expired
```

### Payload Shape

```json
{
  "id": "evt_01HXYZ...",
  "object": "event",
  "type": "payment.captured",
  "created_at": "2025-01-15T10:35:00Z",
  "data": {
    "id": "pay_01HXYZ...",
    "object": "payment",
    "status": "captured",
    ...
  }
}
```

### Delivery Guarantees

- **At-least-once delivery** — events may be delivered more than once
- Clients must handle duplicates (use `evt_` ID for deduplication)
- Failed deliveries retry with exponential backoff (1s, 2s, 4s, 8s, ... up to 24h)
- Events are signed with HMAC-SHA256 for verification

---

## 13. Health Check Endpoint

```
GET /health
```

**Response: 200 OK**
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime_seconds": 84321
}
```

**Response: 503 Service Unavailable** (database down)
```json
{
  "status": "unhealthy",
  "version": "1.0.0",
  "checks": {
    "database": "unreachable"
  }
}
```

Not versioned. Not authenticated. Load balancers and monitoring tools hit this.

---

## 14. Deprecation Policy

When a breaking change is needed:

1. **Announce** — 6 months before removal, add `Deprecation` header to old
   version responses
2. **Document** — Publish migration guide with before/after examples
3. **Notify** — Log which clients are still using the deprecated version
4. **Sunset** — After the sunset date, old version returns `410 Gone`

```
410 Gone

{
  "error": {
    "type": "version_sunset",
    "message": "API v1 has been sunset. Please migrate to v2.",
    "migration_guide": "https://docs.api.com/migrate/v2"
  }
}
```

---

## 15. OpenAPI Specification

### Approach: Code-First with `@hono/zod-openapi`

The OpenAPI 3.1 spec is **generated from code**, not maintained separately. The
Zod schemas that validate requests are the same schemas that produce the spec.

```
Zod Schema ──┬──▶ Runtime validation (rejects bad requests)
             ├──▶ TypeScript types (compile-time safety)
             └──▶ OpenAPI 3.1 spec (auto-generated documentation)
```

### How It Works

Every route is defined using `createRoute()` with schemas attached:

```typescript
import { createRoute, z } from "@hono/zod-openapi";

const AuthorizeBodySchema = z.object({
  amount: z.number().int().positive().openapi({
    example: 10000,
    description: "Amount in smallest currency unit (e.g., cents)",
  }),
  currency: z.string().length(3).openapi({
    example: "USD",
    description: "ISO 4217 currency code",
  }),
  description: z.string().max(500).optional().openapi({
    example: "Order #12345",
  }),
});

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
  },
  responses: {
    201: {
      description: "Payment authorized successfully",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Idempotency conflict or invalid state",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
```

This single definition:
- Validates the request body at runtime
- Provides TypeScript types for the handler
- Generates the OpenAPI spec entry for this endpoint
- Documents request/response shapes, examples, and error cases

### Spec Metadata

```typescript
const app = new OpenAPIHono();

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Payment Engine API",
    version: "1.0.0",
    description: "A payment processing engine with double-entry ledger",
    contact: {
      name: "API Support",
    },
  },
  servers: [
    { url: "http://localhost:3000", description: "Local development" },
  ],
});
```

### Documentation UI

Interactive API docs are served via **Scalar** at `/docs`:

```typescript
import { apiReference } from "@scalar/hono-api-reference";

app.get("/docs", apiReference({
  spec: { url: "/openapi.json" },
  theme: "kepler",
}));
```

Developers can:
- Browse all endpoints with descriptions and examples
- See request/response schemas with field-level documentation
- Try endpoints directly from the browser (try-it-out)
- Download the spec for client SDK generation

### Spec Organization (Tags)

Endpoints are grouped by tags for readability:

| Tag | Endpoints |
|---|---|
| `Payments` | authorize, capture, void, refund, get, list |
| `Ledger` | payment ledger entries, account balances |
| `System` | health check |

### Client SDK Generation (Future)

The OpenAPI spec enables automatic client SDK generation:

```bash
# Generate a TypeScript client from the spec
npx openapi-typescript http://localhost:3000/openapi.json -o ./client/api.d.ts
```

This is a v2 feature, but the spec being available from day one means it's
always an option.

---

## 16. API Design Checklist

Every endpoint must satisfy:

- [ ] Uses correct HTTP method (POST for commands, GET for queries)
- [ ] Defined via `createRoute()` with Zod schemas (validation + docs)
- [ ] Has `.openapi()` metadata on schema fields (examples, descriptions)
- [ ] Returns consistent error format
- [ ] Requires `Idempotency-Key` on mutations
- [ ] Includes `X-Request-ID` in response
- [ ] Documents all possible status codes in route definition
- [ ] Handles `Content-Type` validation
- [ ] Rate limit headers are present
- [ ] Timestamps are ISO 8601 UTC
- [ ] Money amounts are integers in smallest unit
- [ ] Resource IDs are prefixed ULIDs
- [ ] Response includes `object` field for type identification
- [ ] Tagged for grouping in Scalar UI

---

Previous: [06 — Invariants](./06-invariants.md) | Next: [08 — Testing Strategy](./08-testing-strategy.md)
