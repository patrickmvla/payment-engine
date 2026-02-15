import { and, desc, eq, lt, sql } from "drizzle-orm";
import { ledgerService } from "../ledger/service";
import type { Database } from "../shared/db";
import {
  IdempotencyConflictError,
  InvalidAmountError,
  PaymentNotFoundError,
  InvalidStateTransitionError as ServiceStateError,
} from "../shared/errors";
import { generateId } from "../shared/id";
import { splitAmount } from "../shared/money";
import { idempotencyKeys, payments } from "./schema";
import { validateTransition } from "./state-machine";
import type {
  AuthorizeParams,
  CaptureParams,
  ListPaymentsOptions,
  PaginatedResponse,
  PaymentRecord,
  RefundParams,
} from "./types";

const PLATFORM_FEE_PERCENT = 3;
const AUTH_EXPIRY_DAYS = 7;

function toPaymentRecord(row: typeof payments.$inferSelect): PaymentRecord {
  return {
    id: row.id,
    status: row.status as PaymentRecord["status"],
    amount: row.amount,
    currency: row.currency,
    authorizedAmount: row.authorizedAmount,
    capturedAmount: row.capturedAmount,
    refundedAmount: row.refundedAmount,
    description: row.description,
    metadata: row.metadata,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

async function findPaymentForUpdate(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  paymentId: string,
): Promise<typeof payments.$inferSelect> {
  const rows = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");

  if (rows.length === 0) {
    throw new PaymentNotFoundError(paymentId);
  }

  return rows[0]!;
}

function checkExpiration(row: typeof payments.$inferSelect): typeof payments.$inferSelect {
  if (row.status === "authorized" && row.expiresAt && new Date(row.expiresAt) < new Date()) {
    // Mark as expired — will be persisted by the caller
    return { ...row, status: "expired" };
  }
  return row;
}

async function authorize(
  db: Database,
  params: AuthorizeParams,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  // Check idempotency first
  const existingKey = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, idempotencyKey));

  if (existingKey.length > 0) {
    const existing = existingKey[0]!;
    // Check if params match by comparing against the stored payment
    const existingPayment = await db
      .select()
      .from(payments)
      .where(eq(payments.id, existing.resourceId));

    if (existingPayment.length > 0) {
      const p = existingPayment[0]!;
      if (p.amount !== params.amount || p.currency !== params.currency) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return toPaymentRecord(p);
    }
  }

  const paymentId = generateId("pay");
  const expiresAt = new Date(Date.now() + AUTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  return await db.transaction(async (tx) => {
    // Double-check idempotency inside transaction
    const existingPaymentByKey = await tx
      .select()
      .from(payments)
      .where(eq(payments.idempotencyKey, idempotencyKey));

    if (existingPaymentByKey.length > 0) {
      const p = existingPaymentByKey[0]!;
      if (p.amount !== params.amount || p.currency !== params.currency) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return toPaymentRecord(p);
    }

    const rows = await tx
      .insert(payments)
      .values({
        id: paymentId,
        status: "authorized",
        amount: params.amount,
        currency: params.currency,
        authorizedAmount: params.amount,
        capturedAmount: 0n,
        refundedAmount: 0n,
        description: params.description ?? null,
        metadata: params.metadata ?? null,
        idempotencyKey,
        expiresAt,
      })
      .returning();

    // Create ledger entries: DEBIT customer_holds / CREDIT customer_funds
    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Authorize payment ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: params.amount },
        { accountId: "customer_funds", direction: "CREDIT", amount: params.amount },
      ],
    });

    // Store idempotency key
    await tx.insert(idempotencyKeys).values({
      key: idempotencyKey,
      resourceType: "payment",
      resourceId: paymentId,
      responseCode: 201,
      responseBody: {},
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    return toPaymentRecord(rows[0]!);
  });
}

async function handleExpiration(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  row: typeof payments.$inferSelect,
  paymentId: string,
): Promise<void> {
  await tx
    .update(payments)
    .set({ status: "expired", expiresAt: null, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));

  await ledgerService.postTransaction(tx as unknown as Database, {
    description: `Expire payment ${paymentId}`,
    referenceType: "payment",
    referenceId: paymentId,
    entries: [
      { accountId: "customer_funds", direction: "DEBIT", amount: row.amount },
      { accountId: "customer_holds", direction: "CREDIT", amount: row.amount },
    ],
  });
}

async function capture(
  db: Database,
  paymentId: string,
  params?: CaptureParams,
): Promise<PaymentRecord> {
  const result = await db.transaction(async (tx) => {
    let row = await findPaymentForUpdate(tx, paymentId);

    // Check expiration on-access
    row = checkExpiration(row);
    if (row.status === "expired") {
      await handleExpiration(tx, row, paymentId);
      return { expired: true as const };
    }

    validateTransition(row.status as any, "captured");

    const captureAmount = params?.amount ?? row.authorizedAmount;

    if (captureAmount <= 0n) {
      throw new InvalidAmountError("Capture amount must be greater than zero", {
        amount: captureAmount.toString(),
      });
    }

    if (captureAmount > row.authorizedAmount) {
      throw new InvalidAmountError(
        `Capture amount ${captureAmount} exceeds authorized amount ${row.authorizedAmount}`,
        {
          capture_amount: captureAmount.toString(),
          authorized_amount: row.authorizedAmount.toString(),
        },
      );
    }

    const { merchantShare, fee } = splitAmount(captureAmount, PLATFORM_FEE_PERCENT);

    // Build capture ledger entries: 3 DEBIT/CREDIT pairs (6 entries) when fee > 0
    // or 2 DEBIT/CREDIT pairs (4 entries) when fee = 0
    const captureEntries: { accountId: string; direction: "DEBIT" | "CREDIT"; amount: bigint }[] = [
      // 1. Release hold (reversal of auth) — full authorized amount
      { accountId: "customer_funds", direction: "DEBIT", amount: row.authorizedAmount },
      { accountId: "customer_holds", direction: "CREDIT", amount: row.authorizedAmount },
      // 2. Charge customer → merchant (merchant share)
      { accountId: "customer_funds", direction: "DEBIT", amount: merchantShare },
      { accountId: "merchant_payable", direction: "CREDIT", amount: merchantShare },
    ];

    // 3. Charge customer → platform fee (only if fee > 0)
    if (fee > 0n) {
      captureEntries.push(
        { accountId: "customer_funds", direction: "DEBIT", amount: fee },
        { accountId: "platform_fees", direction: "CREDIT", amount: fee },
      );
    }

    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Capture payment ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: captureEntries,
    });

    const updated = await tx
      .update(payments)
      .set({
        status: "captured",
        capturedAmount: captureAmount,
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId))
      .returning();

    return { expired: false as const, payment: toPaymentRecord(updated[0]!) };
  });

  if (result.expired) {
    throw new ServiceStateError(paymentId, "expired", "capture");
  }
  return result.payment;
}

async function voidPayment(db: Database, paymentId: string): Promise<PaymentRecord> {
  const result = await db.transaction(async (tx) => {
    let row = await findPaymentForUpdate(tx, paymentId);

    // Check expiration on-access
    row = checkExpiration(row);
    if (row.status === "expired") {
      await handleExpiration(tx, row, paymentId);
      return { expired: true as const };
    }

    validateTransition(row.status as any, "voided");

    // Void entries: mirror of auth (DEBIT customer_funds / CREDIT customer_holds)
    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Void payment ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: [
        { accountId: "customer_funds", direction: "DEBIT", amount: row.authorizedAmount },
        { accountId: "customer_holds", direction: "CREDIT", amount: row.authorizedAmount },
      ],
    });

    const updated = await tx
      .update(payments)
      .set({
        status: "voided",
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId))
      .returning();

    return { expired: false as const, payment: toPaymentRecord(updated[0]!) };
  });

  if (result.expired) {
    throw new ServiceStateError(paymentId, "expired", "void");
  }
  return result.payment;
}

async function refund(
  db: Database,
  paymentId: string,
  params?: RefundParams,
): Promise<PaymentRecord> {
  return await db.transaction(async (tx) => {
    const row = await findPaymentForUpdate(tx, paymentId);

    // Determine target status
    const currentStatus = row.status as PaymentRecord["status"];

    // Refund is valid from captured, settled, or partially_refunded
    if (
      currentStatus !== "captured" &&
      currentStatus !== "settled" &&
      currentStatus !== "partially_refunded"
    ) {
      throw new ServiceStateError(paymentId, currentStatus, "refund");
    }

    const refundAmount = params?.amount ?? row.capturedAmount - row.refundedAmount;

    if (refundAmount <= 0n) {
      throw new InvalidAmountError("Refund amount must be greater than zero", {
        amount: refundAmount.toString(),
      });
    }

    const remainingRefundable = row.capturedAmount - row.refundedAmount;
    if (refundAmount > remainingRefundable) {
      throw new InvalidAmountError(
        `Refund amount ${refundAmount} exceeds remaining refundable amount ${remainingRefundable}`,
        {
          refund_amount: refundAmount.toString(),
          remaining: remainingRefundable.toString(),
        },
      );
    }

    const newRefundedAmount = row.refundedAmount + refundAmount;
    const isFullRefund = newRefundedAmount >= row.capturedAmount;
    const newStatus = isFullRefund ? "refunded" : "partially_refunded";

    // Calculate proportional fee refund
    const { fee: refundFee, merchantShare: refundMerchantShare } = splitAmount(
      refundAmount,
      PLATFORM_FEE_PERCENT,
    );

    // Refund entries: reverse merchant + fee → credit customer
    const refundEntries: { accountId: string; direction: "DEBIT" | "CREDIT"; amount: bigint }[] = [
      { accountId: "merchant_payable", direction: "DEBIT", amount: refundMerchantShare },
      { accountId: "customer_funds", direction: "CREDIT", amount: refundAmount },
    ];

    if (refundFee > 0n) {
      refundEntries.push({
        accountId: "platform_fees",
        direction: "DEBIT",
        amount: refundFee,
      });
    }
    // Balance check:
    // Total debits = refundMerchantShare + refundFee = refundAmount
    // Total credits = refundAmount ✓

    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Refund payment ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: refundEntries,
    });

    // Validate transition
    if (currentStatus === "captured" || currentStatus === "settled") {
      validateTransition(currentStatus, newStatus as any);
    } else if (currentStatus === "partially_refunded") {
      validateTransition("partially_refunded", newStatus as any);
    }

    const updated = await tx
      .update(payments)
      .set({
        status: newStatus,
        refundedAmount: newRefundedAmount,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId))
      .returning();

    return toPaymentRecord(updated[0]!);
  });
}

async function settle(db: Database, paymentId: string): Promise<PaymentRecord> {
  return await db.transaction(async (tx) => {
    const row = await findPaymentForUpdate(tx, paymentId);

    validateTransition(row.status as any, "settled");

    // Settlement amount = merchant_share (captured - fee)
    const { merchantShare } = splitAmount(row.capturedAmount, PLATFORM_FEE_PERCENT);

    // Settlement entries: DEBIT merchant_payable / CREDIT platform_cash
    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Settle payment ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: [
        { accountId: "merchant_payable", direction: "DEBIT", amount: merchantShare },
        { accountId: "platform_cash", direction: "CREDIT", amount: merchantShare },
      ],
    });

    const updated = await tx
      .update(payments)
      .set({
        status: "settled",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId))
      .returning();

    return toPaymentRecord(updated[0]!);
  });
}

async function getPayment(db: Database, paymentId: string): Promise<PaymentRecord> {
  const rows = await db.select().from(payments).where(eq(payments.id, paymentId));

  if (rows.length === 0) {
    throw new PaymentNotFoundError(paymentId);
  }

  return toPaymentRecord(rows[0]!);
}

async function listPayments(
  db: Database,
  options?: ListPaymentsOptions,
): Promise<PaginatedResponse<PaymentRecord>> {
  const limit = options?.limit ?? 20;
  const cursor = options?.cursor;
  const status = options?.status;

  const conditions = [];
  if (cursor) {
    conditions.push(lt(payments.id, cursor));
  }
  if (status) {
    conditions.push(eq(payments.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(payments)
    .where(where)
    .orderBy(desc(payments.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(toPaymentRecord);
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : undefined;

  return { data, hasMore, nextCursor };
}

export const paymentService = {
  authorize,
  capture,
  void: voidPayment,
  refund,
  settle,
  getPayment,
  listPayments,
};
