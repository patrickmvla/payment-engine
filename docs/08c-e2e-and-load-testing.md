# E2E & Load Testing — Type-Safe HTTP and Correctness Under Pressure

Two testing layers sit above integration tests in the payment engine's testing pyramid:

1. **Hono RPC E2E tests** — functional correctness over real HTTP, with full compile-time type safety on every request and response.
2. **Custom load harness** — performance measurement fused with invariant verification. Every load burst ends with a god check.

Together they answer two questions no unit or integration test can: "Does the system behave correctly over a real TCP connection?" and "Does it stay correct when 100 clients hit it simultaneously?"

---

## 1. Why Hono RPC, Not `app.request()`

Hono ships with `app.request()`, a convenience method that calls your handler directly in-process. Many teams use it for "E2E" tests. It is not E2E.

The problem with `app.request()`:

- It calls the handler function directly — no TCP socket, no HTTP parsing, no content-length negotiation.
- It skips real middleware ordering. A middleware that depends on a raw `Request` object parsed from the wire may behave differently than one that receives a synthetically constructed `Request`.
- It does not test header parsing, transfer encoding, or connection handling.
- It is integration testing pretending to be E2E.

The difference in request flow:

```
app.request()  ->  Handler  ->  Service  ->  DB       (no network layer)
Hono RPC (hc)  ->  TCP  ->  HTTP  ->  Hono  ->  Handler  ->  Service  ->  DB   (real E2E)
```

Why Hono RPC (`hc`) is the right tool:

- **Ships with Hono** — zero extra dependencies. Import `hc` from `hono/client` and you have a fully typed HTTP client.
- **Type-safe at compile time** — request bodies, response shapes, URL parameters, and headers are all checked by TypeScript before a single test runs. If you rename a field in your Zod schema, every test that references the old name fails at `tsc` time.
- **Real HTTP requests** — the client opens a TCP connection to a running `Bun.serve()` instance. Every byte travels through the full HTTP stack.
- **Schema-driven contracts** — because `@hono/zod-openapi` defines routes with Zod schemas and those schemas flow into `AppType`, the RPC client enforces the exact API contract. Change the contract, tests break at compile time BEFORE you run them.

---

## 2. E2E Test Setup

The test setup starts a real HTTP server on a dedicated port and creates a type-safe client bound to the full route tree.

```typescript
// tests/e2e/setup.ts
import { app } from "../../src/server";
import { hc } from "hono/client";
import type { AppType } from "../../src/server";

let server: ReturnType<typeof Bun.serve>;
let client: ReturnType<typeof hc<AppType>>;

const TEST_PORT = 4567; // Avoid conflicting with dev server on 3000
const BASE_URL = `http://localhost:${TEST_PORT}`;

export async function startTestServer() {
  server = Bun.serve({
    fetch: app.fetch,
    port: TEST_PORT,
  });
  client = hc<AppType>(BASE_URL);
  return client;
}

export async function stopTestServer() {
  server.stop();
}

export { client, BASE_URL };
```

Key details:

- `AppType` is exported from `server.ts`. It carries the full route type graph — every route, every parameter, every request body shape, every response shape. This is the single source of truth for the API contract.
- `hc<AppType>(BASE_URL)` creates a client that mirrors the entire route tree as nested objects. Accessing `client.api.v1.payments.authorize.$post(...)` is type-checked against the actual route definition.
- The test port (`4567`) is deliberately different from the development server port (`3000`) to allow running tests while the dev server is up.
- `Bun.serve` binds the same `app.fetch` handler that production uses. There is no test-specific server configuration — what you test is what you ship.

---

## 3. Type-Safe E2E Tests

### 3.1 Happy Paths

Full lifecycle tests verify that the core payment flows work end-to-end over real HTTP.

```typescript
// tests/e2e/happy-paths.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { startTestServer, stopTestServer, client } from "./setup";
import { setupTestDB, teardownTestDB, cleanBetweenTests } from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

describe("e2e: happy paths (Hono RPC)", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });
  afterEach(async () => { await cleanBetweenTests(); });

  test("full lifecycle: authorize -> capture -> refund", async () => {
    // Authorize — type-safe: amount must be number, currency must be string
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(authRes.status).toBe(201);
    const payment = await authRes.json();
    expect(payment.status).toBe("authorized");
    expect(payment.id).toMatch(/^pay_/);

    // Capture — :id param is type-checked
    const capRes = await client.api.v1.payments[":id"].capture.$post({
      param: { id: payment.id },
      json: {},
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(capRes.status).toBe(200);
    const captured = await capRes.json();
    expect(captured.status).toBe("captured");

    // Refund
    const refRes = await client.api.v1.payments[":id"].refund.$post({
      param: { id: payment.id },
      json: {},
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(refRes.status).toBe(200);
    const refunded = await refRes.json();
    expect(refunded.status).toBe("refunded");
  });

  test("authorize -> void", async () => {
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 5000, currency: "EUR" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const payment = await authRes.json();

    const voidRes = await client.api.v1.payments[":id"].void.$post({
      param: { id: payment.id },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(voidRes.status).toBe(200);
    expect((await voidRes.json()).status).toBe("voided");
  });

  test("authorize -> capture -> settle -> refund", async () => {
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const payment = await authRes.json();

    // Capture
    const capRes = await client.api.v1.payments[":id"].capture.$post({
      param: { id: payment.id },
      json: {},
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(capRes.status).toBe(200);

    // Settle
    const settleRes = await client.api.v1.payments[":id"].settle.$post({
      param: { id: payment.id },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(settleRes.status).toBe(200);
    expect((await settleRes.json()).status).toBe("settled");

    // Refund after settlement
    const refRes = await client.api.v1.payments[":id"].refund.$post({
      param: { id: payment.id },
      json: {},
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(refRes.status).toBe(200);
    expect((await refRes.json()).status).toBe("refunded");
  });

  test("authorize -> partial capture -> partial refund -> refund remainder", async () => {
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const payment = await authRes.json();

    // Partial capture
    const capRes = await client.api.v1.payments[":id"].capture.$post({
      param: { id: payment.id },
      json: { amount: 7000 },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const captured = await capRes.json();
    expect(captured.captured_amount).toBe(7000);

    // Partial refund
    const ref1 = await client.api.v1.payments[":id"].refund.$post({
      param: { id: payment.id },
      json: { amount: 3000 },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect((await ref1.json()).status).toBe("partially_refunded");

    // Refund remainder
    const ref2 = await client.api.v1.payments[":id"].refund.$post({
      param: { id: payment.id },
      json: { amount: 4000 },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const final = await ref2.json();
    expect(final.status).toBe("refunded");
    expect(final.refunded_amount).toBe(7000);
  });
});
```

A critical benefit of Hono RPC: type errors are caught at compile time, not runtime.

```typescript
// This would fail at COMPILE TIME, not runtime:
await client.api.v1.payments.authorize.$post({
  json: { amount: "not a number", currency: 123 },
  //              ^ Type error!       ^ Type error!
});
```

If the `authorize` route's Zod schema says `amount` is `z.number()` and `currency` is `z.string()`, TypeScript will reject the above code before `bun test` ever executes. This is the compile-time contract enforcement that `app.request()` cannot provide, because `app.request()` takes an untyped `Request` object.

### 3.2 Error Responses

Error response tests verify that the API returns correct HTTP status codes and error shapes for invalid requests and impossible state transitions.

```typescript
// tests/e2e/error-responses.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { startTestServer, stopTestServer, client, BASE_URL } from "./setup";
import { setupTestDB, teardownTestDB, cleanBetweenTests } from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

describe("e2e: error responses", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });
  afterEach(async () => { await cleanBetweenTests(); });

  test("missing idempotency key -> 400", async () => {
    // Use raw fetch here since hc would require the header
    const res = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("validation_error");
  });

  test("invalid state transition -> 409", async () => {
    // Create and void
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const payment = await authRes.json();

    await client.api.v1.payments[":id"].void.$post({
      param: { id: payment.id },
      header: { "Idempotency-Key": uniqueKey() },
    });

    // Try to capture voided payment
    const res = await client.api.v1.payments[":id"].capture.$post({
      param: { id: payment.id },
      json: {},
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(res.status).toBe(409);
    const error = await res.json();
    expect(error.error.type).toBe("invalid_state_transition");
    expect(error.error.details.current_status).toBe("voided");
  });

  test("non-existent payment -> 404", async () => {
    const res = await client.api.v1.payments[":id"].$get({
      param: { id: "pay_nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  test("capture exceeding authorization -> 422", async () => {
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const payment = await authRes.json();

    const res = await client.api.v1.payments[":id"].capture.$post({
      param: { id: payment.id },
      json: { amount: 20000 },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(res.status).toBe(422);
  });

  test("settle non-captured payment -> 409", async () => {
    const authRes = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const payment = await authRes.json();

    const res = await client.api.v1.payments[":id"].settle.$post({
      param: { id: payment.id },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(res.status).toBe(409);
    const error = await res.json();
    expect(error.error.type).toBe("invalid_state_transition");
  });

  test("idempotency conflict -> 409", async () => {
    const key = uniqueKey();
    await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": key },
    });

    const res = await client.api.v1.payments.authorize.$post({
      json: { amount: 99999, currency: "USD" }, // different amount
      header: { "Idempotency-Key": key },       // same key
    });
    expect(res.status).toBe(409);
  });
});
```

### 3.3 API Contract Tests

Contract tests verify the shape and conventions of API responses — field names, header presence, ID formats, timestamp formats. These are the tests that catch accidental breaking changes to the API surface.

```typescript
// tests/e2e/api-contract.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { startTestServer, stopTestServer, client, BASE_URL } from "./setup";
import { setupTestDB, teardownTestDB, cleanBetweenTests } from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

describe("e2e: API contract", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });
  afterEach(async () => { await cleanBetweenTests(); });

  test("response includes object field", async () => {
    const res = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const body = await res.json();
    expect(body.object).toBe("payment");
  });

  test("response includes X-Request-ID header", async () => {
    const res = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    expect(res.headers.get("X-Request-ID")).toBeDefined();
  });

  test("list endpoint returns correct shape", async () => {
    const res = await client.api.v1.payments.$get();
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.has_more).toBe("boolean");
  });

  test("timestamps are ISO 8601 UTC", async () => {
    const res = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const body = await res.json();
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("payment IDs are prefixed ULIDs", async () => {
    const res = await client.api.v1.payments.authorize.$post({
      json: { amount: 10000, currency: "USD" },
      header: { "Idempotency-Key": uniqueKey() },
    });
    const body = await res.json();
    expect(body.id).toMatch(/^pay_/);
  });

  test("health check returns correct shape", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(typeof body.version).toBe("string");
  });
});
```

### 3.4 Pagination Tests

Pagination tests verify cursor-based pagination behavior — correct page sizes, no overlap between pages, proper `has_more` signaling, and graceful handling of empty result sets.

```typescript
// tests/e2e/pagination.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { startTestServer, stopTestServer, client } from "./setup";
import { setupTestDB, teardownTestDB, cleanBetweenTests } from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

describe("e2e: pagination", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });
  afterEach(async () => { await cleanBetweenTests(); });

  test("returns correct page size", async () => {
    // Create 5 payments
    for (let i = 0; i < 5; i++) {
      await client.api.v1.payments.authorize.$post({
        json: { amount: 1000 * (i + 1), currency: "USD" },
        header: { "Idempotency-Key": uniqueKey() },
      });
    }

    const res = await client.api.v1.payments.$get({ query: { limit: "3" } });
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
  });

  test("cursor pagination returns next page without overlap", async () => {
    for (let i = 0; i < 5; i++) {
      await client.api.v1.payments.authorize.$post({
        json: { amount: 1000, currency: "USD" },
        header: { "Idempotency-Key": uniqueKey() },
      });
    }

    const page1Res = await client.api.v1.payments.$get({ query: { limit: "3" } });
    const page1 = await page1Res.json();

    const page2Res = await client.api.v1.payments.$get({
      query: { limit: "3", cursor: page1.next_cursor },
    });
    const page2 = await page2Res.json();

    expect(page2.data).toHaveLength(2);
    expect(page2.has_more).toBe(false);

    const page1Ids = new Set(page1.data.map((p: any) => p.id));
    for (const p of page2.data) {
      expect(page1Ids.has(p.id)).toBe(false);
    }
  });

  test("empty results return 200 with empty data", async () => {
    const res = await client.api.v1.payments.$get();
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
  });
});
```

---

## 4. The Load Testing Harness

k6 measures performance. Our custom harness measures performance AND verifies correctness. After every load burst, the god check runs — the same `verifySystemBalance` function used in integration tests. This is the critical difference: a load test that produces high throughput numbers but leaves the database in an inconsistent state is worse than useless. It is actively misleading.

The harness runs inside `bun:test`. No extra tooling, no separate process, no JavaScript-to-Go bridge. It is part of the same test pipeline as everything else.

### 4.1 The Harness

```typescript
// tests/helpers/load-harness.ts

export interface LoadResult {
  totalRequests: number;
  succeeded: number;
  failed: number;
  duration: number;
  rps: number;
  latencies: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
    min: number;
    avg: number;
  };
  errors: Map<string, number>;
}

export function computePercentiles(values: number[]): LoadResult["latencies"] {
  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;

  return {
    p50: sorted[Math.floor(len * 0.5)] ?? 0,
    p95: sorted[Math.floor(len * 0.95)] ?? 0,
    p99: sorted[Math.floor(len * 0.99)] ?? 0,
    max: sorted[len - 1] ?? 0,
    min: sorted[0] ?? 0,
    avg: len > 0 ? sorted.reduce((a, b) => a + b, 0) / len : 0,
  };
}

export async function runLoad(
  name: string,
  concurrency: number,
  totalRequests: number,
  operation: () => Promise<Response>
): Promise<LoadResult> {
  const latencies: number[] = [];
  const errors = new Map<string, number>();
  let succeeded = 0;
  let failed = 0;

  const startTime = performance.now();

  // Execute in waves of `concurrency`
  for (let i = 0; i < totalRequests; i += concurrency) {
    const batchSize = Math.min(concurrency, totalRequests - i);
    const batch = Array.from({ length: batchSize }, async () => {
      const start = performance.now();
      try {
        const res = await operation();
        const elapsed = performance.now() - start;
        latencies.push(elapsed);

        if (res.ok) {
          succeeded++;
        } else {
          failed++;
          const key = `HTTP ${res.status}`;
          errors.set(key, (errors.get(key) ?? 0) + 1);
        }
      } catch (err) {
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        failed++;
        const key = err instanceof Error ? err.message : "unknown";
        errors.set(key, (errors.get(key) ?? 0) + 1);
      }
    });

    await Promise.allSettled(batch);
  }

  const duration = performance.now() - startTime;

  const result: LoadResult = {
    totalRequests,
    succeeded,
    failed,
    duration,
    rps: (totalRequests / duration) * 1000,
    latencies: computePercentiles(latencies),
    errors,
  };

  // Print report
  console.log(`\n--- Load Test: ${name}`);
  console.log(`   Requests:  ${result.totalRequests} (${result.succeeded} ok, ${result.failed} failed)`);
  console.log(`   Duration:  ${result.duration.toFixed(0)}ms`);
  console.log(`   RPS:       ${result.rps.toFixed(1)}`);
  console.log(`   Latency:   p50=${result.latencies.p50.toFixed(1)}ms p95=${result.latencies.p95.toFixed(1)}ms p99=${result.latencies.p99.toFixed(1)}ms`);
  console.log(`   Range:     min=${result.latencies.min.toFixed(1)}ms max=${result.latencies.max.toFixed(1)}ms avg=${result.latencies.avg.toFixed(1)}ms`);
  if (result.errors.size > 0) {
    console.log(`   Errors:`);
    for (const [key, count] of result.errors) {
      console.log(`     ${key}: ${count}`);
    }
  }

  return result;
}
```

The harness design is intentionally simple:

- **Batched concurrency** — requests are sent in waves of `concurrency` size. This models real-world bursts more accurately than a steady drip, and it avoids overwhelming the single-threaded Bun event loop with thousands of unresolved promises.
- **Latency tracking per request** — every request is individually timed, including failures. This prevents survivor bias in the percentile calculations.
- **Error bucketing** — errors are grouped by HTTP status code or exception message, making it easy to spot patterns (e.g., "all failures were 409s" vs "all failures were connection resets").
- **Console report** — the harness prints a human-readable summary after every run, so you can eyeball results during local development without parsing structured output.

### 4.2 Load Tests

```typescript
// tests/load/payment-throughput.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, BASE_URL } from "../e2e/setup";
import { setupTestDB, teardownTestDB } from "../helpers/setup";
import { runLoad } from "../helpers/load-harness";
import { verifySystemBalance } from "../helpers/god-check";
import { uniqueKey } from "../helpers/factories";
import { db } from "../helpers/setup";

describe("load: payment throughput", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });

  test("100 concurrent authorizations: all succeed + system balances", async () => {
    let counter = 0;

    const result = await runLoad(
      "100 concurrent authorizations",
      20, // concurrency
      100, // total requests
      () => fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": uniqueKey(`ik_load_${counter++}`),
        },
        body: JSON.stringify({ amount: 10000, currency: "USD" }),
      })
    );

    expect(result.succeeded).toBe(100);
    expect(result.failed).toBe(0);
    expect(result.latencies.p95).toBeLessThan(500); // p95 under 500ms

    // THE KEY DIFFERENCE FROM k6:
    // After the load burst, verify correctness
    await verifySystemBalance(db);
  });

  test("50 authorize + capture pairs: all succeed + system balances", async () => {
    let counter = 0;

    const result = await runLoad(
      "50 authorize+capture pairs",
      10,
      50,
      async () => {
        const id = counter++;
        // Authorize
        const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `ik_pair_auth_${id}`,
          },
          body: JSON.stringify({ amount: 5000, currency: "USD" }),
        });
        const payment = await authRes.json();

        // Capture
        return fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `ik_pair_cap_${id}`,
          },
          body: JSON.stringify({}),
        });
      }
    );

    expect(result.succeeded).toBe(50);
    await verifySystemBalance(db);
  });
});
```

```typescript
// tests/load/concurrent-lifecycle.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, BASE_URL } from "../e2e/setup";
import { setupTestDB, teardownTestDB } from "../helpers/setup";
import { verifySystemBalance } from "../helpers/god-check";
import { uniqueKey } from "../helpers/factories";
import { db } from "../helpers/setup";

describe("load: concurrent full lifecycles", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });

  test("20 full lifecycles (auth->capture->refund) under concurrency", async () => {
    const lifecycles = Array.from({ length: 20 }, async (_, i) => {
      // Authorize
      const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_lifecycle_auth_${i}`,
        },
        body: JSON.stringify({ amount: 10000, currency: "USD" }),
      });
      const payment = await authRes.json();

      // Capture
      await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_lifecycle_cap_${i}`,
        },
        body: JSON.stringify({}),
      });

      // Refund
      return fetch(`${BASE_URL}/api/v1/payments/${payment.id}/refund`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_lifecycle_ref_${i}`,
        },
        body: JSON.stringify({}),
      });
    });

    const results = await Promise.allSettled(lifecycles);
    const succeeded = results.filter(r => r.status === "fulfilled");
    expect(succeeded).toHaveLength(20);

    // After 20 full lifecycles, all balances should be zero
    // (every payment was fully refunded)
    await verifySystemBalance(db);
  });

  test("mixed load: 30 auths + 15 captures + 10 voids simultaneously", async () => {
    // Phase 1: Create 30 authorized payments
    const authPromises = Array.from({ length: 30 }, (_, i) =>
      fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_mixed_${i}`,
        },
        body: JSON.stringify({ amount: (i + 1) * 1000, currency: "USD" }),
      }).then(r => r.json())
    );
    const payments = await Promise.all(authPromises);

    // Phase 2: Simultaneously capture 15 and void 10
    const ops = [
      ...payments.slice(0, 15).map(p =>
        fetch(`${BASE_URL}/api/v1/payments/${p.id}/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uniqueKey(),
          },
          body: JSON.stringify({}),
        })
      ),
      ...payments.slice(15, 25).map(p =>
        fetch(`${BASE_URL}/api/v1/payments/${p.id}/void`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uniqueKey(),
          },
        })
      ),
    ];

    await Promise.allSettled(ops);

    // System MUST balance regardless of operation mix
    await verifySystemBalance(db);
  });
});
```

---

## 5. Performance Assertions

Performance assertions are not benchmarks. They are regression guards. The goal is not to measure how fast the system can go — it is to detect when someone accidentally makes it slow. Dropping an index, adding a sequential scan, introducing an N+1 query — these show up as latency cliffs that performance assertions catch.

The thresholds should be generous enough to pass on CI machines (which are slower than developer laptops) but tight enough to catch genuine regressions. A good rule: set the threshold at 3-5x the observed local p95, then tighten it as you gain confidence in CI stability.

```typescript
// Within load tests, add assertions:
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, BASE_URL } from "../e2e/setup";
import { setupTestDB, teardownTestDB } from "../helpers/setup";
import { runLoad } from "../helpers/load-harness";
import { uniqueKey } from "../helpers/factories";

describe("load: performance regression guards", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });

  test("p95 latency for authorization stays under 200ms", async () => {
    const result = await runLoad("auth p95 check", 10, 50, () =>
      fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": uniqueKey(),
        },
        body: JSON.stringify({ amount: 10000, currency: "USD" }),
      })
    );

    expect(result.latencies.p95).toBeLessThan(200);
    expect(result.latencies.p99).toBeLessThan(500);
  });
});
```

---

## 6. Optional: k6 Script for Demos

k6 stays in the repo for situations where you need the polished terminal output — stakeholder demos, performance review meetings, or one-off deep-dive profiling sessions. But it is not the backbone of the testing strategy. The custom harness is. k6 cannot run the god check. k6 cannot verify database invariants. k6 tells you "the system handled 500 RPS at p95 < 100ms" — it cannot tell you whether those 500 responses left the database in a consistent state.

```javascript
// tests/k6/payment-flow.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

const authorizeTrend = new Trend("authorize_duration");
const captureTrend = new Trend("capture_duration");
const errorCount = new Counter("errors");

export const options = {
  scenarios: {
    payment_flow: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "30s", target: 10 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    authorize_duration: ["p(95)<200"],
    capture_duration: ["p(95)<200"],
    errors: ["count<10"],
  },
};

export default function () {
  const uniqueId = `ik_k6_${__VU}_${__ITER}_${Date.now()}`;

  // Authorize
  const authRes = http.post(
    `${BASE_URL}/api/v1/payments/authorize`,
    JSON.stringify({ amount: 10000, currency: "USD" }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${uniqueId}_auth`,
      },
    }
  );
  authorizeTrend.add(authRes.timings.duration);

  const authOk = check(authRes, {
    "authorize status 201": (r) => r.status === 201,
    "has payment id": (r) => JSON.parse(r.body).id.startsWith("pay_"),
  });
  if (!authOk) { errorCount.add(1); return; }

  const paymentId = JSON.parse(authRes.body).id;

  // Capture
  const capRes = http.post(
    `${BASE_URL}/api/v1/payments/${paymentId}/capture`,
    JSON.stringify({}),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${uniqueId}_cap`,
      },
    }
  );
  captureTrend.add(capRes.timings.duration);

  check(capRes, {
    "capture status 200": (r) => r.status === 200,
    "status is captured": (r) => JSON.parse(r.body).status === "captured",
  });

  sleep(0.5);
}
```

Running k6:

```bash
# Install k6 (one-time)
brew install k6  # or: curl https://github.com/grafana/k6/releases/...

# Run against local server
k6 run tests/k6/payment-flow.js

# Run against specific URL
k6 run -e BASE_URL=http://localhost:3000 tests/k6/payment-flow.js
```

---

## 7. When to Use What

| Scenario | Tool | Why |
|---|---|---|
| "Does the API return correct responses?" | Hono RPC E2E | Type-safe, catches contract violations at compile time |
| "Does the system stay correct under load?" | Custom load harness | Combines performance measurement with invariant verification |
| "What's our throughput/latency?" | Custom load harness OR k6 | Both give percentiles; harness also verifies correctness |
| "Demo to stakeholders" | k6 | Polished terminal output, industry-recognized tool |
| "CI regression gate" | Custom load harness | Runs in bun:test, same pipeline, no extra tooling |

The decision tree is straightforward: if you need to verify correctness (and you almost always do), use the custom harness. If you only need pretty graphs, use k6. If you need compile-time type safety on your test requests, use Hono RPC. In practice, most CI runs execute the Hono RPC E2E tests and the custom load harness. k6 runs manually or in a separate performance-profiling pipeline.

---

Previous: [08b — Integration Tests](./08b-integration-tests.md) | Next: [08d — Advanced Testing](./08d-advanced-testing.md)
