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

describe("e2e: pagination", () => {
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

  test("returns correct page size", async () => {
    // Create 5 payments
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": uniqueKey(),
        },
        body: JSON.stringify({ amount: 1000 * (i + 1), currency: "USD" }),
      });
    }

    const res = await fetch(`${BASE_URL}/api/v1/payments?limit=3`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
  });

  test("cursor pagination returns next page without overlap", async () => {
    // Create 5 payments
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE_URL}/api/v1/payments/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": uniqueKey(),
        },
        body: JSON.stringify({ amount: 1000, currency: "USD" }),
      });
    }

    // Page 1
    const page1Res = await fetch(`${BASE_URL}/api/v1/payments?limit=3`);
    const page1 = await page1Res.json();
    expect(page1.data).toHaveLength(3);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeDefined();

    // Page 2
    const page2Res = await fetch(
      `${BASE_URL}/api/v1/payments?limit=3&cursor=${page1.next_cursor}`,
    );
    const page2 = await page2Res.json();
    expect(page2.data).toHaveLength(2);
    expect(page2.has_more).toBe(false);

    // No overlap between pages
    const page1Ids = new Set(page1.data.map((p: { id: string }) => p.id));
    for (const p of page2.data) {
      expect(page1Ids.has(p.id)).toBe(false);
    }
  });

  test("empty results return 200 with empty data", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
  });
});
