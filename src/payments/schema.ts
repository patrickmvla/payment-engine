import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    authorizedAmount: bigint("authorized_amount", { mode: "bigint" }).notNull().default(sql`0`),
    capturedAmount: bigint("captured_amount", { mode: "bigint" }).notNull().default(sql`0`),
    refundedAmount: bigint("refunded_amount", { mode: "bigint" }).notNull().default(sql`0`),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, string>>(),
    idempotencyKey: text("idempotency_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "valid_status",
      sql`${t.status} IN ('created', 'authorized', 'captured', 'settled', 'voided', 'expired', 'refunded', 'partially_refunded')`,
    ),
    check(
      "non_negative_amounts",
      sql`${t.amount} >= 0 AND ${t.authorizedAmount} >= 0 AND ${t.capturedAmount} >= 0 AND ${t.refundedAmount} >= 0`,
    ),
    check("refund_limit", sql`${t.refundedAmount} <= ${t.capturedAmount}`),
    check("capture_limit", sql`${t.capturedAmount} <= ${t.authorizedAmount}`),
    index("idx_payments_status").on(t.status),
    index("idx_payments_idempotency").on(t.idempotencyKey),
  ],
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  responseCode: integer("response_code").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
