import { and, desc, eq, lt } from "drizzle-orm";
import { ledgerService } from "../ledger/service";
import type { Database } from "../shared/db";
import {
  IdempotencyConflictError,
  InvalidAmountError,
  PaymentNotFoundError,
  InvalidStateTransitionError as ServiceStateError,
} from "../shared/errors";
import { generateId } from "../shared/id";
import { claimIdempotency, hashParams, type TxLike } from "../shared/idempotency";
import { splitAmount, toDisplayAmount } from "../shared/money";
import { idempotencyKeys, payments } from "./schema";
import { getValidTransitions, validateTransition } from "./state-machine";
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
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
  tx: TxLike,
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
    return { ...row, status: "expired" };
  }
  return row;
}

async function authorize(
  db: Database,
  params: AuthorizeParams,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  const paramsHash = hashParams({
    amount: params.amount,
    currency: params.currency,
    description: params.description ?? null,
    metadata: params.metadata ?? null,
  });

  return await db.transaction(async (tx) => {
    const paymentId = generateId("pay");
    const expiresAt = new Date(Date.now() + AUTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const claimed = await tx
      .insert(idempotencyKeys)
      .values({
        key: idempotencyKey,
        resourceType: "payment.authorize",
        resourceId: paymentId,
        responseCode: 201,
        responseBody: { params_hash: paramsHash },
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing()
      .returning();

    if (claimed.length === 0) {
      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, idempotencyKey));

      if (existing.length === 0) {
        throw new IdempotencyConflictError(idempotencyKey);
      }

      const row = existing[0]!;
      const stored = row.responseBody as { params_hash?: string } | null;

      if (row.resourceType !== "payment.authorize" || stored?.params_hash !== paramsHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }

      const existingPayment = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, row.resourceId));

      if (existingPayment.length === 0) {
        throw new IdempotencyConflictError(idempotencyKey);
      }

      return toPaymentRecord(existingPayment[0]!);
    }

    const inserted = await tx
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

    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Authorize ${toDisplayAmount(params.amount)} for ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: params.amount },
        { accountId: "customer_funds", direction: "CREDIT", amount: params.amount },
      ],
    });

    return toPaymentRecord(inserted[0]!);
  });
}

async function handleExpiration(
  tx: TxLike,
  row: typeof payments.$inferSelect,
  paymentId: string,
): Promise<void> {
  await tx
    .update(payments)
    .set({ status: "expired", expiresAt: null, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));

  await ledgerService.postTransaction(tx as unknown as Database, {
    description: `Expire ${toDisplayAmount(row.amount)} for ${paymentId}`,
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
  params: CaptureParams | undefined,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  const paramsHash = hashParams({ amount: params?.amount ?? null });

  const result = await db.transaction(async (tx) => {
    let row = await findPaymentForUpdate(tx, paymentId);

    const claim = await claimIdempotency(
      tx,
      {
        key: idempotencyKey,
        resourceType: "payment.capture",
        resourceId: paymentId,
        paramsHash,
      },
      200,
    );

    if (!claim.won) {
      return { expired: false as const, payment: toPaymentRecord(row) };
    }

    row = checkExpiration(row);
    if (row.status === "expired") {
      await handleExpiration(tx, row, paymentId);
      return { expired: true as const };
    }

    validateTransition(row.status as any, "captured");

    // Multi-capture per [[2026-04-26-multi-capture-model]]: capture amount
    // is bounded by remaining authorized (auth - already-captured), not by
    // the full auth amount. Default amount when omitted is the remaining.
    const remainingAuthorized = row.authorizedAmount - row.capturedAmount;
    const captureAmount = params?.amount ?? remainingAuthorized;

    if (captureAmount <= 0n) {
      throw new InvalidAmountError("Capture amount must be greater than zero", {
        amount: captureAmount.toString(),
      });
    }

    if (captureAmount > remainingAuthorized) {
      throw new InvalidAmountError(
        `Capture amount ${captureAmount} exceeds remaining authorized amount ${remainingAuthorized}`,
        {
          capture_amount: captureAmount.toString(),
          remaining_authorized: remainingAuthorized.toString(),
          authorized_amount: row.authorizedAmount.toString(),
          already_captured: row.capturedAmount.toString(),
        },
      );
    }

    const { merchantShare, fee } = splitAmount(captureAmount, PLATFORM_FEE_PERCENT);

    // Hold release fires ONCE — on the first capture (when capturedAmount is
    // still 0). Subsequent partial captures only post the customer→merchant
    // and customer→platform-fee transfers; the hold has already been
    // released in full.
    const isFirstCapture = row.capturedAmount === 0n;
    const captureEntries: { accountId: string; direction: "DEBIT" | "CREDIT"; amount: bigint }[] =
      [];

    if (isFirstCapture) {
      captureEntries.push(
        { accountId: "customer_funds", direction: "DEBIT", amount: row.authorizedAmount },
        { accountId: "customer_holds", direction: "CREDIT", amount: row.authorizedAmount },
      );
    }

    captureEntries.push(
      { accountId: "customer_funds", direction: "DEBIT", amount: merchantShare },
      { accountId: "merchant_payable", direction: "CREDIT", amount: merchantShare },
    );

    if (fee > 0n) {
      captureEntries.push(
        { accountId: "customer_funds", direction: "DEBIT", amount: fee },
        { accountId: "platform_fees", direction: "CREDIT", amount: fee },
      );
    }

    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Capture ${toDisplayAmount(captureAmount)} for ${paymentId}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: captureEntries,
    });

    const updated = await tx
      .update(payments)
      .set({
        status: "captured",
        capturedAmount: row.capturedAmount + captureAmount,
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId))
      .returning();

    return { expired: false as const, payment: toPaymentRecord(updated[0]!) };
  });

  if (result.expired) {
    throw new ServiceStateError(paymentId, "expired", "capture", getValidTransitions("expired"));
  }
  return result.payment;
}

async function voidPayment(
  db: Database,
  paymentId: string,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  const paramsHash = hashParams({});

  const result = await db.transaction(async (tx) => {
    let row = await findPaymentForUpdate(tx, paymentId);

    const claim = await claimIdempotency(
      tx,
      {
        key: idempotencyKey,
        resourceType: "payment.void",
        resourceId: paymentId,
        paramsHash,
      },
      200,
    );

    if (!claim.won) {
      return { expired: false as const, payment: toPaymentRecord(row) };
    }

    row = checkExpiration(row);
    if (row.status === "expired") {
      await handleExpiration(tx, row, paymentId);
      return { expired: true as const };
    }

    validateTransition(row.status as any, "voided");

    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Void ${toDisplayAmount(row.authorizedAmount)} for ${paymentId}`,
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
    throw new ServiceStateError(paymentId, "expired", "void", getValidTransitions("expired"));
  }
  return result.payment;
}

async function refund(
  db: Database,
  paymentId: string,
  params: RefundParams | undefined,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  const paramsHash = hashParams({
    amount: params?.amount ?? null,
    reason: params?.reason ?? null,
  });

  return await db.transaction(async (tx) => {
    const row = await findPaymentForUpdate(tx, paymentId);

    const claim = await claimIdempotency(
      tx,
      {
        key: idempotencyKey,
        resourceType: "payment.refund",
        resourceId: paymentId,
        paramsHash,
      },
      200,
    );

    if (!claim.won) {
      return toPaymentRecord(row);
    }

    const currentStatus = row.status as PaymentRecord["status"];

    if (
      currentStatus !== "captured" &&
      currentStatus !== "settled" &&
      currentStatus !== "partially_refunded"
    ) {
      throw new ServiceStateError(
        paymentId,
        currentStatus,
        "refund",
        getValidTransitions(currentStatus),
      );
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

    validateTransition(currentStatus, newStatus as any);

    const { fee: refundFee, merchantShare: refundMerchantShare } = splitAmount(
      refundAmount,
      PLATFORM_FEE_PERCENT,
    );

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

    const reasonSuffix = params?.reason ? `: ${params.reason}` : "";
    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Refund ${toDisplayAmount(refundAmount)} for ${paymentId}${reasonSuffix}`,
      referenceType: "payment",
      referenceId: paymentId,
      entries: refundEntries,
    });

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

async function settle(
  db: Database,
  paymentId: string,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  const paramsHash = hashParams({});

  return await db.transaction(async (tx) => {
    const row = await findPaymentForUpdate(tx, paymentId);

    const claim = await claimIdempotency(
      tx,
      {
        key: idempotencyKey,
        resourceType: "payment.settle",
        resourceId: paymentId,
        paramsHash,
      },
      200,
    );

    if (!claim.won) {
      return toPaymentRecord(row);
    }

    validateTransition(row.status as any, "settled");

    const { merchantShare } = splitAmount(row.capturedAmount, PLATFORM_FEE_PERCENT);

    await ledgerService.postTransaction(tx as unknown as Database, {
      description: `Settle ${toDisplayAmount(merchantShare)} for ${paymentId}`,
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
