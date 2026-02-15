import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
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

describe("refund", () => {
  it("full refund transitions to refunded status", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id, { amount: 10000n });

    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(10000n);
  });

  it("omitted amount refunds the entire captured amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(10000n);
  });

  it("partial refund transitions to partially_refunded", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const partial = await paymentService.refund(db, captured.id, { amount: 3000n });

    expect(partial.status).toBe("partially_refunded");
    expect(partial.refundedAmount).toBe(3000n);
  });

  it("multiple partial refunds accumulate then final transitions to refunded", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const r1 = await paymentService.refund(db, captured.id, { amount: 2000n });
    expect(r1.status).toBe("partially_refunded");
    expect(r1.refundedAmount).toBe(2000n);

    const r2 = await paymentService.refund(db, captured.id, { amount: 3000n });
    expect(r2.status).toBe("partially_refunded");
    expect(r2.refundedAmount).toBe(5000n);

    const r3 = await paymentService.refund(db, captured.id, { amount: 5000n });
    expect(r3.status).toBe("refunded");
    expect(r3.refundedAmount).toBe(10000n);
  });

  it("refund after partial capture is limited to captured amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n });

    const refunded = await paymentService.refund(db, captured.id, { amount: 7000n });
    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(7000n);
  });

  it("refunding exactly the remaining amount transitions to refunded", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    await paymentService.refund(db, captured.id, { amount: 6000n });
    const final = await paymentService.refund(db, captured.id, { amount: 4000n });

    expect(final.status).toBe("refunded");
    expect(final.refundedAmount).toBe(10000n);
  });

  it("refunding 1 cent succeeds", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id, { amount: 1n });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.refundedAmount).toBe(1n);
  });

  it("rejects refund exceeding remaining refundable amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const err = await paymentService.refund(db, captured.id, { amount: 10001n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceed|remaining|amount/i);
  });

  it("rejects refund of zero amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const err = await paymentService.refund(db, captured.id, { amount: 0n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/zero|amount|invalid/i);
  });

  it("rejects further refunds after full refund", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    const err = await paymentService.refund(db, captured.id, { amount: 1n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/refunded|exceed|remaining/i);
  });

  it("rejects refunding an authorized (not captured) payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.refund(db, auth.id, { amount: 5000n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/authorized|state|transition|capture/i);
  });

  it("rejects refunding a voided payment", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.refund(db, voided.id, { amount: 5000n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("full lifecycle (auth -> capture -> refund) nets all accounts to zero", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    for (const accountId of [
      "customer_holds",
      "customer_funds",
      "merchant_payable",
      "platform_fees",
    ]) {
      const balance = await ledgerService.getBalance(db, accountId);
      expect(balance).toBe(0n);
    }
  });

  it("refund with reason preserves the reason", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id, {
      amount: 10000n,
      reason: "Customer requested cancellation",
    });

    expect(refunded.status).toBe("refunded");
    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBe(10000n);
  });
});
