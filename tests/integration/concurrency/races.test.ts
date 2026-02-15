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

describe("concurrency: double capture", () => {
  it("2 simultaneous captures — exactly 1 succeeds", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const results = await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.capture(db, auth.id, { amount: 10000n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("5 simultaneous captures — exactly 1 succeeds", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => paymentService.capture(db, auth.id, { amount: 10000n })),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("payment state after race is captured with correct amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.capture(db, auth.id, { amount: 10000n }),
    ]);

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.status).toBe("captured");
    expect(payment.capturedAmount).toBe(10000n);
  });
});

describe("concurrency: double settlement", () => {
  it("2 simultaneous settlements — exactly 1 succeeds", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled([
      paymentService.settle(db, captured.id),
      paymentService.settle(db, captured.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("concurrency: capture vs void race", () => {
  it("exactly one succeeds when capture and void race", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const results = await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.void(db, auth.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("payment ends in a valid terminal state (captured or voided)", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.void(db, auth.id),
    ]);

    const payment = await paymentService.getPayment(db, auth.id);
    expect(["captured", "voided"]).toContain(payment.status);
  });

  it("ledger is balanced after race", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.void(db, auth.id),
    ]);

    await verifySystemBalance(getTestSQL());
  });
});

describe("concurrency: refund races", () => {
  it("concurrent full refunds — only one succeeds", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled([
      paymentService.refund(db, captured.id, { amount: 10000n }),
      paymentService.refund(db, captured.id, { amount: 10000n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBe(10000n);
  });

  it("concurrent partial refunds cannot exceed captured amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled([
      paymentService.refund(db, captured.id, { amount: 7000n }),
      paymentService.refund(db, captured.id, { amount: 7000n }),
      paymentService.refund(db, captured.id, { amount: 7000n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeLessThanOrEqual(1);

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBeLessThanOrEqual(10000n);
  });

  it("10 concurrent small refunds capped at captured amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => paymentService.refund(db, captured.id, { amount: 2000n })),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeLessThanOrEqual(5);

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBeLessThanOrEqual(10000n);
    await verifySystemBalance(getTestSQL());
  });

  it("god check passes after refund race", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    await Promise.allSettled([
      paymentService.refund(db, captured.id, { amount: 5000n }),
      paymentService.refund(db, captured.id, { amount: 5000n }),
      paymentService.refund(db, captured.id, { amount: 5000n }),
    ]);

    await verifySystemBalance(getTestSQL());
  });
});

describe("concurrency: parallel independent payments", () => {
  it("20 concurrent authorizations all succeed", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 1000) }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(20);
  });

  it("all concurrent payments have unique IDs", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 1000) }),
      ),
    );

    const fulfilled = results.filter(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<any>[];
    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(20);
  });
});

describe("concurrency: mixed chaos", () => {
  it("mixed operations across multiple payments", async () => {
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });
    const auth3 = await createAuthorizedPayment(db, { amount: 15000n });
    const captured1 = await createCapturedPayment(db, { authorizeAmount: 30000n });

    await Promise.allSettled([
      paymentService.capture(db, auth1.id, { amount: 10000n }),
      paymentService.void(db, auth2.id),
      paymentService.capture(db, auth3.id, { amount: 15000n }),
      paymentService.refund(db, captured1.id, { amount: 10000n }),
    ]);

    await verifySystemBalance(getTestSQL());
  });

  it("duplicate operations fail gracefully", async () => {
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });

    await Promise.allSettled([
      paymentService.capture(db, auth1.id, { amount: 10000n }),
      paymentService.void(db, auth2.id),
      paymentService.capture(db, auth1.id, { amount: 10000n }),
      paymentService.void(db, auth2.id),
    ]);

    await verifySystemBalance(getTestSQL());
  });

  it("god check after chaos across 10 payments", async () => {
    const payments = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 5000) }),
      ),
    );

    await Promise.allSettled(
      payments.map((p, i) =>
        i % 2 === 0
          ? paymentService.capture(db, p.id, { amount: p.amount })
          : paymentService.void(db, p.id),
      ),
    );

    await verifySystemBalance(getTestSQL());
  });
});
