import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { db } from "../shared/db";
import { ValidationError } from "../shared/errors";
import {
  AuthorizeSchema,
  CaptureSchema,
  ErrorResponseSchema,
  IdempotencyKeyHeaderSchema,
  ListPaymentsQuerySchema,
  PaymentIdParamSchema,
  PaymentListResponseSchema,
  PaymentResponseSchema,
  RefundSchema,
} from "./schemas";
import { paymentService } from "./service";
import type { PaymentRecord } from "./types";

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

function toPaymentResponse(payment: PaymentRecord) {
  return {
    id: payment.id,
    object: "payment" as const,
    status: payment.status,
    amount: Number(payment.amount),
    currency: payment.currency,
    authorized_amount: Number(payment.authorizedAmount),
    captured_amount: Number(payment.capturedAmount),
    refunded_amount: Number(payment.refundedAmount),
    description: payment.description,
    metadata: payment.metadata,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
    expires_at: payment.expiresAt?.toISOString() ?? null,
  };
}

function requireIdempotencyKey(c: any): string {
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    throw new ValidationError("Idempotency-Key header is required for mutation endpoints");
  }
  return key;
}

// --- Route definitions ---

const authorizeRoute = createRoute({
  method: "post",
  path: "/api/v1/payments/authorize",
  tags: ["Payments"],
  summary: "Authorize a payment (hold funds)",
  request: {
    headers: IdempotencyKeyHeaderSchema,
    body: { content: { "application/json": { schema: AuthorizeSchema } } },
  },
  responses: {
    201: {
      description: "Payment authorized",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Idempotency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const captureRoute = createRoute({
  method: "post",
  path: "/api/v1/payments/{id}/capture",
  tags: ["Payments"],
  summary: "Capture an authorized payment",
  request: {
    headers: IdempotencyKeyHeaderSchema,
    params: PaymentIdParamSchema,
    body: { content: { "application/json": { schema: CaptureSchema } }, required: false },
  },
  responses: {
    200: {
      description: "Payment captured",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Invalid state transition",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const voidRoute = createRoute({
  method: "post",
  path: "/api/v1/payments/{id}/void",
  tags: ["Payments"],
  summary: "Void an authorized payment",
  request: {
    headers: IdempotencyKeyHeaderSchema,
    params: PaymentIdParamSchema,
  },
  responses: {
    200: {
      description: "Payment voided",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Invalid state transition",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const settleRoute = createRoute({
  method: "post",
  path: "/api/v1/payments/{id}/settle",
  tags: ["Payments"],
  summary: "Settle a captured payment",
  request: {
    headers: IdempotencyKeyHeaderSchema,
    params: PaymentIdParamSchema,
  },
  responses: {
    200: {
      description: "Payment settled",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Invalid state transition",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const refundRoute = createRoute({
  method: "post",
  path: "/api/v1/payments/{id}/refund",
  tags: ["Payments"],
  summary: "Refund a captured or settled payment",
  request: {
    headers: IdempotencyKeyHeaderSchema,
    params: PaymentIdParamSchema,
    body: { content: { "application/json": { schema: RefundSchema } }, required: false },
  },
  responses: {
    200: {
      description: "Payment refunded",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Invalid state transition",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Invalid amount",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const getPaymentRoute = createRoute({
  method: "get",
  path: "/api/v1/payments/{id}",
  tags: ["Payments"],
  summary: "Get a payment by ID",
  request: {
    params: PaymentIdParamSchema,
  },
  responses: {
    200: {
      description: "Payment details",
      content: { "application/json": { schema: PaymentResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const listPaymentsRoute = createRoute({
  method: "get",
  path: "/api/v1/payments",
  tags: ["Payments"],
  summary: "List payments (cursor pagination)",
  request: {
    query: ListPaymentsQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of payments",
      content: { "application/json": { schema: PaymentListResponseSchema } },
    },
  },
});

// --- Handlers ---

app.openapi(authorizeRoute, async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const body = c.req.valid("json");

  const result = await paymentService.authorize(
    db,
    {
      amount: BigInt(body.amount),
      currency: body.currency,
      description: body.description,
      metadata: body.metadata,
    },
    idempotencyKey,
  );

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 201);
});

app.openapi(captureRoute, async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const paymentId = c.req.param("id");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = CaptureSchema.safeParse(raw);

  if (!parsed.success) {
    throw new ValidationError("Request validation failed", {
      fields: parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const body = parsed.data;
  const captureParams = body.amount ? { amount: BigInt(body.amount) } : undefined;

  const result = await paymentService.capture(db, paymentId, captureParams);

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 200);
});

app.openapi(voidRoute, async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const paymentId = c.req.param("id");

  const result = await paymentService.void(db, paymentId);

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 200);
});

app.openapi(settleRoute, async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const paymentId = c.req.param("id");

  const result = await paymentService.settle(db, paymentId);

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 200);
});

app.openapi(refundRoute, async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const paymentId = c.req.param("id");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = RefundSchema.safeParse(raw);

  if (!parsed.success) {
    throw new ValidationError("Request validation failed", {
      fields: parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const body = parsed.data;
  const refundParams = body.amount ? { amount: BigInt(body.amount), reason: body.reason } : undefined;

  const result = await paymentService.refund(db, paymentId, refundParams);

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 200);
});

app.openapi(getPaymentRoute, async (c) => {
  const paymentId = c.req.param("id");
  const result = await paymentService.getPayment(db, paymentId);
  return c.json(toPaymentResponse(result), 200);
});

app.openapi(listPaymentsRoute, async (c) => {
  const query = c.req.valid("query");
  const limit = query.limit ? Number(query.limit) : undefined;
  const cursor = query.cursor || undefined;
  const status = query.status || undefined;

  const result = await paymentService.listPayments(db, {
    limit,
    cursor,
    status: status as any,
  });

  return c.json(
    {
      object: "list" as const,
      data: result.data.map(toPaymentResponse),
      has_more: result.hasMore,
      next_cursor: result.nextCursor ?? null,
    },
    200,
  );
});

export { app as paymentRoutes };
