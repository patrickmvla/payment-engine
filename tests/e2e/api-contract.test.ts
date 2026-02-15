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

describe("e2e: API contract", () => {
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

  test("response includes object field", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("payment");
  });

  test("response includes X-Request-ID header", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    expect(res.headers.get("X-Request-ID")).toBeDefined();
    expect(res.headers.get("X-Request-ID")).not.toBeNull();
  });

  test("list endpoint returns correct shape", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.has_more).toBe("boolean");
  });

  test("timestamps are ISO 8601 UTC", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
    });
    const body = await res.json();
    // ISO 8601 with Z suffix: 2025-01-15T10:30:00Z or 2025-01-15T10:30:00.123Z
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("payment IDs are prefixed ULIDs", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uniqueKey(),
      },
      body: JSON.stringify({ amount: 10000, currency: "USD" }),
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
