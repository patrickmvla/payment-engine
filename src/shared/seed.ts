import postgres from "postgres";
import { config } from "./config.ts";
import { logger } from "./logger.ts";

const SYSTEM_ACCOUNTS = [
  { id: "customer_funds", name: "Customer Funds", type: "liability", currency: "USD" },
  { id: "customer_holds", name: "Customer Holds", type: "asset", currency: "USD" },
  { id: "merchant_payable", name: "Merchant Payable", type: "liability", currency: "USD" },
  { id: "platform_cash", name: "Platform Cash", type: "asset", currency: "USD" },
  { id: "platform_fees", name: "Platform Fees", type: "revenue", currency: "USD" },
] as const;

async function seed() {
  if (config.APP_ENV === "production") {
    console.warn("WARNING: Seeding production database.");
    console.warn("This will INSERT system accounts if they don't exist.");
    console.warn("This will NOT delete or modify existing data.");
    console.warn("Press Ctrl+C within 5 seconds to abort.");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const sql = postgres(config.DATABASE_URL, {
    ssl: config.DATABASE_SSL ? "require" : false,
    max: 1,
  });

  try {
    for (const account of SYSTEM_ACCOUNTS) {
      const result = await sql`
        INSERT INTO accounts (id, name, type, currency)
        VALUES (${account.id}, ${account.name}, ${account.type}, ${account.currency})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;

      if (result.length > 0) {
        logger.info({ account_id: account.id }, "Created system account");
      } else {
        logger.info({ account_id: account.id }, "System account already exists");
      }
    }

    logger.info("Seed complete. All system accounts verified.");
  } finally {
    await sql.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
