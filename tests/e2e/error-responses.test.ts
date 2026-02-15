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

describe("e2e: error responses", () => {
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

  test("missing idempotency key -> 400", async () => {
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
    // Create and void a payment
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    const payment = await authRes.json();

    await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/void`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
    });

    // Try to capture voided payment
    const res = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const error = await res.json();
    expect(error.error.type).toBe("invalid_state_transition");
    expect(error.error.details.current_status).toBe("voided");
  });

  test("non-existent payment -> 404", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments/pay_nonexistent`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("not_found");
  });

  test("capture exceeding authorization -> 422", async () => {
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    const payment = await authRes.json();

    const res = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 20000 }),
    });
    expect(res.status).toBe(422);
    const error = await res.json();
    expect(error.error.type).toBe("invalid_amount");
  });

  test("settle non-captured payment -> 409", async () => {
    const authRes = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    const payment = await authRes.json();

    const res = await fetch(`${BASE_URL}/api/v1/payments/${payment.id}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
    });
    expect(res.status).toBe(409);
    const error = await res.json();
    expect(error.error.type).toBe("invalid_state_transition");
  });

  test("idempotency conflict -> 409", async () => {
    const key = uniqueKey();

    await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });

    // Same key, different amount
    const res = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ amount: 99999, currency: "USD" }),
    });
    expect(res.status).toBe(409);
    const error = await res.json();
    expect(error.error.type).toBe("idempotency_conflict");
  });
});
