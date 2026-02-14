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

// --- 1d. Balance Queries ---
// Tests 4-6 (payment lifecycle consistency) require paymentService — Phase 3.

describe("balance queries", () => {
  it("returns the correct balance after a single transaction", async () => {
    await ledgerService.postTransaction(db, {
      description: "Single transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    const fundsBalance = await ledgerService.getBalance(db, "customer_funds");

    // customer_holds (ASSET): debits - credits = 10000
    expect(holdsBalance).toBe(10000n);
    // customer_funds (LIABILITY): credits - debits = 10000
    expect(fundsBalance).toBe(10000n);
  });

  it("accumulates across multiple transactions", async () => {
    for (const amount of [5000n, 3000n, 2000n]) {
      await ledgerService.postTransaction(db, {
        description: `Transaction for ${amount}`,
        entries: [
          { accountId: "customer_holds", direction: "DEBIT", amount },
          { accountId: "customer_funds", direction: "CREDIT", amount },
        ],
      });
    }

    const balance = await ledgerService.getBalance(db, "customer_holds");
    expect(balance).toBe(10000n);
  });

  it("returns zero for an untouched account", async () => {
    const balance = await ledgerService.getBalance(db, "platform_fees");
    expect(balance).toBe(0n);
  });

  it("matches raw SQL sum of entries", async () => {
    await ledgerService.postTransaction(db, {
      description: "Transaction for SQL verification",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 25000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 25000n },
      ],
    });

    const serviceBalance = await ledgerService.getBalance(db, "customer_holds");

    const result = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS debits,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS credits
      FROM ledger_entries
      WHERE account_id = 'customer_holds'
    `);

    const row = result[0] as { debits: string; credits: string };
    const rawBalance = BigInt(row.debits) - BigInt(row.credits);
    expect(serviceBalance).toBe(rawBalance);
  });
});
