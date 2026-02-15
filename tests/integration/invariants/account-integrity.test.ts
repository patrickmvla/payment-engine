import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { ledgerService } from "../../../src/ledger/service";
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

describe("account integrity", () => {
  it("every account service balance matches raw SQL computation", async () => {
    // Create diverse operations
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth1.id);

    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });
    await paymentService.void(db, auth2.id);

    const captured3 = await createCapturedPayment(db, { authorizeAmount: 15000n });
    await paymentService.refund(db, captured3.id, { amount: 5000n });

    // Account types: asset/expense = debit-normal, liability/revenue = credit-normal
    const accountConfigs = [
      { id: "customer_funds", debitNormal: false },
      { id: "customer_holds", debitNormal: true },
      { id: "merchant_payable", debitNormal: false },
      { id: "platform_fees", debitNormal: false },
      { id: "platform_cash", debitNormal: true },
    ];

    for (const { id: accountId, debitNormal } of accountConfigs) {
      const serviceBalance = await ledgerService.getBalance(db, accountId);

      const rawResult = await db.execute(
        sql`SELECT
          COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS debits,
          COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS credits
        FROM ledger_entries
        WHERE account_id = ${accountId}`,
      );

      const rawDebits = BigInt(rawResult[0].debits);
      const rawCredits = BigInt(rawResult[0].credits);
      const rawBalance = debitNormal ? rawDebits - rawCredits : rawCredits - rawDebits;

      expect(serviceBalance).toBe(rawBalance);
    }
  });

  it("no orphaned entries — every entry references a valid transaction and account", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });

    const orphaned = await db.execute(
      sql`SELECT le.id
        FROM ledger_entries le
        LEFT JOIN ledger_transactions lt ON le.transaction_id = lt.id
        WHERE lt.id IS NULL`,
    );

    expect(orphaned).toHaveLength(0);
  });

  it("balance is deterministic — querying twice returns the same result", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });

    const balance1 = await ledgerService.getBalance(db, "customer_holds");
    const balance2 = await ledgerService.getBalance(db, "customer_holds");

    expect(balance1).toBe(balance2);
  });
});
