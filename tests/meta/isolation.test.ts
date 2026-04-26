import { afterAll, beforeAll, describe, expect, it , vi } from "vitest";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { paymentService } from "../../src/payments/service";
import { createAuthorizedPayment, uniqueKey } from "../helpers/factories";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";

/**
 * Meta: Test Infrastructure Isolation
 *
 * Proves the test infrastructure itself is trustworthy.
 * cleanBetweenTests() must fully clear payments, ledger entries,
 * and idempotency keys between tests — otherwise no test can trust
 * its starting state.
 *
 * These tests are deliberately sequential. Each pair tests:
 *   1. Create data → verify it exists
 *   2. Clean → verify it's gone
 */

let db: Awaited<ReturnType<typeof setupTestDB>>;
let sql: ReturnType<typeof getTestSQL>;

beforeAll(async () => {
  db = await setupTestDB();
  sql = getTestSQL();
  await cleanBetweenTests();
});
afterAll(async () => {
  await teardownTestDB();
});

// --- Payments pair ---

describe("payments isolation", () => {
  it("creates a payment and COUNT(*) FROM payments = 1", async () => {
    await createAuthorizedPayment(db);
    const result = await sql`SELECT COUNT(*)::int AS count FROM payments`;
    expect(result[0]!.count).toBe(1);
  });

  it("after cleanBetweenTests(), COUNT(*) FROM payments = 0", async () => {
    await cleanBetweenTests();
    const result = await sql`SELECT COUNT(*)::int AS count FROM payments`;
    expect(result[0]!.count).toBe(0);
  });
});

// --- Ledger entries pair ---

describe("ledger entries isolation", () => {
  it("creates ledger entries via authorize, COUNT(*) FROM ledger_entries > 0", async () => {
    await createAuthorizedPayment(db);
    const result = await sql`SELECT COUNT(*)::int AS count FROM ledger_entries`;
    expect(result[0]!.count).toBeGreaterThan(0);
  });

  it("after cleanBetweenTests(), COUNT(*) FROM ledger_entries = 0", async () => {
    await cleanBetweenTests();
    const result = await sql`SELECT COUNT(*)::int AS count FROM ledger_entries`;
    expect(result[0]!.count).toBe(0);
  });
});

// --- Idempotency keys pair ---

describe("idempotency keys isolation", () => {
  it("creates an idempotency key via authorize, COUNT(*) FROM idempotency_keys = 1", async () => {
    await createAuthorizedPayment(db);
    const result = await sql`SELECT COUNT(*)::int AS count FROM idempotency_keys`;
    expect(result[0]!.count).toBe(1);
  });

  it("after cleanBetweenTests(), key is gone and a new key works without conflict", async () => {
    await cleanBetweenTests();
    const result = await sql`SELECT COUNT(*)::int AS count FROM idempotency_keys`;
    expect(result[0]!.count).toBe(0);

    // A new key should work without conflict
    const payment = await paymentService.authorize(
      db,
      { amount: 5000n, currency: "USD" },
      uniqueKey(),
    );
    expect(payment.status).toBe("authorized");
    await cleanBetweenTests();
  });
});
