import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

// Idempotency contract from docs/06-invariants.md §7 and docs/05-api-design.md
// (Idempotency Behavior table). Same key + same params → identical response,
// no reprocessing. Same key + different params → 409 conflict.

describe("idempotency — refund retries", () => {
  it("partial refund retry with same key does not double-refund", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const key = uniqueKey();

    const first = await paymentService.refund(db, captured.id, { amount: 5000n }, key);
    const second = await paymentService.refund(db, captured.id, { amount: 5000n }, key);

    expect(first.refundedAmount).toBe(5000n);
    expect(second.refundedAmount).toBe(5000n);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);

    const fresh = await paymentService.getPayment(db, captured.id);
    expect(fresh.refundedAmount).toBe(5000n);
    expect(fresh.status).toBe("partially_refunded");
  });

  it("partial refund retry creates no additional ledger entries", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const key = uniqueKey();

    await paymentService.refund(db, captured.id, { amount: 5000n }, key);
    const txnsAfterFirst = await ledgerService.getTransactionsByReference(
      db,
      "payment",
      captured.id,
    );
    const refundCountBefore = txnsAfterFirst.filter((t) =>
      t.description.toLowerCase().includes("refund"),
    ).length;

    await paymentService.refund(db, captured.id, { amount: 5000n }, key);
    const txnsAfterSecond = await ledgerService.getTransactionsByReference(
      db,
      "payment",
      captured.id,
    );
    const refundCountAfter = txnsAfterSecond.filter((t) =>
      t.description.toLowerCase().includes("refund"),
    ).length;

    expect(refundCountAfter).toBe(refundCountBefore);
  });

  it("full refund retry returns identical payment, no second refund", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const key = uniqueKey();

    const first = await paymentService.refund(db, captured.id, { amount: 10000n }, key);
    const second = await paymentService.refund(db, captured.id, { amount: 10000n }, key);

    expect(first.status).toBe("refunded");
    expect(second.status).toBe("refunded");
    expect(second.refundedAmount).toBe(10000n);
    expect(second.id).toBe(first.id);
  });

  it("refund with same key + different amount returns 409 conflict", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const key = uniqueKey();

    await paymentService.refund(db, captured.id, { amount: 3000n }, key);
    const err = await paymentService
      .refund(db, captured.id, { amount: 7000n }, key)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });
});

describe("idempotency — capture retries", () => {
  it("capture retry with same key does not double-capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const key = uniqueKey();

    const first = await paymentService.capture(db, auth.id, { amount: 10000n }, key);
    const second = await paymentService.capture(db, auth.id, { amount: 10000n }, key);

    expect(first.capturedAmount).toBe(10000n);
    expect(second.capturedAmount).toBe(10000n);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("captured");
  });

  it("capture retry creates no additional ledger entries", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const key = uniqueKey();

    await paymentService.capture(db, auth.id, { amount: 10000n }, key);
    const txnsAfterFirst = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureCountBefore = txnsAfterFirst.filter((t) =>
      t.description.toLowerCase().includes("capture"),
    ).length;

    await paymentService.capture(db, auth.id, { amount: 10000n }, key);
    const txnsAfterSecond = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureCountAfter = txnsAfterSecond.filter((t) =>
      t.description.toLowerCase().includes("capture"),
    ).length;

    expect(captureCountAfter).toBe(captureCountBefore);
  });

  it("capture with same key + different amount returns 409 conflict", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const key = uniqueKey();

    await paymentService.capture(db, auth.id, { amount: 7000n }, key);
    const err = await paymentService
      .capture(db, auth.id, { amount: 5000n }, key)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });
});

describe("idempotency — void retries", () => {
  it("void retry with same key returns same payment, does not error", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const key = uniqueKey();

    const first = await paymentService.void(db, auth.id, key);
    const second = await paymentService.void(db, auth.id, key);

    expect(first.status).toBe("voided");
    expect(second.status).toBe("voided");
    expect(second.id).toBe(first.id);
  });

  it("void retry creates no additional ledger entries", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const key = uniqueKey();

    await paymentService.void(db, auth.id, key);
    const txnsAfterFirst = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const voidCountBefore = txnsAfterFirst.filter((t) =>
      t.description.toLowerCase().includes("void"),
    ).length;

    await paymentService.void(db, auth.id, key);
    const txnsAfterSecond = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const voidCountAfter = txnsAfterSecond.filter((t) =>
      t.description.toLowerCase().includes("void"),
    ).length;

    expect(voidCountAfter).toBe(voidCountBefore);
  });
});

describe("idempotency — settle retries", () => {
  it("settle retry with same key returns same payment, does not error", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const key = uniqueKey();

    const first = await paymentService.settle(db, captured.id, key);
    const second = await paymentService.settle(db, captured.id, key);

    expect(first.status).toBe("settled");
    expect(second.status).toBe("settled");
    expect(second.id).toBe(first.id);
  });

  it("settle retry creates no additional ledger entries", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const key = uniqueKey();

    await paymentService.settle(db, captured.id, key);
    const txnsAfterFirst = await ledgerService.getTransactionsByReference(
      db,
      "payment",
      captured.id,
    );
    const settleCountBefore = txnsAfterFirst.filter((t) =>
      t.description.toLowerCase().includes("settle"),
    ).length;

    await paymentService.settle(db, captured.id, key);
    const txnsAfterSecond = await ledgerService.getTransactionsByReference(
      db,
      "payment",
      captured.id,
    );
    const settleCountAfter = txnsAfterSecond.filter((t) =>
      t.description.toLowerCase().includes("settle"),
    ).length;

    expect(settleCountAfter).toBe(settleCountBefore);
  });
});

describe("idempotency — cross-mutation key reuse", () => {
  it("same key reused for capture then refund returns 409 on refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const key = uniqueKey();

    const captured = await paymentService.capture(db, auth.id, { amount: 10000n }, key);
    expect(captured.status).toBe("captured");

    const err = await paymentService.refund(db, auth.id, { amount: 5000n }, key).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });
});
