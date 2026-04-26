// Side-effect import: must be FIRST so the env override runs before src/server loads.
import "../helpers/test-env";

import { afterAll, afterEach, beforeAll, describe, expect, it , vi } from "vitest";
import { app } from "../../src/server";
import { verifySystemBalance } from "../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Fuzz: Validation Fuzz Tests
 *
 * Throws adversarial, random, and malformed payloads at the authorize endpoint.
 * Every response must have a valid HTTP status code and structured error body.
 * The god check must pass after — no partial writes from bad input.
 */

// --- SeededRNG (mulberry32) — inline per convention ---
class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]!;
  }
  string(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;':\",./<>?`~\\\n\t\r\0";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars[this.int(0, chars.length - 1)];
    }
    return result;
  }
}

function generateRandomPayload(rng: SeededRNG): Record<string, unknown> {
  const fieldTypes = ["string", "number", "boolean", "null", "array", "object", "bigstring"];
  const keyCount = rng.int(0, 15);
  const payload: Record<string, unknown> = {};

  for (let i = 0; i < keyCount; i++) {
    const key = rng.next() > 0.3 ? rng.string(rng.int(1, 30)) : rng.pick(["amount", "currency", "description", "metadata"]);
    const type = rng.pick(fieldTypes);

    switch (type) {
      case "string":
        payload[key] = rng.string(rng.int(0, 200));
        break;
      case "number":
        payload[key] = rng.next() > 0.5 ? rng.int(-1_000_000, 1_000_000) : rng.next() * 1000 - 500;
        break;
      case "boolean":
        payload[key] = rng.next() > 0.5;
        break;
      case "null":
        payload[key] = null;
        break;
      case "array":
        payload[key] = Array.from({ length: rng.int(0, 5) }, () => rng.string(rng.int(1, 10)));
        break;
      case "object":
        payload[key] = { nested: rng.string(rng.int(1, 20)) };
        break;
      case "bigstring":
        payload[key] = rng.string(rng.int(500, 2000));
        break;
    }
  }

  return payload;
}

let sql: ReturnType<typeof getTestSQL>;

beforeAll(async () => {
  await setupTestDB();
  sql = getTestSQL();
});
afterAll(async () => {
  await teardownTestDB();
});
afterEach(async () => {
  await verifySystemBalance(sql);
  await cleanBetweenTests();
});

describe("validation fuzz", () => {
  it("handles 500 random payloads without crashing or corrupting data", async () => {
    const rng = new SeededRNG(42);

    for (let i = 0; i < 500; i++) {
      const payload = generateRandomPayload(rng);
      const idempotencyKey = `fuzz_${i}_${Date.now()}`;

      const res = await app.request("/api/v1/payments/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      // Every response must have a valid HTTP status
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(600);

      // Non-2xx responses must have a structured error body
      if (res.status >= 300) {
        const body = await res.json();
        expect(body).toHaveProperty("error");
        expect(body.error).toHaveProperty("type");
        expect(body.error).toHaveProperty("message");
      }
    }
  });

  it("rejects prototype pollution attempts with status < 500", async () => {
    const poisonPayloads = [
      { __proto__: { isAdmin: true }, amount: 1000, currency: "USD" },
      { constructor: { prototype: { isAdmin: true } }, amount: 1000, currency: "USD" },
      { amount: 1000, currency: "USD", "__proto__": { polluted: true } },
      { amount: 1000, currency: "USD", "constructor.prototype.polluted": true },
    ];

    for (const payload of poisonPayloads) {
      const res = await app.request("/api/v1/payments/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `proto_${Date.now()}_${Math.random()}`,
        },
        body: JSON.stringify(payload),
      });

      // Should not cause a server error
      expect(res.status).toBeLessThan(500);
    }
  });

  it("rejects extremely large payload with 400+", async () => {
    const hugePayload: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      hugePayload[`key_${i}`] = "x".repeat(1000);
    }

    const res = await app.request("/api/v1/payments/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `huge_${Date.now()}`,
      },
      body: JSON.stringify(hugePayload),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects non-JSON content type with 400+", async () => {
    const res = await app.request("/api/v1/payments/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Idempotency-Key": `nonjson_${Date.now()}`,
      },
      body: "this is not json",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
