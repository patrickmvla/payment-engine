import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { assertEntriesBalance } from "../../helpers/assertions";
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

// --- 1a. Posting Balanced Transactions ---

describe("postTransaction", () => {
  it("creates a two-entry balanced transaction", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Test two-entry transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    expect(txn.id).toMatch(/^txn_/);
    expect(txn.entries).toHaveLength(2);
    assertEntriesBalance(txn.entries);
  });

  it("creates a multi-entry transaction with fee split", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Payment with platform fee",
      entries: [
        { accountId: "customer_funds", direction: "DEBIT", amount: 10000n },
        { accountId: "merchant_payable", direction: "CREDIT", amount: 9700n },
        { accountId: "platform_fees", direction: "CREDIT", amount: 300n },
      ],
    });

    expect(txn.entries).toHaveLength(3);
    assertEntriesBalance(txn.entries);

    const debitTotal = txn.entries
      .filter((e) => e.direction === "DEBIT")
      .reduce((sum, e) => sum + e.amount, 0n);
    const creditTotal = txn.entries
      .filter((e) => e.direction === "CREDIT")
      .reduce((sum, e) => sum + e.amount, 0n);

    expect(debitTotal).toBe(10000n);
    expect(creditTotal).toBe(10000n);
  });

  it("creates a transaction with reference links", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Authorize payment pay_test123",
      referenceType: "payment",
      referenceId: "pay_test123",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 5000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
      ],
    });

    expect(txn.referenceType).toBe("payment");
    expect(txn.referenceId).toBe("pay_test123");
  });

  it("accepts the minimum amount of 1 cent", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Minimum amount transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 1n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 1n },
      ],
    });

    expect(txn.entries[0]!.amount).toBe(1n);
    assertEntriesBalance(txn.entries);
  });

  it("accepts a large amount without overflow", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Large amount transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 99999999n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 99999999n },
      ],
    });

    expect(txn.entries[0]!.amount).toBe(99999999n);
    assertEntriesBalance(txn.entries);
  });
});

// --- 1b. Rejection of Invalid Transactions ---

describe("postTransaction — rejection", () => {
  it("rejects unbalanced transaction where debits exceed credits", async () => {
    const err = await ledgerService
      .postTransaction(db, {
        description: "Unbalanced — debits too high",
        entries: [
          { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
          { accountId: "customer_funds", direction: "CREDIT", amount: 9000n },
        ],
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/balance|unbalanced/i);
  });

  it("rejects unbalanced transaction where credits exceed debits", async () => {
    const err = await ledgerService
      .postTransaction(db, {
        description: "Unbalanced — credits too high",
        entries: [
          { accountId: "customer_holds", direction: "DEBIT", amount: 8000n },
          { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
        ],
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/balance|unbalanced/i);
  });

  it("rejects a transaction with a single entry", async () => {
    const err = await ledgerService
      .postTransaction(db, {
        description: "Single entry — impossible to balance",
        entries: [{ accountId: "customer_holds", direction: "DEBIT", amount: 5000n }],
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/entries|balance|minimum/i);
  });

  it("rejects a transaction with empty entries", async () => {
    const err = await ledgerService
      .postTransaction(db, {
        description: "No entries at all",
        entries: [],
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/entries|empty|required/i);
  });

  it("rejects a transaction referencing a non-existent account", async () => {
    const err = await ledgerService
      .postTransaction(db, {
        description: "Bad account reference",
        entries: [
          {
            accountId: "nonexistent_account",
            direction: "DEBIT",
            amount: 1000n,
          },
          { accountId: "customer_funds", direction: "CREDIT", amount: 1000n },
        ],
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/account|not found|exist/i);
  });

  it("failed transaction leaves zero entries (atomicity)", async () => {
    try {
      await ledgerService.postTransaction(db, {
        description: "Will fail — unbalanced",
        entries: [
          { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
          { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
        ],
      });
    } catch {
      // Expected
    }

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    const fundsBalance = await ledgerService.getBalance(db, "customer_funds");
    expect(holdsBalance).toBe(0n);
    expect(fundsBalance).toBe(0n);
  });
});
