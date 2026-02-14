import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "valid_account_type",
      sql`${t.type} IN ('asset', 'liability', 'equity', 'revenue', 'expense')`,
    ),
  ],
);

export const ledgerTransactions = pgTable("ledger_transactions", {
  id: text("id").primaryKey(),
  description: text("description").notNull(),
  referenceType: text("reference_type"),
  referenceId: text("reference_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    direction: text("direction").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("positive_amount", sql`${t.amount} > 0`),
    check("valid_direction", sql`${t.direction} IN ('DEBIT', 'CREDIT')`),
    index("idx_entries_account").on(t.accountId),
    index("idx_entries_transaction").on(t.transactionId),
  ],
);
