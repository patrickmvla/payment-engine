import { z } from "@hono/zod-openapi";

// --- Shared sub-schemas ---

const MetadataSchema = z
  .any()
  .refine(
    (val) => {
      if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
      if (Object.getPrototypeOf(val) !== Object.prototype) return false;
      const keys = Object.keys(val);
      if (keys.length > 10) return false;
      return keys.every((key) => typeof val[key] === "string");
    },
    { message: "Invalid metadata: must be a flat object with string values (max 10 keys)" },
  )
  .transform((val) => val as Record<string, string>);

const PaymentStatusEnum = z.enum([
  "created",
  "authorized",
  "captured",
  "settled",
  "voided",
  "expired",
  "refunded",
  "partially_refunded",
]);

// --- Request schemas ---

export const AuthorizeSchema = z
  .object({
    amount: z.number().int().positive().max(99999999).openapi({
      example: 5000,
      description: "Amount in smallest currency unit (e.g. cents)",
    }),
    currency: z.string().regex(/^[A-Z]{3}$/).openapi({
      example: "USD",
      description: "ISO 4217 currency code",
    }),
    description: z.string().max(500).optional().openapi({
      example: "Order #1234",
    }),
    metadata: MetadataSchema.optional(),
  })
  .openapi("AuthorizeRequest");

export const CaptureSchema = z
  .object({
    amount: z.number().int().positive().optional().openapi({
      example: 5000,
      description: "Partial capture amount. Omit to capture the full authorized amount.",
    }),
  })
  .openapi("CaptureRequest");

export const RefundSchema = z
  .object({
    amount: z.number().int().positive().optional().openapi({
      example: 2500,
      description: "Partial refund amount. Omit to refund the full captured amount.",
    }),
    reason: z.string().max(500).optional().openapi({
      example: "Customer requested refund",
    }),
  })
  .openapi("RefundRequest");

// --- Path / query / header param schemas ---

export const PaymentIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "pay_01HW...",
    description: "Payment ID (ULID)",
  }),
});

export const AccountIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "customer_funds",
    description: "Account ID",
  }),
});

export const IdempotencyKeyHeaderSchema = z.object({
  "Idempotency-Key": z.string().optional().openapi({
    param: { name: "Idempotency-Key", in: "header", required: true },
    example: "idem_abc123",
    description: "Unique key for idempotent mutation requests",
  }),
});

export const ListPaymentsQuerySchema = z.object({
  limit: z.string().optional().openapi({
    param: { name: "limit", in: "query" },
    example: "20",
    description: "Max results per page",
  }),
  cursor: z.string().optional().openapi({
    param: { name: "cursor", in: "query" },
    description: "Cursor for next page",
  }),
  status: PaymentStatusEnum.optional().openapi({
    param: { name: "status", in: "query" },
    description: "Filter by payment status",
  }),
});

// --- Response schemas ---

export const PaymentResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal("payment"),
    status: PaymentStatusEnum,
    amount: z.number(),
    currency: z.string(),
    authorized_amount: z.number(),
    captured_amount: z.number(),
    refunded_amount: z.number(),
    description: z.string().nullable(),
    metadata: z.record(z.string(), z.string()).nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi("Payment");

export const PaymentListResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(PaymentResponseSchema),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  })
  .openapi("PaymentList");

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      type: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi("Error");

export const LedgerEntrySchema = z.object({
  id: z.string(),
  account: z.string(),
  direction: z.enum(["DEBIT", "CREDIT"]),
  amount: z.number(),
});

export const LedgerTransactionSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  entries: z.array(LedgerEntrySchema),
});

export const LedgerResponseSchema = z
  .object({
    payment_id: z.string(),
    transactions: z.array(LedgerTransactionSchema),
  })
  .openapi("LedgerResponse");

export const AccountBalanceResponseSchema = z
  .object({
    account_id: z.string(),
    account_name: z.string(),
    account_type: z.string(),
    currency: z.string(),
    balance: z.number(),
    as_of: z.string(),
  })
  .openapi("AccountBalance");
