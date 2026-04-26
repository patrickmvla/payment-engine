import { afterAll, afterEach, beforeAll, describe, expect, it , vi } from "vitest";
import { paymentService } from "../../src/payments/service";
import { AppError } from "../../src/shared/errors";
import type { Database } from "../../src/shared/db";
import { assertPaymentConsistency } from "../helpers/assertions";
import { verifyAllTransactionsBalance, verifySystemBalance } from "../helpers/god-check";
import { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB } from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Property-Based Random Sequence Tests
 *
 * Proves the system handles arbitrary operation sequences correctly.
 * Uses a SeededRNG (mulberry32) for deterministic, reproducible randomness.
 * Each seed generates a unique sequence of operations; if a seed fails,
 * it will always fail the same way — making debugging trivial.
 */

// --- SeededRNG (mulberry32) — intentionally inline, not extracted ---
class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]!;
  }
}

// --- Tracked payment mirrors in-memory state ---
interface TrackedPayment {
  id: string;
  status: string;
  amount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
}

type Operation = "authorize" | "capture" | "void" | "settle" | "refund";
const ALL_OPS: Operation[] = ["authorize", "capture", "void", "settle", "refund"];

async function executeRandomSequence(
  db: Database,
  seed: number,
  operationCount: number,
): Promise<void> {
  const rng = new SeededRNG(seed);
  const tracked: TrackedPayment[] = [];

  for (let i = 0; i < operationCount; i++) {
    const op = rng.pick(ALL_OPS);

    try {
      if (op === "authorize") {
        const amount = BigInt(rng.int(100, 100_000));
        const payment = await paymentService.authorize(
          db,
          { amount, currency: "USD" },
          uniqueKey(),
        );
        tracked.push({
          id: payment.id,
          status: payment.status,
          amount: payment.amount,
          capturedAmount: payment.capturedAmount,
          refundedAmount: payment.refundedAmount,
        });
      } else if (tracked.length === 0) {
        // No payments to act on — skip
        continue;
      } else {
        const target = rng.pick(tracked);

        if (op === "capture") {
          const captureAmount =
            rng.next() > 0.5 ? BigInt(rng.int(1, Number(target.amount))) : undefined;
          const result = await paymentService.capture(
            db,
            target.id,
            captureAmount ? { amount: captureAmount } : undefined,
            uniqueKey(),
          );
          target.status = result.status;
          target.capturedAmount = result.capturedAmount;
        } else if (op === "void") {
          const result = await paymentService.void(db, target.id, uniqueKey());
          target.status = result.status;
        } else if (op === "settle") {
          const result = await paymentService.settle(db, target.id, uniqueKey());
          target.status = result.status;
        } else if (op === "refund") {
          const remaining = target.capturedAmount - target.refundedAmount;
          const refundAmount =
            remaining > 0n && rng.next() > 0.5
              ? BigInt(rng.int(1, Number(remaining)))
              : undefined;
          const result = await paymentService.refund(
            db,
            target.id,
            refundAmount ? { amount: refundAmount } : undefined,
            uniqueKey(),
          );
          target.status = result.status;
          target.refundedAmount = result.refundedAmount;
        }
      }
    } catch (err) {
      // Expected failures: invalid state transitions, invalid amounts, etc.
      if (err instanceof AppError) continue;
      if (err instanceof Error && err.name === "InvalidStateTransitionError") continue;
      throw err;
    }
  }

  // After all operations, verify every tracked payment is consistent
  for (const t of tracked) {
    const payment = await paymentService.getPayment(db, t.id);
    assertPaymentConsistency(payment);
  }
}

// --- Test setup ---

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

// --- 50 deterministic seeds × 10 operations each ---

describe("random operation sequences", () => {
  for (let seed = 0; seed < 50; seed++) {
    it(`seed ${seed}`, async () => {
      await executeRandomSequence(db as unknown as Database, seed, 10);
    });
  }
});

// --- 1 long sequence: seed 999 × 100 operations ---

describe("long random sequence", () => {
  it("seed 999 with 100 operations", async () => {
    await executeRandomSequence(db as unknown as Database, 999, 100);
    await verifyAllTransactionsBalance(getTestSQL());
  });
});
