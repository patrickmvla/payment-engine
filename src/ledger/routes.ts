import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { db } from "../shared/db";
import { ValidationError } from "../shared/errors";
import { accounts } from "./schema";
import { ledgerService } from "./service";

const app = new OpenAPIHono();

// GET /api/v1/payments/:id/ledger
app.get("/api/v1/payments/:id/ledger", async (c) => {
  const paymentId = c.req.param("id");

  const transactions = await ledgerService.getTransactionsByReference(db, "payment", paymentId);

  return c.json(
    {
      payment_id: paymentId,
      transactions: transactions.map((txn) => ({
        id: txn.id,
        description: txn.description,
        created_at: txn.createdAt.toISOString(),
        entries: txn.entries.map((e) => ({
          id: e.id,
          account: e.accountId,
          direction: e.direction,
          amount: Number(e.amount),
        })),
      })),
    },
    200,
  );
});

// GET /api/v1/accounts/:id/balance
app.get("/api/v1/accounts/:id/balance", async (c) => {
  const accountId = c.req.param("id");

  // Look up account metadata
  const accountRows = await db.select().from(accounts).where(eq(accounts.id, accountId));

  if (accountRows.length === 0) {
    throw new ValidationError(`Account '${accountId}' not found`, {
      account_id: accountId,
    });
  }

  const account = accountRows[0]!;
  const balance = await ledgerService.getBalance(db, accountId);

  return c.json(
    {
      account_id: account.id,
      account_name: account.name,
      account_type: account.type,
      currency: account.currency,
      balance: Number(balance),
      as_of: new Date().toISOString(),
    },
    200,
  );
});

export { app as ledgerRoutes };
