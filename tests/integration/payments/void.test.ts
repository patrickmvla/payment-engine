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

describe("void", () => {
  it("transitions payment to voided status", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const voided = await paymentService.void(db, auth.id);

    expect(voided.status).toBe("voided");
  });

  it("creates reversing ledger entries", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.void(db, auth.id);

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    expect(transactions).toHaveLength(2);

    const voidTxn = transactions.find((t) => t.description.toLowerCase().includes("void"));
    expect(voidTxn).toBeDefined();
    assertEntriesBalance(voidTxn!.entries);
  });

  it("net effect on customer_holds is zero", async () => {
    const balanceBefore = await ledgerService.getBalance(db, "customer_holds");
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const balanceAfterAuth = await ledgerService.getBalance(db, "customer_holds");
    expect(balanceAfterAuth - balanceBefore).toBe(10000n);

    await paymentService.void(db, auth.id);

    const balanceAfterVoid = await ledgerService.getBalance(db, "customer_holds");
    expect(balanceAfterVoid).toBe(balanceBefore);
  });

  it("rejects voiding a captured payment", async () => {
    const captured = await createCapturedPayment(db);

    const err = await paymentService.void(db, captured.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/captured|state|transition/i);
  });

  it("rejects voiding an already voided payment", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.void(db, voided.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|already/i);
  });

  it("voided payment is terminal — capture fails", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.capture(db, voided.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("voided payment is terminal — refund fails", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.refund(db, voided.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("clears expiresAt on the voided payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const voided = await paymentService.void(db, auth.id);

    expect(voided.expiresAt).toBeNull();
  });
});
