import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

const SYSTEM_ACCOUNTS = [
  { id: "customer_funds", name: "Customer Funds", type: "liability", currency: "USD" },
  { id: "customer_holds", name: "Customer Holds", type: "asset", currency: "USD" },
  { id: "merchant_payable", name: "Merchant Payable", type: "liability", currency: "USD" },
  { id: "platform_cash", name: "Platform Cash", type: "asset", currency: "USD" },
  { id: "platform_fees", name: "Platform Fees", type: "revenue", currency: "USD" },
] as const;

async function seedSystemAccounts() {
  for (const account of SYSTEM_ACCOUNTS) {
    await sql`
      INSERT INTO accounts (id, name, type, currency)
      VALUES (${account.id}, ${account.name}, ${account.type}, ${account.currency})
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

export async function setupTestDB() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is required to run tests");
  }

  const ssl = process.env.DATABASE_SSL === "true";

  sql = postgres(testUrl, {
    max: 5,
    idle_timeout: 10,
    prepare: false,
    ssl: ssl ? "require" : false,
  });

  db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seedSystemAccounts();
  return db;
}

export async function teardownTestDB() {
  await sql`TRUNCATE ledger_entries, ledger_transactions, payments, idempotency_keys CASCADE`;
  await sql.end();
}

/** Truncate data tables but keep accounts. For use between tests. */
export async function cleanDatabase() {
  await sql`TRUNCATE ledger_entries, ledger_transactions, payments, idempotency_keys CASCADE`;
}

/** Alias for cleanDatabase. Used in afterEach hooks per doc convention. */
export const cleanBetweenTests = cleanDatabase;

export function getTestDB() {
  return db;
}

export function getTestSQL() {
  return sql;
}
