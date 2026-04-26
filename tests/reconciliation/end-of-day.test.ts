import { afterAll, beforeAll, describe, expect, it , vi } from "vitest";
import { paymentService } from "../../src/payments/service";
import type { Database } from "../../src/shared/db";
import { ledgerService } from "../../src/ledger/service";
import { uniqueKey } from "../helpers/factories";
import {
  verifyAccountIntegrity,
  verifyAllTransactionsBalance,
  verifySystemBalance,
} from "../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Reconciliation: End-of-Day
 *
 * Simulates a full trading day with ~15 payments in various states,
 * then runs reconciliation queries that an auditor would run.
 */

let db: Awaited<ReturnType<typeof setupTestDB>>;
let sql: ReturnType<typeof getTestSQL>;
const paymentIds: string[] = [];

async function simulateTradingDay(typedDb: Database) {
  // 3 authorized (still pending)
  for (let i = 0; i < 3; i++) {
    const p = await paymentService.authorize(
      typedDb,
      { amount: BigInt(10_000 + i * 1000), currency: "USD" },
      uniqueKey(),
    );
    paymentIds.push(p.id);
  }

  // 3 captured
  for (let i = 0; i < 3; i++) {
    const p = await paymentService.authorize(
      typedDb,
      { amount: BigInt(20_000 + i * 1000), currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, p.id, undefined, uniqueKey());
    paymentIds.push(p.id);
  }

  // 2 settled
  for (let i = 0; i < 2; i++) {
    const p = await paymentService.authorize(
      typedDb,
      { amount: BigInt(30_000 + i * 1000), currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, p.id, undefined, uniqueKey());
    await paymentService.settle(typedDb, p.id, uniqueKey());
    paymentIds.push(p.id);
  }

  // 2 voided
  for (let i = 0; i < 2; i++) {
    const p = await paymentService.authorize(
      typedDb,
      { amount: BigInt(15_000 + i * 1000), currency: "USD" },
      uniqueKey(),
    );
    await paymentService.void(typedDb, p.id, uniqueKey());
    paymentIds.push(p.id);
  }

  // 2 refunded (full)
  for (let i = 0; i < 2; i++) {
    const p = await paymentService.authorize(
      typedDb,
      { amount: BigInt(25_000 + i * 1000), currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, p.id, undefined, uniqueKey());
    await paymentService.refund(typedDb, p.id, undefined, uniqueKey());
    paymentIds.push(p.id);
  }

  // 1 partially refunded
  const partial = await paymentService.authorize(
    typedDb,
    { amount: 50_000n, currency: "USD" },
    uniqueKey(),
  );
  await paymentService.capture(typedDb, partial.id, undefined, uniqueKey());
  await paymentService.refund(typedDb, partial.id, { amount: 20_000n }, uniqueKey());
  paymentIds.push(partial.id);

  // 1 settled then partially refunded
  const settledPartial = await paymentService.authorize(
    typedDb,
    { amount: 40_000n, currency: "USD" },
    uniqueKey(),
  );
  await paymentService.capture(typedDb, settledPartial.id, undefined, uniqueKey());
  await paymentService.settle(typedDb, settledPartial.id, uniqueKey());
  await paymentService.refund(typedDb, settledPartial.id, { amount: 10_000n }, uniqueKey());
  paymentIds.push(settledPartial.id);
}

beforeAll(async () => {
  db = await setupTestDB();
  sql = getTestSQL();
  await cleanBetweenTests();
  await simulateTradingDay(db as unknown as Database);
});

afterAll(async () => {
  await cleanBetweenTests();
  await teardownTestDB();
});

describe("end-of-day reconciliation", () => {
  it("every payment has at least one ledger transaction", async () => {
    const result = await sql`
      SELECT p.id
      FROM payments p
      LEFT JOIN ledger_transactions lt ON lt.reference_id = p.id AND lt.reference_type = 'payment'
      GROUP BY p.id
      HAVING COUNT(lt.id) = 0
    `;
    expect(result.length).toBe(0);
  });

  it("no orphan ledger entries (every entry belongs to a transaction)", async () => {
    const result = await sql`
      SELECT le.id
      FROM ledger_entries le
      LEFT JOIN ledger_transactions lt ON le.transaction_id = lt.id
      WHERE lt.id IS NULL
    `;
    expect(result.length).toBe(0);
  });

  it("no empty transactions (every transaction has at least 2 entries)", async () => {
    const result = await sql`
      SELECT lt.id, COUNT(le.id)::int AS entry_count
      FROM ledger_transactions lt
      LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
      GROUP BY lt.id
      HAVING COUNT(le.id) < 2
    `;
    expect(result.length).toBe(0);
  });

  it("every individual transaction balances", async () => {
    await verifyAllTransactionsBalance(sql);
  });

  it("all account balances are valid bigints (account integrity)", async () => {
    await verifyAccountIntegrity(sql);
  });

  it("system-wide debits equal credits (god check)", async () => {
    await verifySystemBalance(sql);
  });
});
