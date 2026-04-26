// Reproduces the failing perf test's measurement N times to characterize the
// noise distribution. Not source — design-mode scratch.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
process.env.DATABASE_SSL = "false";

import { paymentService } from "../../src/payments/service";
import { setupTestDB, cleanBetweenTests, teardownTestDB } from "../../tests/helpers/setup";
import { uniqueKey } from "../../tests/helpers/factories";
import type { Database } from "../../src/shared/db";

const RUNS = 20;

async function measureOnce(typedDb: Database) {
  const s0 = performance.now();
  await paymentService.authorize(typedDb, { amount: 10_000n, currency: "USD" }, uniqueKey());
  const single = performance.now() - s0;
  await cleanBetweenTests();

  const c0 = performance.now();
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(
      paymentService.authorize(typedDb, { amount: BigInt(10_000 + i * 100), currency: "USD" }, uniqueKey()),
    );
  }
  await Promise.all(promises);
  const concurrent = performance.now() - c0;
  await cleanBetweenTests();

  return { single, concurrent, ratio: concurrent / single };
}

async function main() {
  const db = await setupTestDB();
  const typedDb = db as unknown as Database;

  const results: { single: number; concurrent: number; ratio: number }[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await measureOnce(typedDb);
    results.push(r);
    console.log(`run ${String(i + 1).padStart(2)}: single=${r.single.toFixed(2)}ms  concurrent=${r.concurrent.toFixed(2)}ms  ratio=${r.ratio.toFixed(2)}x`);
  }

  await teardownTestDB();

  const stats = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / sorted.length;
    const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
    return {
      min: sorted[0]?.toFixed(2),
      p50: sorted[Math.floor(sorted.length / 2)]?.toFixed(2),
      p95: sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2),
      max: sorted[sorted.length - 1]?.toFixed(2),
      mean: mean.toFixed(2),
      stddev: Math.sqrt(variance).toFixed(2),
    };
  };

  const ratios = results.map((r) => r.ratio);
  console.log("\n--- DISTRIBUTION ---");
  console.log("single     ms:", stats(results.map((r) => r.single)));
  console.log("concurrent ms:", stats(results.map((r) => r.concurrent)));
  console.log("ratio       x:", stats(ratios));
  for (const t of [3, 4, 5, 6, 7, 8, 10]) {
    const fails = ratios.filter((r) => r >= t).length;
    console.log(`ratio >= ${t}x: ${fails}/${RUNS} (${(fails / RUNS * 100).toFixed(0)}%)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
