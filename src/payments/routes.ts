import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "../shared/db";
import { ValidationError } from "../shared/errors";
import { AuthorizeSchema, CaptureSchema, RefundSchema } from "./schemas";
import { paymentService } from "./service";
import type { PaymentRecord } from "./types";

const app = new OpenAPIHono();

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

// POST /api/v1/payments/authorize
app.post("/api/v1/payments/authorize", async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const raw = await c.req.json();
  const parsed = AuthorizeSchema.safeParse(raw);

  if (!parsed.success) {
    throw new ValidationError("Request validation failed", {
      fields: parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const body = parsed.data;

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

// POST /api/v1/payments/:id/capture
app.post("/api/v1/payments/:id/capture", async (c) => {
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

// POST /api/v1/payments/:id/void
app.post("/api/v1/payments/:id/void", async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const paymentId = c.req.param("id");

  const result = await paymentService.void(db, paymentId);

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 200);
});

// POST /api/v1/payments/:id/settle
app.post("/api/v1/payments/:id/settle", async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const paymentId = c.req.param("id");

  const result = await paymentService.settle(db, paymentId);

  c.header("X-Idempotency-Key", idempotencyKey);
  return c.json(toPaymentResponse(result), 200);
});

// POST /api/v1/payments/:id/refund
app.post("/api/v1/payments/:id/refund", async (c) => {
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

// GET /api/v1/payments/:id
app.get("/api/v1/payments/:id", async (c) => {
  const paymentId = c.req.param("id");
  const result = await paymentService.getPayment(db, paymentId);
  return c.json(toPaymentResponse(result), 200);
});

// GET /api/v1/payments
app.get("/api/v1/payments", async (c) => {
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const cursor = c.req.query("cursor") || undefined;
  const status = c.req.query("status") || undefined;

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
