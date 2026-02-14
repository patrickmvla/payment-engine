import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
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

// --- 1e. Transaction History ---
// Tests that require paymentService (full lifecycle history) are in Phase 3.
// These test the ledger's own history capabilities.

describe("transaction history", () => {
  it("getTransactionsByReference returns transactions for a reference", async () => {
    await ledgerService.postTransaction(db, {
      description: "Authorize payment pay_hist_01",
      referenceType: "payment",
      referenceId: "pay_hist_01",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    const transactions = await ledgerService.getTransactionsByReference(
      db,
      "payment",
      "pay_hist_01",
    );

    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.referenceId).toBe("pay_hist_01");
  });

  it("returns empty array for non-existent reference", async () => {
    const transactions = await ledgerService.getTransactionsByReference(
      db,
      "payment",
      "pay_nonexistent",
    );

    expect(transactions).toHaveLength(0);
  });

  it("multiple transactions for same reference are in chronological order", async () => {
    const refId = "pay_hist_02";

    // Transaction 1: Authorize
    await ledgerService.postTransaction(db, {
      description: `Authorize payment ${refId}`,
      referenceType: "payment",
      referenceId: refId,
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    // Transaction 2: Reverse hold (simulate capture step 1)
    await ledgerService.postTransaction(db, {
      description: `Release hold for ${refId}`,
      referenceType: "payment",
      referenceId: refId,
      entries: [
        { accountId: "customer_funds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_holds", direction: "CREDIT", amount: 10000n },
      ],
    });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", refId);

    expect(transactions).toHaveLength(2);
    for (let i = 1; i < transactions.length; i++) {
      const prev = new Date(transactions[i - 1]!.createdAt).getTime();
      const curr = new Date(transactions[i]!.createdAt).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it("entries are grouped per transaction", async () => {
    const refId = "pay_hist_03";

    await ledgerService.postTransaction(db, {
      description: `Transaction for ${refId}`,
      referenceType: "payment",
      referenceId: refId,
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 5000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
      ],
    });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", refId);

    for (const txn of transactions) {
      expect(txn.entries.length).toBeGreaterThanOrEqual(2);
      for (const entry of txn.entries) {
        expect(entry.transactionId).toBe(txn.id);
      }
    }
  });

  it("descriptions are preserved in history", async () => {
    const refId = "pay_hist_04";
    const desc = `Authorize $100.00 for ${refId}`;

    await ledgerService.postTransaction(db, {
      description: desc,
      referenceType: "payment",
      referenceId: refId,
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", refId);

    expect(transactions[0]!.description).toBe(desc);
  });
});
