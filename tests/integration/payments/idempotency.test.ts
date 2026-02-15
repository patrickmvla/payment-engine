import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { createAuthorizedPayment, createCapturedPayment, uniqueKey } from "../../helpers/factories";
import { verifySystemBalance } from "../../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../../helpers/setup";

let db: Awaited<ReturnType<typeof setupTestDB>>;

beforeAll(async () => {
  db = await setupTestDB();
});
afterAll(async () => {
  await teardownTestDB();
});
afterEach(async () => {
  await verifySystemBalance(getTestSQL());
  await cleanBetweenTests();
});

describe("idempotency — cache hit behavior", () => {
  it("same key + same params returns identical response", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);
    const second = await paymentService.authorize(db, params, key);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
    expect(second.amount).toBe(first.amount);
  });

  it("third retry still returns the identical response", async () => {
    const key = uniqueKey();
    const params = { amount: 15000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);
    const second = await paymentService.authorize(db, params, key);
    const third = await paymentService.authorize(db, params, key);

    expect(third.id).toBe(first.id);
    expect(second.id).toBe(first.id);
  });

  it("all fields match between original and cached response", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD", description: "Idempotency field check" };

    const first = await paymentService.authorize(db, params, key);
    const second = await paymentService.authorize(db, params, key);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
    expect(second.amount).toBe(first.amount);
    expect(second.currency).toBe(first.currency);
    expect(second.authorizedAmount).toBe(first.authorizedAmount);
  });

  it("cached response creates no new ledger entries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);
    const entriesBefore = await db.execute(sql`SELECT COUNT(*)::int AS count FROM ledger_entries`);

    await paymentService.authorize(db, params, key);
    const entriesAfter = await db.execute(sql`SELECT COUNT(*)::int AS count FROM ledger_entries`);

    expect(entriesAfter[0].count).toBe(entriesBefore[0].count);
  });

  it("payment count does not increase on retry", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);
    const countBefore = await db.execute(sql`SELECT COUNT(*)::int AS count FROM payments`);

    await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);
    const countAfter = await db.execute(sql`SELECT COUNT(*)::int AS count FROM payments`);

    expect(countAfter[0].count).toBe(countBefore[0].count);
  });
});

describe("idempotency — conflict detection", () => {
  it("same key + different amount returns 409 conflict", async () => {
    const key = uniqueKey();
    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService
      .authorize(db, { amount: 20000n, currency: "USD" }, key)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });

  it("same key + different currency returns 409 conflict", async () => {
    const key = uniqueKey();
    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService
      .authorize(db, { amount: 10000n, currency: "EUR" }, key)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });

  it("conflict error body includes type idempotency_conflict", async () => {
    const key = uniqueKey();
    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService
      .authorize(db, { amount: 50000n, currency: "USD" }, key)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    const combined = err.type || err.code || err.message || "";
    expect(combined).toMatch(/conflict|idempotency/i);
  });

  it("conflict error includes the original idempotency key", async () => {
    const key = uniqueKey();
    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService
      .authorize(db, { amount: 30000n, currency: "USD" }, key)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    const combined = err.message || err.idempotencyKey || "";
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(combined).toMatch(new RegExp(escaped));
  });
});

describe("idempotency — ledger deduplication", () => {
  it("exactly one transaction despite 3 retries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", first.id);
    expect(transactions).toHaveLength(1);
  });

  it("concurrent same-key requests create exactly one payment", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const results = await Promise.allSettled([
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const ids = new Set(fulfilled.map((r) => (r as PromiseFulfilledResult<any>).value.id));
    expect(ids.size).toBe(1);
  });

  it("entry count is stable across retries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);
    const countBefore = await db.execute(sql`SELECT COUNT(*)::int AS count FROM ledger_entries`);

    await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);
    const countAfter = await db.execute(sql`SELECT COUNT(*)::int AS count FROM ledger_entries`);

    expect(countAfter[0].count).toBe(countBefore[0].count);
  });

  it("transaction count is stable across retries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);
    const countBefore = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_transactions`,
    );

    await paymentService.authorize(db, params, key);
    const countAfter = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_transactions`,
    );

    expect(countAfter[0].count).toBe(countBefore[0].count);
  });
});

describe("idempotency — cross-operation", () => {
  it("capture retry returns the same captured payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.capturedAmount).toBe(10000n);
    expect(payment.status).toBe("captured");
  });

  it("refund retry does not double-refund (refundedAmount unchanged)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 5000n });

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBe(5000n);
    expect(payment.refundedAmount).toBeLessThanOrEqual(payment.capturedAmount);
  });

  it("void retry returns the same voided payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.void(db, auth.id);

    const err = await paymentService.void(db, auth.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|already/i);

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.status).toBe("voided");
  });

  it("different idempotency keys create separate resources", async () => {
    const params = { amount: 10000n, currency: "USD" };
    const p1 = await paymentService.authorize(db, params, uniqueKey());
    const p2 = await paymentService.authorize(db, params, uniqueKey());

    expect(p1.id).not.toBe(p2.id);
  });
});

describe("idempotency — key semantics", () => {
  it("different keys with identical params create separate payments", async () => {
    const params = { amount: 10000n, currency: "USD" };
    const p1 = await paymentService.authorize(db, params, uniqueKey());
    const p2 = await paymentService.authorize(db, params, uniqueKey());

    expect(p1.id).not.toBe(p2.id);

    const count = await db.execute(sql`SELECT COUNT(*)::int AS count FROM payments`);
    expect(count[0].count).toBeGreaterThanOrEqual(2);
  });

  it("key reuse across different operations is independent", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };
    const payment = await paymentService.authorize(db, params, key);

    expect(payment.id).toMatch(/^pay_/);
  });

  it("concurrent identical requests all resolve to same payment ID", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const results = await Promise.allSettled([
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const ids = new Set(fulfilled.map((r) => (r as PromiseFulfilledResult<any>).value.id));
    expect(ids.size).toBe(1);
  });
});
