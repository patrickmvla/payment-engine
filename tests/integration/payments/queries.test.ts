import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { createAuthorizedPayment, createCapturedPayment } from "../../helpers/factories";
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

describe("payment queries — single retrieval", () => {
  it("retrieves a payment by ID with all fields", async () => {
    const created = await createAuthorizedPayment(db, { amount: 10000n });
    const payment = await paymentService.getPayment(db, created.id);

    expect(payment.id).toBe(created.id);
    expect(payment.status).toBe("authorized");
    expect(payment.amount).toBe(10000n);
    expect(payment.currency).toBe("USD");
    expect(payment.authorizedAmount).toBeDefined();
    expect(payment.capturedAmount).toBeDefined();
    expect(payment.refundedAmount).toBeDefined();
  });

  it("returns an error for a non-existent ID", async () => {
    const err = await paymentService.getPayment(db, "pay_does_not_exist_000").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });

  it("reflects current state after operations", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.status).toBe("captured");
    expect(payment.capturedAmount).toBe(10000n);
  });

  it("all amount fields are present after full lifecycle", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 3000n });

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.authorizedAmount).toBe(10000n);
    expect(payment.capturedAmount).toBe(10000n);
    expect(payment.refundedAmount).toBe(3000n);
  });
});

describe("payment queries — list & pagination", () => {
  it("returns a default limit of results", async () => {
    const promises = [];
    for (let i = 0; i < 25; i++) {
      promises.push(createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) }));
    }
    await Promise.all(promises);

    const result = await paymentService.listPayments(db);
    expect(result.data.length).toBeLessThanOrEqual(20);
  });

  it("respects a custom limit", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) }));
    }
    await Promise.all(promises);

    const result = await paymentService.listPayments(db, { limit: 5 });
    expect(result.data).toHaveLength(5);
  });

  it("supports cursor pagination with has_more and next_cursor", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) }));
    }
    await Promise.all(promises);

    const page1 = await paymentService.listPayments(db, { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();
  });

  it("subsequent page starts after cursor", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) }));
    }
    await Promise.all(promises);

    const page1 = await paymentService.listPayments(db, { limit: 3 });
    const page2 = await paymentService.listPayments(db, {
      limit: 3,
      cursor: page1.nextCursor,
    });

    const page1Ids = new Set(page1.data.map((p) => p.id));
    for (const p of page2.data) {
      expect(page1Ids.has(p.id)).toBe(false);
    }
  });

  it("filters by status", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });
    await createCapturedPayment(db, { authorizeAmount: 20000n });
    await createAuthorizedPayment(db, { amount: 15000n });

    const result = await paymentService.listPayments(db, { status: "authorized" });
    for (const p of result.data) {
      expect(p.status).toBe("authorized");
    }
    expect(result.data.length).toBeGreaterThanOrEqual(2);
  });

  it("returns results in reverse chronological order (newest first)", async () => {
    for (let i = 0; i < 5; i++) {
      await createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) });
    }

    const result = await paymentService.listPayments(db);
    for (let i = 1; i < result.data.length; i++) {
      const prev = new Date(result.data[i - 1]!.createdAt).getTime();
      const curr = new Date(result.data[i]!.createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});
