/**
 * Custom load testing harness.
 *
 * Combines throughput measurement with invariant verification.
 * After every load burst, the god check can run — the critical
 * difference from k6. High RPS is meaningless if the database
 * is inconsistent.
 */

export interface LoadResult {
  totalRequests: number;
  succeeded: number;
  failed: number;
  duration: number;
  rps: number;
  latencies: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
    min: number;
    avg: number;
  };
  errors: Map<string, number>;
}

export function computePercentiles(values: number[]): LoadResult["latencies"] {
  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;

  return {
    p50: sorted[Math.floor(len * 0.5)] ?? 0,
    p95: sorted[Math.floor(len * 0.95)] ?? 0,
    p99: sorted[Math.floor(len * 0.99)] ?? 0,
    max: sorted[len - 1] ?? 0,
    min: sorted[0] ?? 0,
    avg: len > 0 ? sorted.reduce((a, b) => a + b, 0) / len : 0,
  };
}

export async function runLoad(
  name: string,
  concurrency: number,
  totalRequests: number,
  operation: () => Promise<Response>,
): Promise<LoadResult> {
  const latencies: number[] = [];
  const errors = new Map<string, number>();
  let succeeded = 0;
  let failed = 0;

  const startTime = performance.now();

  // Execute in waves of `concurrency`
  for (let i = 0; i < totalRequests; i += concurrency) {
    const batchSize = Math.min(concurrency, totalRequests - i);
    const batch = Array.from({ length: batchSize }, async () => {
      const start = performance.now();
      try {
        const res = await operation();
        const elapsed = performance.now() - start;
        latencies.push(elapsed);

        if (res.ok) {
          succeeded++;
        } else {
          failed++;
          const key = `HTTP ${res.status}`;
          errors.set(key, (errors.get(key) ?? 0) + 1);
        }
      } catch (err) {
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        failed++;
        const key = err instanceof Error ? err.message : "unknown";
        errors.set(key, (errors.get(key) ?? 0) + 1);
      }
    });

    await Promise.allSettled(batch);
  }

  const duration = performance.now() - startTime;

  const result: LoadResult = {
    totalRequests,
    succeeded,
    failed,
    duration,
    rps: (totalRequests / duration) * 1000,
    latencies: computePercentiles(latencies),
    errors,
  };

  // Print report
  console.log(`\n--- Load Test: ${name}`);
  console.log(`   Requests:  ${result.totalRequests} (${result.succeeded} ok, ${result.failed} failed)`);
  console.log(`   Duration:  ${result.duration.toFixed(0)}ms`);
  console.log(`   RPS:       ${result.rps.toFixed(1)}`);
  console.log(
    `   Latency:   p50=${result.latencies.p50.toFixed(1)}ms p95=${result.latencies.p95.toFixed(1)}ms p99=${result.latencies.p99.toFixed(1)}ms`,
  );
  console.log(
    `   Range:     min=${result.latencies.min.toFixed(1)}ms max=${result.latencies.max.toFixed(1)}ms avg=${result.latencies.avg.toFixed(1)}ms`,
  );
  if (result.errors.size > 0) {
    console.log("   Errors:");
    for (const [key, count] of result.errors) {
      console.log(`     ${key}: ${count}`);
    }
  }

  return result;
}
