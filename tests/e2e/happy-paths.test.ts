import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  BASE_URL,
  cleanBetweenTests,
  setupTestDB,
  startTestServer,
  stopTestServer,
  teardownTestDB,
  uniqueKey,
} from "./setup";

describe("e2e: happy paths", () => {
  beforeAll(async () => {
    await setupTestDB();
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDB();
  });
  afterEach(async () => {
    await cleanBetweenTests();
  });

  test("full lifecycle: authorize -> capture -> refund", async () => {
    // Authorize
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    expect(authRes.status).toBe(201);
    const payment = await authRes.json();
    expect(payment.status).toBe("authorized");
    expect(payment.id).toMatch(/^pay_/);
    expect(payment.authorized_amount).toBe(10000);
    expect(payment.captured_amount).toBe(0);
    expect(payment.refunded_amount).toBe(0);

    // Capture
    const capRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({}),
    });
    expect(capRes.status).toBe(200);
    const captured = await capRes.json();
    expect(captured.status).toBe("captured");
    expect(captured.captured_amount).toBe(10000);

    // Refund
    const refRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({}),
    });
    expect(refRes.status).toBe(200);
    const refunded = await refRes.json();
    expect(refunded.status).toBe("refunded");
    expect(refunded.refunded_amount).toBe(10000);
  });

  test("authorize -> void", async () => {
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 5000, currency: "EUR" }),
    });
    expect(authRes.status).toBe(201);
    const payment = await authRes.json();

    const voidRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/void`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
    });
    expect(voidRes.status).toBe(200);
    const voided = await voidRes.json();
    expect(voided.status).toBe("voided");
  });

  test("authorize -> capture -> settle -> refund", async () => {
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    expect(authRes.status).toBe(201);
    const payment = await authRes.json();

    // Capture
    const capRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({}),
    });
    expect(capRes.status).toBe(200);

    // Settle
    const settleRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
    });
    expect(settleRes.status).toBe(200);
    const settled = await settleRes.json();
    expect(settled.status).toBe("settled");

    // Refund after settlement
    const refRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({}),
    });
    expect(refRes.status).toBe(200);
    const refunded = await refRes.json();
    expect(refunded.status).toBe("refunded");
  });

  test("authorize -> partial capture -> partial refund -> refund remainder", async () => {
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    expect(authRes.status).toBe(201);
    const payment = await authRes.json();

    // Partial capture
    const capRes = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 7000 }),
    });
    expect(capRes.status).toBe(200);
    const captured = await capRes.json();
    expect(captured.captured_amount).toBe(7000);

    // Partial refund
    const ref1 = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 3000 }),
    });
    expect(ref1.status).toBe(200);
    const partial = await ref1.json();
    expect(partial.status).toBe("partially_refunded");
    expect(partial.refunded_amount).toBe(3000);

    // Refund remainder
    const ref2 = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 4000 }),
    });
    expect(ref2.status).toBe(200);
    const final = await ref2.json();
    expect(final.status).toBe("refunded");
    expect(final.refunded_amount).toBe(7000);
  });
});
