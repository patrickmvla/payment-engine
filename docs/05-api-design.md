# API Design — Every Endpoint, Every Decision

This API is modeled after how real payment processors (Stripe, Adyen) design
their APIs. Clean, predictable, and hard to misuse.

---

## Design Principles

1. **Resource-oriented** — Payments are resources. Actions are HTTP methods.
2. **Idempotent by default** — Every mutating endpoint requires an idempotency key.
3. **Consistent error format** — Every error looks the same. Machine-parseable.
4. **Integer amounts** — All money values are in the smallest currency unit (cents).
5. **Explicit over implicit** — No magic defaults. If it matters, you must specify it.
6. **Self-documenting** — OpenAPI 3.1 spec is generated from code. Interactive docs at `/docs`.

## API Documentation

The API is documented via **OpenAPI 3.1**, generated automatically from the Zod
schemas that also validate requests. No separate spec file to maintain.

| URL | What |
|---|---|
| `GET /docs` | Interactive API documentation (Scalar UI) |
| `GET /openapi.json` | Raw OpenAPI 3.1 JSON spec |

The spec is the code. The code is the spec. Change a Zod schema and the docs
update. See [07 — API Standards](./07-api-standards.md) for the full contract.

---

## Base URL

```
http://localhost:3000/api/v1
```

Versioned from day one. When you change the API shape, old clients don't break.

---

## Headers

| Header | Required | Purpose |
|---|---|---|
| `Content-Type` | Yes | Must be `application/json` |
| `Idempotency-Key` | Yes (mutations) | Unique key to prevent duplicate operations |

---

## Endpoints

### POST /payments/authorize

Creates a new payment and authorizes (holds) the funds.

**Request:**
```json
{
  "amount": 10000,
  "currency": "USD",
  "description": "Order #12345",
  "metadata": {
    "order_id": "ord_abc",
    "customer_email": "user@example.com"
  }
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `amount` | integer | Yes | > 0, in smallest currency unit (cents for USD) |
| `currency` | string | Yes | ISO 4217 (e.g., "USD", "EUR", "GBP") |
| `description` | string | No | Max 500 chars |
| `metadata` | object | No | String key-value pairs. Max 10 keys, max 40 chars per key, max 500 chars per value. |

**Response: 201 Created**
```json
{
  "id": "pay_01HXYZ...",
  "status": "authorized",
  "amount": 10000,
  "currency": "USD",
  "authorized_amount": 10000,
  "captured_amount": 0,
  "refunded_amount": 0,
  "description": "Order #12345",
  "metadata": {
    "order_id": "ord_abc",
    "customer_email": "user@example.com"
  },
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-15T10:30:00Z",
  "expires_at": "2025-01-22T10:30:00Z"
}
```

**Errors:**
| Status | When |
|---|---|
| 400 | Invalid input (missing fields, bad currency, negative amount) |
| 409 | Idempotency key already used with different parameters |
| 422 | Amount is zero or negative |

---

### POST /payments/:id/capture

Captures (charges) a previously authorized payment.

**Request:**
```json
{
  "amount": 7000
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `amount` | integer | No | If omitted, captures full authorized amount. If provided, must be <= authorized_amount - already_captured_amount. |

**Response: 200 OK**
```json
{
  "id": "pay_01HXYZ...",
  "status": "captured",
  "amount": 10000,
  "currency": "USD",
  "authorized_amount": 10000,
  "captured_amount": 7000,
  "refunded_amount": 0,
  "description": "Order #12345",
  "metadata": { ... },
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-15T10:35:00Z",
  "expires_at": null
}
```

**Errors:**
| Status | When |
|---|---|
| 404 | Payment not found |
| 409 | Payment is not in `authorized` status |
| 422 | Capture amount exceeds remaining authorized amount |

---

### POST /payments/:id/void

Cancels an authorized payment and releases the hold.

**Request:** Empty body (no parameters needed).

**Response: 200 OK**
```json
{
  "id": "pay_01HXYZ...",
  "status": "voided",
  "amount": 10000,
  "currency": "USD",
  "authorized_amount": 10000,
  "captured_amount": 0,
  "refunded_amount": 0,
  ...
}
```

**Errors:**
| Status | When |
|---|---|
| 404 | Payment not found |
| 409 | Payment is not in `authorized` status |

---

### POST /payments/:id/settle

Settles a captured payment — records the disbursement of the merchant's share
from `merchant_payable` to `platform_cash`.

**Request:** Empty body (no parameters needed).

**Response: 200 OK**
```json
{
  "id": "pay_01HXYZ...",
  "status": "settled",
  "amount": 10000,
  "currency": "USD",
  "authorized_amount": 10000,
  "captured_amount": 10000,
  "refunded_amount": 0,
  ...
}
```

**Ledger entries created:**
```
DEBIT   merchant_payable   [merchant_share]   ← discharge liability
CREDIT  platform_cash      [merchant_share]   ← record outflow
```

Where `merchant_share = captured_amount - (captured_amount × 3 / 100)`.

**Errors:**
| Status | When |
|---|---|
| 404 | Payment not found |
| 409 | Payment is not in `captured` status |

---

### POST /payments/:id/refund

Refunds a captured or settled payment (full or partial).

**Request:**
```json
{
  "amount": 3000,
  "reason": "Customer returned item"
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `amount` | integer | No | If omitted, refunds full remaining amount. Must be <= captured_amount - refunded_amount. |
| `reason` | string | No | Max 500 chars. Stored for audit purposes. |

**Response: 200 OK**
```json
{
  "id": "pay_01HXYZ...",
  "status": "partially_refunded",
  "amount": 10000,
  "currency": "USD",
  "authorized_amount": 10000,
  "captured_amount": 7000,
  "refunded_amount": 3000,
  ...
}
```

**Status logic:**
- If `refunded_amount == captured_amount` → status becomes `refunded`
- If `refunded_amount < captured_amount` → status becomes `partially_refunded`

**Errors:**
| Status | When |
|---|---|
| 404 | Payment not found |
| 409 | Payment is not in `captured`, `settled`, or `partially_refunded` status |
| 422 | Refund amount exceeds refundable amount |

---

### GET /payments/:id

Retrieve a single payment by ID.

**Response: 200 OK**
```json
{
  "id": "pay_01HXYZ...",
  "status": "captured",
  "amount": 10000,
  "currency": "USD",
  "authorized_amount": 10000,
  "captured_amount": 10000,
  "refunded_amount": 0,
  "description": "Order #12345",
  "metadata": { ... },
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-15T10:35:00Z",
  "expires_at": null
}
```

**Errors:**
| Status | When |
|---|---|
| 404 | Payment not found |

---

### GET /payments

List payments with optional filtering and pagination.

**Query Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | Filter by status |
| `limit` | integer | 20 | Max results (1-100) |
| `cursor` | string | — | Cursor for pagination (payment ID) |

**Response: 200 OK**
```json
{
  "data": [
    { "id": "pay_01HX...", "status": "captured", ... },
    { "id": "pay_01HW...", "status": "authorized", ... }
  ],
  "has_more": true,
  "next_cursor": "pay_01HW..."
}
```

**Why cursor pagination, not offset?**
- Offset pagination breaks when records are inserted between pages
- Cursor pagination is stable and performant at any scale
- ULIDs are naturally ordered, making them perfect cursors

---

### GET /payments/:id/ledger

View the ledger entries associated with a payment. This is the audit trail.

**Response: 200 OK**
```json
{
  "payment_id": "pay_01HXYZ...",
  "transactions": [
    {
      "id": "txn_01HA...",
      "description": "Authorize payment pay_01HXYZ...",
      "created_at": "2025-01-15T10:30:00Z",
      "entries": [
        {
          "id": "ent_01HB...",
          "account": "customer_holds",
          "direction": "DEBIT",
          "amount": 10000
        },
        {
          "id": "ent_01HC...",
          "account": "customer_funds",
          "direction": "CREDIT",
          "amount": 10000
        }
      ]
    },
    {
      "id": "txn_01HD...",
      "description": "Capture payment pay_01HXYZ...",
      "created_at": "2025-01-15T10:35:00Z",
      "entries": [ ... ]
    }
  ]
}
```

This endpoint is what makes your system transparent. Any payment can be fully
explained by its ledger entries.

---

### GET /accounts/:id/balance

Query the current balance of a ledger account.

**Response: 200 OK**
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

**Balance computation:**
- Asset/Expense accounts: `SUM(DEBIT amounts) - SUM(CREDIT amounts)`
- Liability/Revenue/Equity accounts: `SUM(CREDIT amounts) - SUM(DEBIT amounts)`

This is computed live from ledger entries, not stored. The ledger is the source
of truth.

---

## Error Response Format

Every error follows the same structure:

```json
{
  "error": {
    "type": "invalid_state_transition",
    "message": "Cannot capture a payment with status 'voided'",
    "details": {
      "payment_id": "pay_01HXYZ...",
      "current_status": "voided",
      "attempted_action": "capture"
    }
  }
}
```

| Field | Always Present | Description |
|---|---|---|
| `error.type` | Yes | Machine-readable error code (snake_case) |
| `error.message` | Yes | Human-readable explanation |
| `error.details` | No | Additional context (varies by error type) |

### Error Types

| Type | HTTP Status | Description |
|---|---|---|
| `validation_error` | 400 | Request body failed validation |
| `not_found` | 404 | Resource doesn't exist |
| `invalid_state_transition` | 409 | Payment is not in the right status for this action |
| `idempotency_conflict` | 409 | Same key used with different parameters |
| `invalid_amount` | 422 | Amount violates business rules |
| `internal_error` | 500 | Something went wrong on our side |

---

## Idempotency Behavior

| Scenario | Result |
|---|---|
| New key, valid request | Process normally, store result |
| Same key, same params | Return stored result (no reprocessing) |
| Same key, different params | 409 Conflict |
| Expired key (>24h), any params | Treated as new key |
| Missing key on mutation | 400 Bad Request |
| Key on GET request | Ignored (GETs are naturally idempotent) |

---

## Status Codes Summary

| Code | Meaning | When |
|---|---|---|
| 200 | OK | Successful read or update |
| 201 | Created | New payment authorized |
| 400 | Bad Request | Invalid input |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Invalid state transition or idempotency conflict |
| 422 | Unprocessable Entity | Valid input but violates business rules |
| 500 | Internal Server Error | Bug on our side |

---

Previous: [04 — Data Model](./04-data-model.md) | Next: [06 — Invariants](./06-invariants.md)
