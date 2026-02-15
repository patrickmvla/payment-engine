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
          "Idempotency-Key": `ik_lifecycle_auth_${i}_${Date.now()}`,
        },
        body: JSON.stringify({ amount: 10000, currency: "USD" }),
      });
      const payment = await authRes.json();

      // Capture
      await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_lifecycle_cap_${i}_${Date.now()}`,
        },
        body: JSON.stringify({}),
      });

      // Refund
      return fetch(`${BASE_URL}/api/v1/payments/${payment.id}/refund`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_lifecycle_ref_${i}_${Date.now()}`,
        },
        body: JSON.stringify({}),
      });
    });

    const results = await Promise.allSettled(lifecycles);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded).toHaveLength(20);

    // After 20 full lifecycles (all refunded), system balances
    await verifySystemBalance(getTestSQL());
  });

  test("mixed load: 30 auths + 15 captures + 10 voids simultaneously", async () => {
    // Phase 1: Create 30 authorized payments
    const authPromises = Array.from({ length: 30 }, (_, i) =>
      fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `ik_mixed_${i}_${Date.now()}`,
        },
        body: JSON.stringify({ amount: (i + 1) * 1000, currency: "USD" }),
      }).then((r) => r.json()),
    );
    const payments = await Promise.all(authPromises);

    // Phase 2: Simultaneously capture 15 and void 10
    const ops = [
      ...payments.slice(0, 15).map((p) =>
        fetch(`${BASE_URL}/api/v1/payments/${p.id}/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uniqueKey(),
          },
          body: JSON.stringify({}),
        }),
      ),
      ...payments.slice(15, 25).map((p) =>
        fetch(`${BASE_URL}/api/v1/payments/${p.id}/void`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uniqueKey(),
          },
        }),
      ),
    ];

    await Promise.allSettled(ops);

    // System MUST balance regardless of operation mix
    await verifySystemBalance(getTestSQL());
  });
});
