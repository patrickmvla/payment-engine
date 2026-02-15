import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { db } from "../shared/db";
import { ValidationError } from "../shared/errors";
import {
  AccountBalanceResponseSchema,
  AccountIdParamSchema,
  ErrorResponseSchema,
  LedgerResponseSchema,
  PaymentIdParamSchema,
} from "../payments/schemas";
import { accounts } from "./schema";
import { ledgerService } from "./service";

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            type: "validation_error",
            message: "Request validation failed",
            details: {
              fields: result.error.issues.map((i) => ({
                field: i.path.join("."),
                message: i.message,
              })),
            },
          },
        },
        400,
      );
    }
  },
});

// --- Route definitions ---

const paymentLedgerRoute = createRoute({
  method: "get",
  path: "/api/v1/payments/{id}/ledger",
  tags: ["Ledger"],
  summary: "Get ledger entries for a payment",
  request: {
    params: PaymentIdParamSchema,
  },
  responses: {
    200: {
      description: "Ledger transactions for the payment",
      content: { "application/json": { schema: LedgerResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const accountBalanceRoute = createRoute({
  method: "get",
  path: "/api/v1/accounts/{id}/balance",
  tags: ["Ledger"],
  summary: "Get account balance",
  request: {
    params: AccountIdParamSchema,
  },
  responses: {
    200: {
      description: "Account balance",
      content: { "application/json": { schema: AccountBalanceResponseSchema } },
    },
    400: {
      description: "Account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Handlers ---

app.openapi(paymentLedgerRoute, async (c) => {
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

app.openapi(accountBalanceRoute, async (c) => {
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
