---
type: decision
features: [testing, build]
related: ["[[2026-04-26-test-category-separation]]"]
created: 2026-04-26
confidence: high
---

# Migrate test runner from bun:test to Vitest

## Decision

The 442-test correctness suite migrates from `bun:test` to **Vitest**. Bun
remains the production runtime — `Bun.serve`, `bun run`, the engine itself
all stay on Bun. Only the test runner changes.

Concrete migration scope:

- Replace `import { ... } from "bun:test"` with `import { ... } from "vitest"`
  across the 36 test files.
- Add `vitest` and a Vitest-compatible postgres / database setup adapter
  (`@databases/pg-test` or similar) to dev dependencies.
- Create `vitest.config.ts` with:
  - `test.environment: 'node'`
  - `test.setupFiles: ['./tests/helpers/test-env.ts']` (the env-override
    pattern from [[2026-04-26-test-category-separation]] still applies)
  - `test.globalSetup` for one-time DB migration if needed
  - `test.fileParallelism: false` if test isolation requires it (initial
    setting; tune later)
- Update `package.json` scripts:
  - `test` → `vitest run`
  - `test:watch` → `vitest`
  - `bench` → `vitest bench`
- Re-run the full suite; all 442 tests must pass at parity.
- Benchmarks (per [[2026-04-26-test-category-separation]]) use
  `vitest bench` natively — no separate library install.

Bun runtime stays in production: `bun run start`, `bun run dev`,
`bun run db:migrate`, etc. All `Bun.serve`, `Bun.file`, and other runtime
APIs untouched. The `src/` tree does not change.

## Reasoning

The TS/Node OSS payment + commerce ecosystem has consolidated on Vitest:

- **Vendure** (TS/NestJS): Vitest 3.2, exclusive.
- **PayloadCMS** (TS/Next): Vitest 4.1, exclusive.
- **Medusa** (JS/Node/Express): Jest 29 + Vitest 3, mid-migration toward
  Vitest in their monorepo.

Zero production-grade TS/Node payment-or-commerce engines surveyed use
`bun:test`. That's not a defect of `bun:test` — it's a maturity-and-adoption
gap. Vitest had a 4-year head start.

Aligning with where the ecosystem has landed buys:

- Plugin compatibility (mock libraries, snapshot tools, custom matchers,
  cloud test runners, IDE integrations are all built for Jest/Vitest API).
- Hiring/onboarding parity: TS engineers know Vitest. Onboarding into
  `bun:test` is a one-off for them.
- `vitest bench` built-in (resolves the benchmark-tool question without
  adding tinybench/mitata as a separate dependency).
- Better watch-mode performance reportedly (Jest-vs-Vitest data: 80ms
  hot reload vs 4s for Jest in 500+ test projects).

The empirical perf flake we measured this session does NOT support this
decision — the flake is a test-design bug that would manifest the same way
under any runner. The valid reason is ecosystem alignment, not the flake.

## Strongest rejected alternative

Keep `bun:test`, install tinybench (or mitata) for benchmarks.

Counter-argument considered:

- Zero migration cost — the 442 tests already work and caught real bugs in
  this session.
- Runtime/runner alignment with Bun.
- tinybench/mitata give the same statistics as `vitest bench` (vitest bench
  wraps tinybench internally — they're not statistically distinct).
- Smaller dependency surface.

Why it lost:

- Ecosystem alignment is a long-game payoff. Plugin/tooling/hiring
  divergence compounds. Migrating later under more pressure is more
  expensive than migrating now while the test count is bounded.
- The bench-included angle is a wash, but the rest of the Vitest ecosystem
  (mock libraries, fixtures, parallel test isolation primitives, snapshot
  serializers) is meaningfully richer.

## Failure mode

The migration breaks something in subtle ways:

1. **Drizzle / postgres-js compatibility under Vitest's worker model.**
   Vitest by default uses worker threads; `bun:test` uses a flatter model.
   If postgres-js or Drizzle has issues with worker isolation, tests may
   leak connections or hit unexpected errors. Mitigation: start with
   `fileParallelism: false`, validate, then re-enable.

2. **Async hooks behavior differences.** `bun:test`'s `beforeAll` /
   `afterEach` semantics may not perfectly match Vitest's. Mitigation:
   re-run the full suite after migration; any regressions surface
   immediately.

3. **Performance regression in test runtime.** `bun:test` boots faster
   than Vitest. Cold-run time may go up. Mitigation: this is the explicit
   trade-off we accepted; not a failure mode, a known cost.

4. **Migration introduces TS errors that don't show under bun:test.**
   Vitest uses `vite-node` (or similar) for TS compilation, which has
   slightly different module-resolution semantics than Bun's built-in TS.
   Mitigation: surface immediately at first run; fix per-file.

5. **The env-override pattern needs re-implementation.** `tests/helpers/test-env.ts` worked as a side-effect import in `bun:test`. Vitest's
   `setupFiles` runs before test files — same shape, different wiring.
   Mitigation: validate by checking `app`'s `db` connection logs point at
   the test DB after migration.

## Revisit when

- Vitest stops being the consolidated TS test runner (e.g., a new framework
  takes over). Unlikely in v1's lifetime.
- A Vitest defect specifically blocks our test patterns and isn't fixable
  with config or workaround. Then we evaluate whether to go back to
  `bun:test` or sideways to another runner.

## Amendment 2026-04-26 — test runtime gap resolution

A gap surfaced during implementation: `tests/e2e/setup.ts:35` called
`Bun.serve` to spin up the test HTTP server. Under Vitest's default Node
runtime, `Bun` is undefined → 4 e2e files / 19 tests skipped on first
run. The migration entry as originally written did not specify whether
Vitest workers run under Node or Bun.

**Resolution: Option B — refactor test layer to be runtime-agnostic.**

- Replace `Bun.serve` in `tests/e2e/setup.ts` with `serve()` from
  `@hono/node-server`. Hono is adapter-agnostic; the same `app` instance
  works with either adapter.
- Production code (`src/server.ts`) keeps `Bun.serve`. Bun remains the
  production runtime per the original decision.
- Vitest workers run under Node (the default). No `bun --bun` flag
  required.
- Add `@hono/node-server` to `devDependencies`.
- API change: `Bun.serve` returns an object with `.stop()`;
  `@hono/node-server`'s `serve()` returns a Node `http.Server` with
  `.close(callback)`. The teardown helper updates accordingly.

**Rejected alternative:** running Vitest under Bun via `bun --bun vitest run`.
Lower-effort but introduces vitest-on-Bun as an experimental dependency
(less battle-tested than vitest-on-Node).

**Defense quoted from owner directive:** "since we on hono for the server"
— hono is adapter-agnostic by design; using `@hono/node-server` for tests
while keeping `Bun.serve` for production is the canonical hono pattern.

## Implementation tasks

1. Add `vitest` to `devDependencies` (latest stable, currently 3.x).
2. Create `vitest.config.ts` with the test environment, setup files, and
   globalSetup configuration described above.
3. Mass-replace `from "bun:test"` with `from "vitest"` across the 36 test
   files (mechanical; APIs are >95% compatible — `describe`, `it`, `expect`,
   `beforeAll`, `afterAll`, `beforeEach`, `afterEach` all match).
4. Move `setDefaultTimeout(...)` calls to per-file or to vitest.config.ts.
5. Update `package.json` scripts: `test`, `test:watch`, `bench`.
6. Run the full suite. All 442 must pass. Triage anything that doesn't —
   most likely candidates are timeout differences, parallel-isolation
   issues, or async-hook timing.
7. Verify env override (DATABASE_URL → test DB) still works under
   Vitest's `setupFiles` pattern. Use the cause-logging diagnostic from
   debugging mode if anything is off.
8. Delete `bun:test` references from any docs (e.g., CLAUDE.md mentions
   `bun:test`).
9. Per [[2026-04-26-test-category-separation]]: write the new benchmark
   suite using `vitest bench`.
10. Run `bun test` ONCE more to confirm the old runner still works (it
    will — `bun:test` is shipped with Bun and remains available even
    unused). This is a sanity check, not a permanent dual-runner setup.
