import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { assertEntriesBalance } from "../../helpers/assertions";
import { createAuthorizedPayment, uniqueKey } from "../../helpers/factories";
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

describe("authorize", () => {
  it("creates a payment with authorized status", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    expect(payment.id).toMatch(/^pay_/);
    expect(payment.status).toBe("authorized");
    expect(payment.amount).toBe(10000n);
    expect(payment.authorizedAmount).toBe(10000n);
    expect(payment.capturedAmount).toBe(0n);
    expect(payment.refundedAmount).toBe(0n);
    expect(payment.currency).toBe("USD");
  });

  it("creates correct ledger entries (DEBIT customer_holds, CREDIT customer_funds)", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", payment.id);
    expect(transactions).toHaveLength(1);

    const entries = transactions[0]!.entries;
    expect(entries).toHaveLength(2);
    assertEntriesBalance(entries);

    const debit = entries.find((e) => e.direction === "DEBIT");
    const credit = entries.find((e) => e.direction === "CREDIT");
    expect(debit!.accountId).toBe("customer_holds");
    expect(debit!.amount).toBe(10000n);
    expect(credit!.accountId).toBe("customer_funds");
    expect(credit!.amount).toBe(10000n);
  });

  it("sets expiration approximately 7 days in the future", async () => {
    const payment = await createAuthorizedPayment(db);

    expect(payment.expiresAt).toBeDefined();
    const expiresAt = new Date(payment.expiresAt!).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    expect(expiresAt).toBeGreaterThan(now + sevenDaysMs - 30_000);
    expect(expiresAt).toBeLessThan(now + sevenDaysMs + 30_000);
  });

  it("preserves metadata on the payment record", async () => {
    const payment = await paymentService.authorize(
      db,
      {
        amount: 5000n,
        currency: "USD",
        description: "Order #42",
        metadata: { orderId: "ord_abc", tier: "premium" },
      },
      uniqueKey(),
    );

    expect(payment.description).toBe("Order #42");
    expect(payment.metadata).toEqual({ orderId: "ord_abc", tier: "premium" });
  });

  it("accepts minimum amount of 1 cent", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 1n });

    expect(payment.amount).toBe(1n);
    expect(payment.authorizedAmount).toBe(1n);
    expect(payment.status).toBe("authorized");
  });

  it("accepts a large amount", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 99999999n });

    expect(payment.amount).toBe(99999999n);
    expect(payment.authorizedAmount).toBe(99999999n);
  });

  it("increases the customer_holds balance", async () => {
    const balanceBefore = await ledgerService.getBalance(db, "customer_holds");
    await createAuthorizedPayment(db, { amount: 15000n });
    const balanceAfter = await ledgerService.getBalance(db, "customer_holds");

    expect(balanceAfter - balanceBefore).toBe(15000n);
  });

  it("multiple authorizations accumulate in customer_holds", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });
    await createAuthorizedPayment(db, { amount: 20000n });
    await createAuthorizedPayment(db, { amount: 5000n });

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(35000n);
  });

  it("preserves currency on the payment record", async () => {
    const payment = await createAuthorizedPayment(db, {
      amount: 10000n,
      currency: "USD",
    });

    expect(payment.currency).toBe("USD");
  });

  it("preserves description on the payment record", async () => {
    const payment = await createAuthorizedPayment(db, {
      amount: 10000n,
      description: "Widget purchase",
    });

    expect(payment.description).toBe("Widget purchase");
  });
});
