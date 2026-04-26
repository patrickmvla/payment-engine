import { afterAll, beforeAll, describe, expect, it , vi } from "vitest";
import { paymentService } from "../../src/payments/service";
import type { Database } from "../../src/shared/db";
import { uniqueKey } from "../helpers/factories";
import { verifySystemBalance } from "../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Reconciliation: Independent Witness
 *
 * Reconstructs payment financial state by reading ONLY the ledger
 * (ledger_transactions + ledger_entries). Compares the witness output
 * to paymentService.getPayment(). If they disagree, something is wrong.
 *
 * This is the independent auditor — it trusts nothing from the payments table.
 */

interface WitnessResult {
  authorizedAmount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
  settledAmount: bigint;
}

async function reconstructPaymentFromLedger(
  sql: ReturnType<typeof getTestSQL>,
  paymentId: string,
): Promise<WitnessResult> {
  // Read all ledger transactions and their entries for this payment
  const entries = await sql`
    SELECT
      lt.description,
      le.account_id,
      le.direction,
      le.amount::bigint AS amount
    FROM ledger_transactions lt
    JOIN ledger_entries le ON le.transaction_id = lt.id
    WHERE lt.reference_type = 'payment' AND lt.reference_id = ${paymentId}
    ORDER BY lt.created_at ASC, le.id ASC
  `;

  let authorizedAmount = 0n;
  let capturedAmount = 0n;
  let refundedAmount = 0n;
  let settledAmount = 0n;

  for (const entry of entries) {
    const amount = BigInt(entry.amount);
    const desc = (entry.description as string).toLowerCase();
    const accountId = entry.account_id as string;
    const direction = entry.direction as string;

    if (desc.includes("authorize")) {
      // DEBIT customer_holds → authorization amount
      if (accountId === "customer_holds" && direction === "DEBIT") {
        authorizedAmount += amount;
      }
    } else if (desc.includes("capture")) {
      // CREDIT merchant_payable → captured merchant share
      // CREDIT platform_fees → captured fee
      // Together they equal the captured amount
      if (accountId === "merchant_payable" && direction === "CREDIT") {
        capturedAmount += amount;
      } else if (accountId === "platform_fees" && direction === "CREDIT") {
        capturedAmount += amount;
      }
    } else if (desc.includes("settle")) {
      // DEBIT merchant_payable in a "settle" description
      if (accountId === "merchant_payable" && direction === "DEBIT") {
        settledAmount += amount;
      }
    } else if (desc.includes("refund")) {
      // CREDIT customer_funds → refund amount
      if (accountId === "customer_funds" && direction === "CREDIT") {
        refundedAmount += amount;
      }
    }
    // void/expire entries reverse the hold — don't count as new amounts
  }

  return { authorizedAmount, capturedAmount, refundedAmount, settledAmount };
}

let db: Awaited<ReturnType<typeof setupTestDB>>;
let sql: ReturnType<typeof getTestSQL>;

beforeAll(async () => {
  db = await setupTestDB();
  sql = getTestSQL();
});
afterAll(async () => {
  await cleanBetweenTests();
  await teardownTestDB();
});

describe("independent witness reconstruction", () => {
  it("reconstructs an authorized payment", async () => {
    const typedDb = db as unknown as Database;
    const payment = await paymentService.authorize(
      typedDb,
      { amount: 10_000n, currency: "USD" },
      uniqueKey(),
    );

    const witness = await reconstructPaymentFromLedger(sql, payment.id);
    expect(witness.authorizedAmount).toBe(payment.authorizedAmount);
    expect(witness.capturedAmount).toBe(0n);
    expect(witness.refundedAmount).toBe(0n);

    await cleanBetweenTests();
  });

  it("reconstructs a captured payment", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 20_000n, currency: "USD" },
      uniqueKey(),
    );
    const captured = await paymentService.capture(typedDb, auth.id, undefined, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, captured.id);
    expect(witness.authorizedAmount).toBe(captured.authorizedAmount);
    expect(witness.capturedAmount).toBe(captured.capturedAmount);
    expect(witness.refundedAmount).toBe(0n);

    await cleanBetweenTests();
  });

  it("reconstructs a partial-capture + partial-refund payment", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 50_000n, currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, auth.id, { amount: 30_000n }, uniqueKey());
    const refunded = await paymentService.refund(typedDb, auth.id, { amount: 10_000n }, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, auth.id);
    expect(witness.authorizedAmount).toBe(refunded.authorizedAmount);
    expect(witness.capturedAmount).toBe(refunded.capturedAmount);
    expect(witness.refundedAmount).toBe(refunded.refundedAmount);

    await verifySystemBalance(sql);
    await cleanBetweenTests();
  });

  it("reconstructs a voided payment (no capture/refund amounts)", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 15_000n, currency: "USD" },
      uniqueKey(),
    );
    await paymentService.void(typedDb, auth.id, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, auth.id);
    expect(witness.authorizedAmount).toBe(15_000n);
    expect(witness.capturedAmount).toBe(0n);
    expect(witness.refundedAmount).toBe(0n);
    expect(witness.settledAmount).toBe(0n);

    await cleanBetweenTests();
  });

  it("reconstructs a settled payment", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 40_000n, currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, auth.id, undefined, uniqueKey());
    const settled = await paymentService.settle(typedDb, auth.id, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, auth.id);
    expect(witness.authorizedAmount).toBe(settled.authorizedAmount);
    expect(witness.capturedAmount).toBe(settled.capturedAmount);

    // Settlement amount = merchant share (captured - fee)
    // fee = (40000 * 3) / 100 = 1200, merchantShare = 38800
    expect(witness.settledAmount).toBe(38_800n);

    await verifySystemBalance(sql);
    await cleanBetweenTests();
  });

  // Multi-capture per [[2026-04-26-multi-capture-model]]: confirm the
  // witness correctly sums merchant_payable + platform_fees CREDITs across
  // multiple capture transactions per payment. The witness iterates ALL
  // ledger transactions for a payment, so accumulation should work without
  // any code change — these tests prove it.
  it("reconstructs a payment with two partial captures totaling the auth amount", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 100_000n, currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, auth.id, { amount: 70_000n }, uniqueKey());
    const final = await paymentService.capture(typedDb, auth.id, { amount: 30_000n }, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, auth.id);
    expect(witness.authorizedAmount).toBe(100_000n);
    expect(witness.capturedAmount).toBe(100_000n);
    expect(witness.capturedAmount).toBe(final.capturedAmount);
    expect(witness.refundedAmount).toBe(0n);
    expect(witness.settledAmount).toBe(0n);

    await verifySystemBalance(sql);
    await cleanBetweenTests();
  });

  it("reconstructs a multi-capture + partial-refund payment", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 100_000n, currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, auth.id, { amount: 60_000n }, uniqueKey());
    await paymentService.capture(typedDb, auth.id, { amount: 40_000n }, uniqueKey());
    const refunded = await paymentService.refund(typedDb, auth.id, { amount: 25_000n }, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, auth.id);
    expect(witness.authorizedAmount).toBe(100_000n);
    expect(witness.capturedAmount).toBe(100_000n);
    expect(witness.capturedAmount).toBe(refunded.capturedAmount);
    expect(witness.refundedAmount).toBe(25_000n);
    expect(witness.refundedAmount).toBe(refunded.refundedAmount);

    await verifySystemBalance(sql);
    await cleanBetweenTests();
  });

  it("reconstructs a multi-capture then settled payment", async () => {
    const typedDb = db as unknown as Database;
    const auth = await paymentService.authorize(
      typedDb,
      { amount: 100_000n, currency: "USD" },
      uniqueKey(),
    );
    await paymentService.capture(typedDb, auth.id, { amount: 70_000n }, uniqueKey());
    await paymentService.capture(typedDb, auth.id, { amount: 30_000n }, uniqueKey());
    await paymentService.settle(typedDb, auth.id, uniqueKey());

    const witness = await reconstructPaymentFromLedger(sql, auth.id);
    expect(witness.authorizedAmount).toBe(100_000n);
    expect(witness.capturedAmount).toBe(100_000n);

    // Settlement amount = merchant share of total captured.
    // fee = (100000 * 3) / 100 = 3000; merchantShare = 97000.
    expect(witness.settledAmount).toBe(97_000n);

    await verifySystemBalance(sql);
    await cleanBetweenTests();
  });
});
