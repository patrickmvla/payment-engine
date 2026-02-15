import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config.ts";
import { logger } from "./logger.ts";

function sanitizeConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid connection string]";
  }
}

const connectionOptions: postgres.Options<Record<string, never>> = {
  ssl: config.DATABASE_SSL ? "require" : false,
  max: config.DB_POOL_SIZE,
  idle_timeout: 30,
  connect_timeout: 30,
  max_lifetime: 60 * 30,
  prepare: false,
  onnotice: (notice) => {
    logger.debug({ notice: notice.message }, "postgres_notice");
  },
};

logger.info(
  {
    pool_size: config.DB_POOL_SIZE,
    ssl: config.DATABASE_SSL,
    database: sanitizeConnectionString(config.DATABASE_URL),
    environment: config.APP_ENV,
  },
  "Database connection configured",
);

export const client = postgres(config.DATABASE_URL, connectionOptions);
export const db = drizzle(client);

export type Database = PostgresJsDatabase<Record<string, unknown>>;

export async function closeDatabase(): Promise<void> {
  logger.info("Draining database connection pool...");
  await client.end({ timeout: 5 });
  logger.info("Database connections closed.");
}

export async function validateDatabase(): Promise<void> {
  const checks: Array<{ name: string; check: () => Promise<void> }> = [
    {
      name: "connection",
      check: async () => {
        const result = await client`SELECT 1 as ping`;
        if (result[0]?.ping !== 1) throw new Error("Ping failed");
      },
    },
    {
      name: "schema",
      check: async () => {
        const tables = await client`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name IN (
            'accounts', 'ledger_transactions', 'ledger_entries',
            'payments', 'idempotency_keys'
          )
        `;
        const found = tables.map((t) => t.table_name as string);
        const required = [
          "accounts",
          "ledger_transactions",
          "ledger_entries",
          "payments",
          "idempotency_keys",
        ];
        const missing = required.filter((t) => !found.includes(t));
        if (missing.length > 0) {
          throw new Error(`Missing tables: ${missing.join(", ")}. Run migrations first.`);
        }
      },
    },
    {
      name: "accounts",
      check: async () => {
        const accounts = await client`SELECT id FROM accounts`;
        const required = [
          "customer_funds",
          "customer_holds",
          "merchant_payable",
          "platform_cash",
          "platform_fees",
        ];
        const found = accounts.map((a) => a.id as string);
        const missing = required.filter((a) => !found.includes(a));
        if (missing.length > 0) {
          throw new Error(`Missing system accounts: ${missing.join(", ")}. Run db:seed first.`);
        }
      },
    },
    {
      name: "constraints",
      check: async () => {
        const constraints = await client`
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_schema = 'public'
          AND constraint_name IN (
            'positive_amount', 'non_negative_amounts',
            'refund_limit', 'capture_limit'
          )
        `;
        const found = constraints.map((c) => c.constraint_name as string);
        const required = [
          "positive_amount",
          "non_negative_amounts",
          "refund_limit",
          "capture_limit",
        ];
        const missing = required.filter((c) => !found.includes(c));
        if (missing.length > 0) {
          throw new Error(
            `Missing database constraints: ${missing.join(", ")}. Schema is incomplete — migrations may have partially failed.`,
          );
        }
      },
    },
  ];

  logger.info("Running database validation checks...");

  for (const { name, check } of checks) {
    try {
      await check();
      logger.info({ check: name }, "Database check passed");
    } catch (error) {
      logger.fatal({ check: name, error }, "Database validation failed");
      throw new Error(
        `Database validation failed [${name}]: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  logger.info("All database validation checks passed.");
}
