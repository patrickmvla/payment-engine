import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
import { verifyAllTransactionsBalance, verifySystemBalance } from "../../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../../helpers/setup";

let db: Awaited<ReturnType<typeof setupTestDB>>;

beforeAll(async () => {
  db = await setupTestDB();
});
afterAll(async () => {
  await teardownTestDB();
});
afterEach(async () => {
  await cleanBetweenTests();
});

describe("god check: system balance", () => {
  it("empty system balances to zero", async () => {
    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after a single authorization", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after authorization + full capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after authorization + void", async () => {
    await createVoidedPayment(db);

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after authorization + capture + full refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after authorization + capture + settlement", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.settle(db, captured.id);

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after authorization + capture + settlement + full refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.settle(db, captured.id);
    await paymentService.refund(db, captured.id, { amount: 10000n });

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after authorization + partial capture + partial refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n });
    await paymentService.refund(db, captured.id, { amount: 3000n });

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after 5 mixed payments in different flows", async () => {
    // 1. Full capture
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth1.id, { amount: 10000n });

    // 2. Void
    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });
    await paymentService.void(db, auth2.id);

    // 3. Partial capture + partial refund
    const auth3 = await createAuthorizedPayment(db, { amount: 30000n });
    const captured3 = await paymentService.capture(db, auth3.id, { amount: 20000n });
    await paymentService.refund(db, captured3.id, { amount: 5000n });

    // 4. Full capture + full refund
    const auth4 = await createAuthorizedPayment(db, { amount: 15000n });
    const captured4 = await paymentService.capture(db, auth4.id, { amount: 15000n });
    await paymentService.refund(db, captured4.id, { amount: 15000n });

    // 5. Auth only (still pending)
    await createAuthorizedPayment(db, { amount: 5000n });

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("after concurrent mixed operations across 10 payments", async () => {
    const payments = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 5000) }),
      ),
    );

    await Promise.allSettled(
      payments.map((p, i) =>
        i % 2 === 0
          ? paymentService.capture(db, p.id, { amount: p.amount })
          : paymentService.void(db, p.id),
      ),
    );

    await verifySystemBalance(getTestSQL());
    await verifyAllTransactionsBalance(getTestSQL());
  });

  it("every individual transaction is balanced", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 5000n });
    await createVoidedPayment(db);

    await verifyAllTransactionsBalance(getTestSQL());
  });
});
