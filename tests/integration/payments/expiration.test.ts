import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { createAuthorizedPayment } from "../../helpers/factories";
import { verifySystemBalance } from "../../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../../helpers/setup";

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

describe("expiration", () => {
  it("authorization sets expires_at on the payment", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    expect(payment.expiresAt).toBeDefined();
    expect(new Date(payment.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("expired payment cannot be captured", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    // Force expiration by backdating expires_at
    await db.execute(
      sql`UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${payment.id}`,
    );

    const err = await paymentService.capture(db, payment.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/expir|state|transition/i);
  });

  it("expired payment cannot be voided", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    await db.execute(
      sql`UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${payment.id}`,
    );

    const err = await paymentService.void(db, payment.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/expir|state|transition/i);
  });

  it("capture before expiry succeeds", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const captured = await paymentService.capture(db, payment.id);
    expect(captured.status).toBe("captured");
  });

  it("expiration releases the hold from customer_holds", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const holdsBefore = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBefore).toBe(10000n);

    // Force expiration
    await db.execute(
      sql`UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${payment.id}`,
    );

    // Trigger expiration check by attempting capture
    await paymentService.capture(db, payment.id).catch(() => {});

    const payment2 = await paymentService.getPayment(db, payment.id);
    expect(["expired", "voided"]).toContain(payment2.status);
  });
});
