import postgres from "postgres";
import { config } from "../src/shared/config.ts";
import { logger } from "../src/shared/logger.ts";

if (config.APP_ENV === "production") {
  console.error("REFUSING to reset database in production environment.");
  console.error("APP_ENV is set to 'production'. This operation is blocked.");
  process.exit(1);
}

if (!config.DATABASE_URL.includes("localhost")) {
  const host = config.DATABASE_URL.split("@")[1] ?? "unknown";
  console.error("REFUSING to reset a non-local database.");
  console.error(`DATABASE_URL points to: ${host}`);
  console.error("Only localhost databases can be reset.");
  process.exit(1);
}

const sql = postgres(config.DATABASE_URL, { max: 1 });

try {
  logger.info("Dropping all tables...");

  await sql`DROP TABLE IF EXISTS ledger_entries CASCADE`;
  await sql`DROP TABLE IF EXISTS ledger_transactions CASCADE`;
  await sql`DROP TABLE IF EXISTS payments CASCADE`;
  await sql`DROP TABLE IF EXISTS idempotency_keys CASCADE`;
  await sql`DROP TABLE IF EXISTS accounts CASCADE`;
  await sql`DROP TABLE IF EXISTS __drizzle_migrations CASCADE`;

  // Drop immutability triggers and functions
  await sql`DROP FUNCTION IF EXISTS prevent_ledger_transaction_mutation() CASCADE`;
  await sql`DROP FUNCTION IF EXISTS prevent_ledger_entry_mutation() CASCADE`;

  logger.info("All tables dropped. Run db:migrate and db:seed to rebuild.");
} catch (err) {
  console.error("Reset failed:", err);
  process.exit(1);
} finally {
  await sql.end();
}
