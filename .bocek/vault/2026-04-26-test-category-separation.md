---
type: decision
features: [testing, perf]
related: ["[[2026-04-26-vitest-migration]]"]
created: 2026-04-26
confidence: high
---

# Perf benchmarks live in a dedicated suite, not in the main test runner

## Decision

Performance and load tests are removed from the main test suite. They live in
a dedicated benchmark layer (initially `bench/` or `tests/bench/`) and run via
a separate command, not via the runner that executes correctness tests.

This means:

- `tests/performance/boundaries.test.ts` is deleted from the unit/integration
  test path.
- `tests/load/payment-throughput.test.ts` and
  `tests/load/concurrent-lifecycle.test.ts` are deleted from the same path.
- The replacement benchmark files use proper benchmark statistics (warmup,
  median-of-N, MAD or stddev) — single-sample threshold assertions are not
  permitted.
- The benchmark suite has its own command (`bun run bench` or
  `vitest bench`, depending on the runner decision in
  [[2026-04-26-vitest-migration]]).
- The benchmark suite does NOT gate the regular test pipeline. It runs on
  demand or in a stable CI environment with controlled hardware.

## Reasoning

Universal across every production-grade payment / financial-system OSS
project surveyed in this session — language-agnostic:

- **TigerBeetle (Zig)**: separate `test:unit`, `test:integration`,
  `vortex` (system tests with pluggable client drivers), and `fuzz` build
  steps. Plus the VOPR simulator for deterministic fault-injection. None of
  these mix with each other.
- **Hyperswitch (Rust)**: `cargo test` for correctness; `loadtest/`
  directory for performance; Newman/Rustman for E2E API tests. All separate.
- **Killbill (Java)**: TestNG/JUnit for unit; separate Maven modules for
  performance.
- **Saleor (Python)**: pytest with separate test categorization.
- **Vendure (TS/NestJS)**: separate suites for unit, e2e, plugin tests.

The empirical data from this session also forced the issue: the existing
`tests/performance/boundaries.test.ts` "10 concurrent authorizes complete in
< 5x single authorize time" failed **18 of 20 measured runs** at the 5x
threshold. Single-sample noise (stddev 22.83ms against mean 28.40ms = ~80%
relative noise) overwhelms any ratio assertion. The natural ratio is ~10x
(median 9.42x), which is correct domain behavior — DB-pool-bound concurrent
work cannot achieve <2x parallelism on a 10-connection pool. The test was
asking a question the engine cannot answer in the affirmative AND was using
single-sample-vs-single-sample as if it were stable.

Both problems vanish when:

1. Benchmarks use proper statistics (warmup + median-of-N + MAD).
2. Benchmarks are not gated by a tight pass/fail threshold; they're either
   compared to a stored baseline OR they report numbers that humans
   (or scheduled regression jobs) review.

Mixing perf assertions into the main test runner is the category error. It
turns a statistical question into a boolean, and a boolean is the wrong type
for a noisy continuous variable.

## Strongest rejected alternative

Keep perf assertions in the main test suite, but stabilize them with
warmup + median-of-N (the "B" option from the earlier discussion).

Why it lost:

- Even with median-of-10, the natural ratio sits at ~10x. The 5x threshold
  was never going to pass — the test was asserting a claim the engine
  doesn't deliver and shouldn't be expected to. Stabilizing the measurement
  exposes that the assertion is wrong; doesn't fix it.
- More fundamentally: pass/fail thresholds for perf are the wrong tool.
  Perf needs trend tracking (run-N vs run-N-1), not boolean gates. A
  test-runner-shaped tool isn't the right shape for trend tracking.
- Universal evidence: zero production-grade engines mix the two. Following
  the universal pattern is cheap.

## Failure mode

If the benchmark suite is split off but never actually run, perf
regressions go unnoticed. Mitigation: schedule the benchmark suite to run
nightly OR on every PR-to-main merge OR on demand. Owner accountability for
running it.

If benchmarks are written without warmup, the JIT/connection-pool startup
cost is folded into the measurement and trends are dominated by cold-start
noise. Mitigation: explicit warmup configuration (handled by the
benchmark-tool decision in [[2026-04-26-vitest-migration]]).

## Revisit when

Never, probably. This is a universal-evidence decision. The only revisit
trigger is a fundamental shift in how OSS payment engines structure their
testing — not something likely in years.

## Implementation tasks

1. Delete `tests/performance/boundaries.test.ts` from the main suite.
2. Delete `tests/load/payment-throughput.test.ts` and
   `tests/load/concurrent-lifecycle.test.ts` from the main suite.
3. Create `bench/` (or `tests/bench/`) directory.
4. Rewrite the deleted assertions as proper benchmarks using the chosen tool
   (see [[2026-04-26-vitest-migration]]). Each benchmark records
   measurements; thresholds, if any, compare against a stored baseline JSON.
5. Add a `bench` script in `package.json` separate from `test`.
6. Document in `docs/14-development-flow.md` that perf assertions belong in
   `bench/`, not in `tests/`.
