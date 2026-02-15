import { ulid } from "ulid";
import { paymentService } from "../../src/payments/service";
import type { Database } from "../../src/shared/db";

export interface PaymentOverrides {
  amount?: bigint;
  currency?: string;
  description?: string;
  metadata?: Record<string, string>;
  authorizeAmount?: bigint;
}

/** Generate a unique idempotency key for test isolation. */
export function uniqueKey(): string {
  return `test_${ulid()}`;
}

export async function createAuthorizedPayment(db: Database, overrides: PaymentOverrides = {}) {
  const amount = overrides.amount ?? overrides.authorizeAmount ?? 10000n;
  return paymentService.authorize(
    db,
    {
      amount,
      currency: overrides.currency ?? "USD",
      description: overrides.description,
      metadata: overrides.metadata,
    },
    uniqueKey(),
  );
}

export async function createCapturedPayment(db: Database, overrides: PaymentOverrides = {}) {
  const amount = overrides.authorizeAmount ?? overrides.amount ?? 10000n;
  const auth = await createAuthorizedPayment(db, { ...overrides, amount });
  return paymentService.capture(db, auth.id, { amount });
}

export async function createVoidedPayment(db: Database, overrides: PaymentOverrides = {}) {
  const auth = await createAuthorizedPayment(db, overrides);
  return paymentService.void(db, auth.id);
}

export async function createSettledPayment(db: Database, overrides: PaymentOverrides = {}) {
  const captured = await createCapturedPayment(db, overrides);
  return paymentService.settle(db, captured.id);
}
