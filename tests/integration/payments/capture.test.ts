import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { assertEntriesBalance } from "../../helpers/assertions";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
  uniqueKey,
} from "../../helpers/factories";
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

describe("capture", () => {
  it("transitions payment to captured status and clears expiresAt", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n }, uniqueKey());

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(10000n);
    expect(captured.expiresAt).toBeNull();
  });

  it("captures entire authorized amount when amount is omitted", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 25000n });
    const captured = await paymentService.capture(db, auth.id, undefined, uniqueKey());

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(25000n);
  });

  it("partial capture records the specified amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n }, uniqueKey());

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(7000n);
    expect(captured.authorizedAmount).toBe(10000n);
  });

  it("releases remaining hold after partial capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 7000n }, uniqueKey());

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(0n);
  });

  it("creates balanced ledger entries for the capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n }, uniqueKey());

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    expect(transactions.length).toBeGreaterThanOrEqual(2);

    for (const txn of transactions) {
      assertEntriesBalance(txn.entries);
    }
  });

  it("captures exact authorized amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n }, uniqueKey());

    expect(captured.capturedAmount).toBe(10000n);
    expect(captured.status).toBe("captured");
  });

  it("captures 1 cent", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 1n }, uniqueKey());

    expect(captured.capturedAmount).toBe(1n);
    expect(captured.status).toBe("captured");
  });

  it("capture ledger entries split fee correctly (3% to platform_fees)", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n }, uniqueKey());

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureTxn = transactions.find((t) => t.description.toLowerCase().includes("capture"));
    expect(captureTxn).toBeDefined();

    expect(captureTxn!.entries).toHaveLength(6);
    assertEntriesBalance(captureTxn!.entries);

    const merchantCredit = captureTxn!.entries.find(
      (e) => e.accountId === "merchant_payable" && e.direction === "CREDIT",
    );
    const feeCredit = captureTxn!.entries.find(
      (e) => e.accountId === "platform_fees" && e.direction === "CREDIT",
    );
    expect(merchantCredit!.amount).toBe(9700n);
    expect(feeCredit!.amount).toBe(300n);
  });

  it("zero-fee edge case: amount <= 33 cents skips fee entries", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 33n });
    await paymentService.capture(db, auth.id, { amount: 33n }, uniqueKey());

    const transactions = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureTxn = transactions.find((t) => t.description.toLowerCase().includes("capture"));
    expect(captureTxn).toBeDefined();

    expect(captureTxn!.entries).toHaveLength(4);
    assertEntriesBalance(captureTxn!.entries);

    const merchantCredit = captureTxn!.entries.find(
      (e) => e.accountId === "merchant_payable" && e.direction === "CREDIT",
    );
    expect(merchantCredit!.amount).toBe(33n);
  });

  it("rejects capture exceeding authorized amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.capture(db, auth.id, { amount: 10001n }, uniqueKey()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceed|authorized|amount/i);
  });

  it("rejects capture of zero amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.capture(db, auth.id, { amount: 0n }, uniqueKey()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/zero|amount|invalid/i);
  });

  it("rejects capturing a voided payment with InvalidStateTransitionError context", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.capture(db, voided.id, undefined, uniqueKey()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("rejects capturing a fully-captured payment", async () => {
    // Under multi-capture per [[2026-04-26-multi-capture-model]], capturing
    // again on a fully-captured payment is rejected because remaining
    // authorized = 0 (not because captured → captured is forbidden).
    const captured = await createCapturedPayment(db);

    const err = await paymentService.capture(db, captured.id, undefined, uniqueKey()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/zero|amount|remaining|exceed/i);
  });

  it("rejects capturing a non-existent payment", async () => {
    const err = await paymentService.capture(db, "pay_nonexistent_00000000", undefined, uniqueKey()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });
});

// Multi-capture model per [[2026-04-26-multi-capture-model]]: a single auth
// supports N partial captures accumulating until the auth is exhausted.
// Hold release fires once on the first capture; subsequent captures only
// post the customer→merchant + customer→fee transfers.
describe("capture — multi-capture model", () => {
  it("two partial captures accumulate to the auth amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });

    const first = await paymentService.capture(db, auth.id, { amount: 7_000n }, uniqueKey());
    expect(first.status).toBe("captured");
    expect(first.capturedAmount).toBe(7_000n);

    const second = await paymentService.capture(db, auth.id, { amount: 3_000n }, uniqueKey());
    expect(second.status).toBe("captured");
    expect(second.capturedAmount).toBe(10_000n);
  });

  it("sum of captures exceeding auth is rejected", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });

    await paymentService.capture(db, auth.id, { amount: 7_000n }, uniqueKey());

    const err = await paymentService
      .capture(db, auth.id, { amount: 4_000n }, uniqueKey())
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceed|remaining/i);
  });

  it("customer_holds is fully released on first capture and unchanged after second", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });
    const holdsBefore = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBefore).toBe(10_000n);

    await paymentService.capture(db, auth.id, { amount: 6_000n }, uniqueKey());
    const holdsAfterFirst = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsAfterFirst).toBe(0n);

    await paymentService.capture(db, auth.id, { amount: 4_000n }, uniqueKey());
    const holdsAfterSecond = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsAfterSecond).toBe(0n);
  });

  it("default amount on second capture defaults to remaining authorized", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });

    await paymentService.capture(db, auth.id, { amount: 4_000n }, uniqueKey());
    const second = await paymentService.capture(db, auth.id, undefined, uniqueKey());

    expect(second.capturedAmount).toBe(10_000n);
  });

  it("multi-capture then settle uses sum of captures as merchant share basis", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });

    await paymentService.capture(db, auth.id, { amount: 7_000n }, uniqueKey());
    await paymentService.capture(db, auth.id, { amount: 3_000n }, uniqueKey());

    const settled = await paymentService.settle(db, auth.id, uniqueKey());
    expect(settled.status).toBe("settled");
    expect(settled.capturedAmount).toBe(10_000n);

    // Settlement DEBITs merchant_payable for the merchant_share of the
    // total captured. Verify merchant_payable balance went to 0 after settle.
    const merchantPayable = await ledgerService.getBalance(db, "merchant_payable");
    expect(merchantPayable).toBe(0n);

    // platform_cash is an ASSET; settlement CREDITs it (outflow from
    // platform). Per docs/02:134, balance is negative until offset by
    // initial funding or accumulated fee revenue. Merchant share = 9700.
    const platformCash = await ledgerService.getBalance(db, "platform_cash");
    expect(platformCash).toBe(-9_700n);
  });

  it("each capture posts its own ledger transaction", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });

    await paymentService.capture(db, auth.id, { amount: 4_000n }, uniqueKey());
    await paymentService.capture(db, auth.id, { amount: 6_000n }, uniqueKey());

    const txns = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureTxns = txns.filter((t) => t.description.toLowerCase().includes("capture"));
    expect(captureTxns).toHaveLength(2);
  });

  it("first capture has 6 entries (hold release + charge), subsequent has 4 (charge only)", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10_000n });

    await paymentService.capture(db, auth.id, { amount: 5_000n }, uniqueKey());
    await paymentService.capture(db, auth.id, { amount: 5_000n }, uniqueKey());

    const txns = await ledgerService.getTransactionsByReference(db, "payment", auth.id);
    const captureTxns = txns
      .filter((t) => t.description.toLowerCase().includes("capture"))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // First capture: 2 hold-release + 2 merchant + 2 fee = 6 entries
    expect(captureTxns[0]!.entries).toHaveLength(6);
    // Second capture: 2 merchant + 2 fee = 4 entries (no hold release)
    expect(captureTxns[1]!.entries).toHaveLength(4);
    assertEntriesBalance(captureTxns[0]!.entries);
    assertEntriesBalance(captureTxns[1]!.entries);
  });
});
