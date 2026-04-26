// Engine benchmarks — perf measurements for the payment engine, kept
// separate from the test suite per [[2026-04-26-test-category-separation]].
// Run with `bun run bench` (vitest bench). Reports p50, p95, mean, stddev,
// MAD per benchmark. No threshold gates — these are measurements, not
// pass/fail tests.
//
// Replaces:
// - tests/performance/boundaries.test.ts (service-layer perf)
// - tests/load/payment-throughput.test.ts (HTTP authorize throughput)
// - tests/load/concurrent-lifecycle.test.ts (HTTP full-lifecycle throughput)
//
// The deleted files asserted thresholds inline (e.g. "< 5x single
// authorize time"); per the test-category-separation decision, that
// pattern is wrong for noisy continuous variables. Vitest's bench
// reports statistics; humans (or scheduled regression jobs comparing
// against a stored baseline JSON) review trends.

// Side-effect import: env override BEFORE any src/ module evaluates.
import "../tests/helpers/test-env";

import { afterAll, bench, beforeAll, describe } from "vitest";
import { ledgerService } from "../src/ledger/service";
import { paymentService } from "../src/payments/service";
import type { Database } from "../src/shared/db";
import { uniqueKey } from "../tests/helpers/factories";
import { cleanBetweenTests, setupTestDB, teardownTestDB } from "../tests/helpers/setup";

let db: Awaited<ReturnType<typeof setupTestDB>>;
let typedDb: Database;

beforeAll(async () => {
  db = await setupTestDB();
  typedDb = db as unknown as Database;
});
afterAll(async () => {
  await teardownTestDB();
});

// ─────────────────────────────────────────────────────────────
// Service-layer benchmarks (formerly tests/performance/boundaries.test.ts)
// ─────────────────────────────────────────────────────────────

describe("authorize", () => {
  bench(
    "single authorize",
    async () => {
      await paymentService.authorize(
        typedDb,
        { amount: 10_000n, currency: "USD" },
        uniqueKey(),
      );
    },
    { iterations: 50, warmupIterations: 5 },
  );
});

describe("authorize + capture pair", () => {
  bench(
    "authorize then capture",
    async () => {
      const auth = await paymentService.authorize(
        typedDb,
        { amount: 10_000n, currency: "USD" },
        uniqueKey(),
      );
      await paymentService.capture(typedDb, auth.id, undefined, uniqueKey());
    },
    { iterations: 30, warmupIterations: 5 },
  );
});

describe("ledger queries", () => {
  bench(
    "getBalance for customer_funds",
    async () => {
      await ledgerService.getBalance(typedDb, "customer_funds");
    },
    { iterations: 100, warmupIterations: 10 },
  );

  bench(
    "listPayments limit=20",
    async () => {
      await paymentService.listPayments(typedDb, { limit: 20 });
    },
    { iterations: 50, warmupIterations: 5 },
  );
});

// ─────────────────────────────────────────────────────────────
// Concurrent-load benchmarks (formerly tests/load/*)
//
// Each iteration runs N concurrent operations; vitest reports per-batch
// statistics. To get per-operation latency, divide by N in interpretation.
// ─────────────────────────────────────────────────────────────

describe("concurrent authorize", () => {
  bench(
    "10 concurrent authorizes",
    async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          paymentService.authorize(
            typedDb,
            { amount: BigInt(10_000 + i * 100), currency: "USD" },
            uniqueKey(),
          ),
        ),
      );
    },
    { iterations: 20, warmupIterations: 3 },
  );

  bench(
    "100 concurrent authorizes (batch)",
    async () => {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          paymentService.authorize(
            typedDb,
            { amount: BigInt(10_000 + i), currency: "USD" },
            uniqueKey(),
          ),
        ),
      );
      await cleanBetweenTests();
    },
    { iterations: 5, warmupIterations: 1 },
  );
});

describe("full lifecycle throughput", () => {
  bench(
    "10 concurrent auth+capture+settle",
    async () => {
      const auths = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          paymentService.authorize(
            typedDb,
            { amount: BigInt(10_000 + i), currency: "USD" },
            uniqueKey(),
          ),
        ),
      );
      await Promise.all(
        auths.map((p) => paymentService.capture(typedDb, p.id, undefined, uniqueKey())),
      );
      await Promise.all(
        auths.map((p) => paymentService.settle(typedDb, p.id, uniqueKey())),
      );
    },
    { iterations: 10, warmupIterations: 2 },
  );
});
