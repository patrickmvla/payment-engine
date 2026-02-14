import type { drizzle } from "drizzle-orm/postgres-js";

type DB = ReturnType<typeof drizzle>;

/**
 * Test data factories. These call real service functions against real Postgres.
 * No mocks. Each factory creates a payment in the specified state by running
 * through the actual lifecycle operations.
 *
 * Stubs for Phase 1 — implemented in Phase 3 when payment service exists.
 */

export interface PaymentOverrides {
  amount?: bigint;
  currency?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export async function createAuthorizedPayment(_db: DB, _overrides: PaymentOverrides = {}) {
  // TODO: Phase 3 — calls paymentService.authorize()
  throw new Error("Not implemented until Phase 3");
}

export async function createCapturedPayment(_db: DB, _overrides: PaymentOverrides = {}) {
  // TODO: Phase 3 — calls authorize() then capture()
  throw new Error("Not implemented until Phase 3");
}

export async function createSettledPayment(_db: DB, _overrides: PaymentOverrides = {}) {
  // TODO: Phase 3 — calls authorize() then capture() then settle()
  throw new Error("Not implemented until Phase 3");
}
