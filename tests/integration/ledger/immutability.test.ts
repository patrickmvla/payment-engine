import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
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

// --- 1c. Immutability Enforcement ---

describe("ledger immutability", () => {
  it("does not expose updateEntry or deleteEntry on the service", () => {
    const service = ledgerService as Record<string, unknown>;
    expect(typeof service.updateEntry).toBe("undefined");
    expect(typeof service.deleteEntry).toBe("undefined");
  });

  it("does not expose deleteTransaction on the service", () => {
    const service = ledgerService as Record<string, unknown>;
    expect(typeof service.deleteTransaction).toBe("undefined");
  });

  it("UPDATE on ledger_entries is rejected by immutability trigger", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Immutability test",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 5000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
      ],
    });

    const entryId = txn.entries[0]!.id;

    await expect(
      db.execute(sql`UPDATE ledger_entries SET amount = 9999 WHERE id = ${entryId}`),
    ).rejects.toThrow(/immut/i);
  });

  it("DELETE on ledger_entries is rejected by immutability trigger", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Delete immutability test",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 3000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 3000n },
      ],
    });

    const entryId = txn.entries[0]!.id;

    await expect(db.execute(sql`DELETE FROM ledger_entries WHERE id = ${entryId}`)).rejects.toThrow(
      /immut/i,
    );
  });

  it("correcting a mistake uses reversal pattern — net balance is correct", async () => {
    // Step 1: Original (wrong) transaction — $100 instead of $75
    await ledgerService.postTransaction(db, {
      description: "Original authorization (wrong amount)",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    // Step 2: Reverse the original
    await ledgerService.postTransaction(db, {
      description: "Reversal of wrong authorization",
      entries: [
        { accountId: "customer_funds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_holds", direction: "CREDIT", amount: 10000n },
      ],
    });

    // Step 3: Correct transaction
    await ledgerService.postTransaction(db, {
      description: "Correct authorization ($75)",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 7500n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 7500n },
      ],
    });

    // Net balance = $75 (all three transactions exist in the audit trail)
    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(7500n);
  });
});
