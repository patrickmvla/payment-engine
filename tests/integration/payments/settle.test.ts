import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { assertEntriesBalance } from "../../helpers/assertions";
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

describe("settle", () => {
  it("transitions payment to settled status", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const settled = await paymentService.settle(db, captured.id);

    expect(settled.status).toBe("settled");
  });

  it("creates correct ledger entries (DEBIT merchant_payable, CREDIT platform_cash)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", captured.id);
    const settleTxn = transactions.find((t) => t.description.toLowerCase().includes("settle"));
    expect(settleTxn).toBeDefined();
    expect(settleTxn!.entries).toHaveLength(2);
    assertEntriesBalance(settleTxn!.entries);

    const debit = settleTxn!.entries.find((e) => e.direction === "DEBIT");
    const credit = settleTxn!.entries.find((e) => e.direction === "CREDIT");
    expect(debit!.accountId).toBe("merchant_payable");
    expect(credit!.accountId).toBe("platform_cash");
  });

  it("settlement amount equals captured minus fee (merchant_share)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const fee = (10000n * 3n) / 100n;
    const merchantShare = 10000n - fee;

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", captured.id);
    const settleTxn = transactions.find((t) => t.description.toLowerCase().includes("settle"));
    const debit = settleTxn!.entries.find((e) => e.direction === "DEBIT");
    expect(debit!.amount).toBe(merchantShare);
  });

  it("zeroes out merchant_payable for this payment", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const balanceBefore = await ledgerService.getBalance(db, "merchant_payable");
    expect(balanceBefore).toBeGreaterThan(0n);

    await paymentService.settle(db, captured.id);

    const balanceAfter = await ledgerService.getBalance(db, "merchant_payable");
    expect(balanceAfter).toBe(0n);
  });

  it("records outflow in platform_cash (negative asset balance)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const fee = (10000n * 3n) / 100n;
    const merchantShare = 10000n - fee;

    const balance = await ledgerService.getBalance(db, "platform_cash");
    expect(balance).toBe(-merchantShare);
  });

  it("rejects settling an authorized (not captured) payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.settle(db, auth.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/authorized|state|transition|captured/i);
  });

  it("rejects settling an already settled payment", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const err = await paymentService.settle(db, captured.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/settled|state|already/i);
  });

  it("rejects settling a voided payment", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.settle(db, voided.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("rejects settling a non-existent payment", async () => {
    const err = await paymentService.settle(db, "pay_nonexistent_00000000").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });

  it("refund after settlement is allowed and transitions correctly", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const refunded = await paymentService.refund(db, captured.id, { amount: 10000n });
    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(10000n);
  });
});
