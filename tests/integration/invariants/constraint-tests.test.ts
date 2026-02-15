import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
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
  await cleanBetweenTests();
});

describe("database constraints", () => {
  it("rejects captured_amount > authorized_amount", async () => {
    const err = await db
      .execute(
        sql`INSERT INTO payments (id, status, amount, currency, authorized_amount, captured_amount, refunded_amount, created_at, updated_at)
            VALUES ('pay_constraint_test_01', 'captured', 10000, 'USD', 10000, 15000, 0, NOW(), NOW())`,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/constraint|check|captured/i);
  });

  it("rejects refunded_amount > captured_amount", async () => {
    const err = await db
      .execute(
        sql`INSERT INTO payments (id, status, amount, currency, authorized_amount, captured_amount, refunded_amount, created_at, updated_at)
            VALUES ('pay_constraint_test_02', 'refunded', 10000, 'USD', 10000, 10000, 15000, NOW(), NOW())`,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/constraint|check|refund/i);
  });

  it("rejects zero amount in ledger entry", async () => {
    await db.execute(
      sql`INSERT INTO ledger_transactions (id, description, reference_type, reference_id, created_at)
          VALUES ('txn_constraint_test_1', 'test', 'payment', 'pay_test', NOW())`,
    );

    const err = await db
      .execute(
        sql`INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
            VALUES ('ent_constraint_test_1', 'txn_constraint_test_1', 'customer_funds', 'DEBIT', 0)`,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/constraint|check|amount/i);
  });

  it("rejects negative amount in ledger entry", async () => {
    await db.execute(
      sql`INSERT INTO ledger_transactions (id, description, reference_type, reference_id, created_at)
          VALUES ('txn_constraint_test_2', 'test', 'payment', 'pay_test', NOW())`,
    );

    const err = await db
      .execute(
        sql`INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
            VALUES ('ent_constraint_test_2', 'txn_constraint_test_2', 'customer_funds', 'DEBIT', -500)`,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/constraint|check|amount/i);
  });

  it("rejects invalid payment status", async () => {
    const err = await db
      .execute(
        sql`INSERT INTO payments (id, status, amount, currency, authorized_amount, captured_amount, refunded_amount, created_at, updated_at)
            VALUES ('pay_constraint_test_03', 'invalid_status', 10000, 'USD', 10000, 0, 0, NOW(), NOW())`,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/constraint|check|enum|status|type/i);
  });

  it("rejects invalid ledger entry direction", async () => {
    await db.execute(
      sql`INSERT INTO ledger_transactions (id, description, reference_type, reference_id, created_at)
          VALUES ('txn_constraint_test_3', 'test', 'payment', 'pay_test', NOW())`,
    );

    const err = await db
      .execute(
        sql`INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
            VALUES ('ent_constraint_test_3', 'txn_constraint_test_3', 'customer_funds', 'INVALID', 100)`,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/constraint|check|enum|direction|type/i);
  });
});
