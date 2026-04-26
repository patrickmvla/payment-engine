import { afterAll, afterEach, beforeAll, describe, expect, it , vi } from "vitest";
import { paymentService } from "../../src/payments/service";
import type { Database } from "../../src/shared/db";
import { payments } from "../../src/payments/schema";
import { ledgerEntries, ledgerTransactions } from "../../src/ledger/schema";
import { createAuthorizedPayment, uniqueKey } from "../helpers/factories";
import { verifySystemBalance } from "../helpers/god-check";
import { cleanBetweenTests, getTestDB, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";
import { eq } from "drizzle-orm";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Failure: Transaction Rollback Tests
 *
 * Proves that partial failures inside database transactions leave
 * no orphaned data. If a transaction throws, everything rolls back.
 */

let db: Awaited<ReturnType<typeof setupTestDB>>;
let sql: ReturnType<typeof getTestSQL>;

beforeAll(async () => {
  db = await setupTestDB();
  sql = getTestSQL();
});
afterAll(async () => {
  await teardownTestDB();
});
afterEach(async () => {
  await verifySystemBalance(sql);
  await cleanBetweenTests();
});

describe("transaction rollback on failure", () => {
  it("rolls back partial ledger entries when transaction throws", async () => {
    const countBefore = await sql`SELECT COUNT(*)::int AS count FROM ledger_entries`;

    try {
      await (db as unknown as Database).transaction(async (tx) => {
        // Insert a ledger transaction manually
        await tx.insert(ledgerTransactions).values({
          id: "txn_test_orphan",
          description: "Should be rolled back",
        });

        // Insert one entry
        await tx.insert(ledgerEntries).values({
          id: "ent_test_orphan_1",
          transactionId: "txn_test_orphan",
          accountId: "customer_holds",
          direction: "DEBIT",
          amount: 5000n,
        });

        // Throw before inserting the balancing credit
        throw new Error("Simulated connection drop");
      });
    } catch {
      // Expected
    }

    // No orphan entries should exist
    const countAfter = await sql`SELECT COUNT(*)::int AS count FROM ledger_entries`;
    expect(countAfter[0]!.count).toBe(countBefore[0]!.count);

    // No orphan transaction should exist
    const txnCount = await sql`
      SELECT COUNT(*)::int AS count FROM ledger_transactions
      WHERE id = 'txn_test_orphan'
    `;
    expect(txnCount[0]!.count).toBe(0);
  });

  it("does not create a payment when service call throws unexpectedly", async () => {
    const countBefore = await sql`SELECT COUNT(*)::int AS count FROM payments`;

    try {
      // Try to capture a non-existent payment — should throw PaymentNotFoundError
      await paymentService.capture(db as unknown as Database, "pay_nonexistent_id", undefined, uniqueKey());
    } catch {
      // Expected
    }

    const countAfter = await sql`SELECT COUNT(*)::int AS count FROM payments`;
    expect(countAfter[0]!.count).toBe(countBefore[0]!.count);
  });

  it("does not update payment status when ledger entry creation fails inside transaction", async () => {
    const payment = await createAuthorizedPayment(db);
    expect(payment.status).toBe("authorized");

    try {
      await (db as unknown as Database).transaction(async (tx) => {
        // Update payment status directly (bypassing service)
        await tx
          .update(payments)
          .set({ status: "captured", updatedAt: new Date() })
          .where(eq(payments.id, payment.id));

        // Throw before creating matching ledger entries
        throw new Error("Simulated failure before ledger entries");
      });
    } catch {
      // Expected
    }

    // Payment should still be authorized (rollback)
    const current = await paymentService.getPayment(db as unknown as Database, payment.id);
    expect(current.status).toBe("authorized");
  });
});
