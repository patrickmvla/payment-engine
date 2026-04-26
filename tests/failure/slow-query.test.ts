import { afterAll, afterEach, beforeAll, describe, expect, it , vi } from "vitest";
import { paymentService } from "../../src/payments/service";
import type { Database } from "../../src/shared/db";
import { AppError } from "../../src/shared/errors";
import { createAuthorizedPayment , uniqueKey } from "../helpers/factories";
import { verifySystemBalance } from "../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Failure: Concurrent Operation Race
 *
 * Fires capture + void simultaneously on the same authorized payment.
 * Exactly one must succeed and the other must get InvalidStateTransitionError.
 * The god check must still pass — no money created or destroyed.
 */

let db: Awaited<ReturnType<typeof setupTestDB>>;

beforeAll(async () => {
  db = await setupTestDB();
});
afterAll(async () => {
  await teardownTestDB();
});
afterEach(async () => {
  await verifySystemBalance(getTestSQL());
  await cleanBetweenTests();
});

describe("concurrent capture + void race", () => {
  it("exactly one succeeds and the other fails with state transition error", async () => {
    const payment = await createAuthorizedPayment(db);

    const typedDb = db as unknown as Database;
    const [captureResult, voidResult] = await Promise.allSettled([
      paymentService.capture(typedDb, payment.id, undefined, uniqueKey()),
      paymentService.void(typedDb, payment.id, uniqueKey()),
    ]);

    // Exactly one should succeed
    const succeeded = [captureResult, voidResult].filter((r) => r.status === "fulfilled");
    const failed = [captureResult, voidResult].filter((r) => r.status === "rejected");

    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    // The failure should be a state transition error
    const rejection = failed[0] as PromiseRejectedResult;
    const err = rejection.reason;
    expect(
      (err instanceof AppError && err.type === "invalid_state_transition") ||
      (err instanceof Error && err.name === "InvalidStateTransitionError"),
    ).toBe(true);

    // The payment should be in exactly one terminal-ish state
    const final = await paymentService.getPayment(typedDb, payment.id);
    expect(["captured", "voided"]).toContain(final.status);
  });
});
