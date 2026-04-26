import { afterAll, beforeAll, describe, expect, it , vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Migration: Safety Tests
 *
 * Proves that migrations are:
 *   1. Complete — produce all 5 expected tables
 *   2. Idempotent — running twice doesn't error
 *   3. Correct — CHECK constraints and indexes exist
 *
 * Uses a separate raw postgres connection. After schema drop + re-migrate,
 * re-seeds system accounts so subsequent tests can run.
 */

const REQUIRED_TABLES = [
  "accounts",
  "ledger_transactions",
  "ledger_entries",
  "payments",
  "idempotency_keys",
];

const SYSTEM_ACCOUNTS = [
  { id: "customer_funds", name: "Customer Funds", type: "liability", currency: "USD" },
  { id: "customer_holds", name: "Customer Holds", type: "asset", currency: "USD" },
  { id: "merchant_payable", name: "Merchant Payable", type: "liability", currency: "USD" },
  { id: "platform_cash", name: "Platform Cash", type: "asset", currency: "USD" },
  { id: "platform_fees", name: "Platform Fees", type: "revenue", currency: "USD" },
];

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is required to run migration tests");
  }

  const ssl = process.env.DATABASE_SSL === "true";

  sql = postgres(testUrl, {
    max: 3,
    idle_timeout: 10,
    connect_timeout: 30,
    prepare: false,
    ssl: ssl ? "require" : false,
  });

  db = drizzle(sql);
});

afterAll(async () => {
  // Re-seed accounts after potentially destructive tests
  for (const account of SYSTEM_ACCOUNTS) {
    await sql`
      INSERT INTO accounts (id, name, type, currency)
      VALUES (${account.id}, ${account.name}, ${account.type}, ${account.currency})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await sql.end();
});

describe("migration safety", () => {
  it("produces all 5 required tables from a clean schema", async () => {
    // Drop and recreate public schema
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    // Also drop the drizzle migration tracking schema so migrations re-run
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;

    // Run migrations from scratch
    await migrate(db, { migrationsFolder: "./drizzle" });

    // Verify all tables exist
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = ANY(${REQUIRED_TABLES})
    `;
    const found = tables.map((t) => t.table_name as string).sort();
    expect(found).toEqual([...REQUIRED_TABLES].sort());
  });

  it("runs migrations a second time without error (idempotent)", async () => {
    // This should not throw — migrations should be idempotent
    await migrate(db, { migrationsFolder: "./drizzle" });

    // Tables should still exist
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = ANY(${REQUIRED_TABLES})
    `;
    expect(tables.length).toBe(REQUIRED_TABLES.length);
  });

  it("CHECK constraints exist on ledger_entries and payments", async () => {
    const constraints = await sql`
      SELECT constraint_name, table_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
      AND constraint_type = 'CHECK'
      AND constraint_name IN (
        'positive_amount', 'valid_direction',
        'valid_status', 'non_negative_amounts',
        'refund_limit', 'capture_limit'
      )
    `;
    const names = constraints.map((c) => c.constraint_name as string).sort();

    expect(names).toContain("positive_amount");
    expect(names).toContain("non_negative_amounts");
    expect(names).toContain("refund_limit");
    expect(names).toContain("capture_limit");
  });

  it("indexes exist on payments and ledger_entries", async () => {
    const indexes = await sql`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE schemaname = 'public'
      AND tablename IN ('payments', 'ledger_entries')
    `;
    const indexNames = indexes.map((i) => i.indexname as string);

    // Check for expected indexes
    expect(indexNames.some((n) => n.includes("payments") && n.includes("status"))).toBe(true);
    expect(indexNames.some((n) => n.includes("entries") && n.includes("account"))).toBe(true);
    expect(indexNames.some((n) => n.includes("entries") && n.includes("transaction"))).toBe(true);
  });
});
