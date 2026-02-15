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

describe("capture", () => {
  it("transitions payment to captured status and clears expiresAt", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(10000n);
    expect(captured.expiresAt).toBeNull();
  });

  it("captures entire authorized amount when amount is omitted", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 25000n });
    const captured = await paymentService.capture(db, auth.id);

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(25000n);
  });

  it("partial capture records the specified amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n });

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(7000n);
    expect(captured.authorizedAmount).toBe(10000n);
  });

  it("releases remaining hold after partial capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 7000n });

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(0n);
  });

  it("creates balanced ledger entries for the capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    expect(transactions.length).toBeGreaterThanOrEqual(2);

    for (const txn of transactions) {
      assertEntriesBalance(txn.entries);
    }
  });

  it("captures exact authorized amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });

    expect(captured.capturedAmount).toBe(10000n);
    expect(captured.status).toBe("captured");
  });

  it("captures 1 cent", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 1n });

    expect(captured.capturedAmount).toBe(1n);
    expect(captured.status).toBe("captured");
  });

  it("capture ledger entries split fee correctly (3% to platform_fees)", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureTxn = transactions.find((t) => t.description.toLowerCase().includes("capture"));
    expect(captureTxn).toBeDefined();

    expect(captureTxn!.entries).toHaveLength(6);
    assertEntriesBalance(captureTxn!.entries);

    const merchantCredit = captureTxn!.entries.find(
      (e) => e.accountId === "merchant_payable" && e.direction === "CREDIT",
    );
    const feeCredit = captureTxn!.entries.find(
      (e) => e.accountId === "platform_fees" && e.direction === "CREDIT",
    );
    expect(merchantCredit!.amount).toBe(9700n);
    expect(feeCredit!.amount).toBe(300n);
  });

  it("zero-fee edge case: amount <= 33 cents skips fee entries", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 33n });
    await paymentService.capture(db, auth.id, { amount: 33n });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureTxn = transactions.find((t) => t.description.toLowerCase().includes("capture"));
    expect(captureTxn).toBeDefined();

    expect(captureTxn!.entries).toHaveLength(4);
    assertEntriesBalance(captureTxn!.entries);

    const merchantCredit = captureTxn!.entries.find(
      (e) => e.accountId === "merchant_payable" && e.direction === "CREDIT",
    );
    expect(merchantCredit!.amount).toBe(33n);
  });

  it("rejects capture exceeding authorized amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.capture(db, auth.id, { amount: 10001n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceed|authorized|amount/i);
  });

  it("rejects capture of zero amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.capture(db, auth.id, { amount: 0n }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/zero|amount|invalid/i);
  });

  it("rejects capturing a voided payment with InvalidStateTransitionError context", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.capture(db, voided.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("rejects capturing an already captured payment", async () => {
    const captured = await createCapturedPayment(db);

    const err = await paymentService.capture(db, captured.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/captured|state|already/i);
  });

  it("rejects capturing a non-existent payment", async () => {
    const err = await paymentService.capture(db, "pay_nonexistent_00000000").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });
});
