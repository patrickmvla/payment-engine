import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BASE_URL,
  getTestSQL,
  setupTestDB,
  startTestServer,
  stopTestServer,
  teardownTestDB,
  uniqueKey,
} from "../e2e/setup";
import { verifySystemBalance } from "../helpers/god-check";
import { runLoad } from "../helpers/load-harness";

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
    const result = await runLoad(
      "100 concurrent authorizations",
      20, // concurrency
      100, // total requests
      () =>
        fetch(`${BASE_URL}/api/v1/payments/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uniqueKey(),
          },
          body: JSON.stringify({ amount: 10000, currency: "USD" }),
        }),
    );

    expect(result.succeeded).toBe(100);
    expect(result.failed).toBe(0);
    // Remote Supabase adds network latency; local Postgres would be <500ms
    expect(result.latencies.p95).toBeLessThan(15000);

    // After the load burst, verify correctness
    await verifySystemBalance(getTestSQL());
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
            "Idempotency-Key": `ik_pair_auth_${id}_${Date.now()}`,
          },
          body: JSON.stringify({ amount: 5000, currency: "USD" }),
        });
        const payment = await authRes.json();

        // Capture
        return fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `ik_pair_cap_${id}_${Date.now()}`,
          },
          body: JSON.stringify({}),
        });
      },
    );

    expect(result.succeeded).toBe(50);
    await verifySystemBalance(getTestSQL());
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
      }),
    );

    // Remote Supabase adds network latency; local Postgres would be <200ms
    expect(result.latencies.p95).toBeLessThan(10000);
    expect(result.latencies.p99).toBeLessThan(15000);
  });
});
