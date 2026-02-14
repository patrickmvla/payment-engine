# CI/CD — The Gate Between Code and Production

A payment engine that deploys without automated proof of correctness is a
payment engine waiting to lose money. This document defines the CI/CD pipeline
— what runs, in what order, what blocks deployment, and what happens when
something fails.

The pipeline has one job: make it impossible to ship code that breaks financial
invariants. If `SUM(debits) !== SUM(credits)` in any test, the deploy does not
happen. Full stop.

---

## 1. Pipeline Philosophy

Three rules govern every decision in this pipeline:

**1. The god check gates deployment.** Every test suite that touches the
database runs the god check afterward. If any single test creates or destroys
money, the entire pipeline fails. This is not a metric. It's a hard gate.

**2. Tests run in dependency order.** Unit tests run first (fastest, no
database). If they fail, nothing else runs. Integration tests run second.
E2E and advanced tests run last. Fail fast, fail cheap.

**3. Production deploys only from `main`.** Pull requests run the full test
suite but never deploy. The `main` branch runs the same tests, and if they
pass, deploys to Fly.io. No manual deployment steps. No "I'll deploy it
later."

---

## 2. Pipeline Architecture

```
                    Push to PR branch
                          │
                          ▼
                 ┌─────────────────┐
                 │    Lint Check    │  ← Biome: formatting + lint
                 └────────┬────────┘
                          │ pass
                          ▼
                 ┌─────────────────┐
                 │   Unit Tests    │  ← No database. Pure logic.
                 │   (~165 tests)  │     State machine, validation,
                 └────────┬────────┘     money math, ID generation.
                          │ pass
                          ▼
           ┌──────────────────────────────┐
           │      Integration Tests       │  ← Real Postgres.
           │  Ledger + Payments + Queries │     Service layer + database.
           │  Concurrency + Idempotency   │     God check after every suite.
           │  Invariants + God Check      │
           │       (~135 tests)           │
           └──────────────┬───────────────┘
                          │ pass
                          ▼
           ┌──────────────────────────────┐
           │        E2E + Advanced        │  ← Full HTTP (Hono RPC).
           │  Happy paths, error shapes   │     Load, property-based,
           │  Load, property, fuzz        │     reconciliation, witness.
           │  Reconciliation, witness     │     God check after load.
           │       (~120 tests)           │
           └──────────────┬───────────────┘
                          │ pass
                          ▼
              ┌────────────────────────┐
              │   All 420+ tests pass  │
              └────────┬───────────────┘
                       │
            ┌──────────┴──────────┐
            │                     │
      PR branch                main branch
            │                     │
            ▼                     ▼
    ✓ Green check on PR    ┌──────────────┐
      (no deploy)          │   Deploy to   │
                           │   Fly.io      │
                           └──────┬───────┘
                                  │
                           ┌──────┴───────┐
                           │  release_cmd │
                           │  db:migrate  │
                           └──────┬───────┘
                                  │
                           ┌──────┴───────┐
                           │ Health check │
                           │ GET /health  │
                           └──────┬───────┘
                                  │
                              ✓ Live
```

---

## 3. Workflow Files

Two workflow files. One for testing (runs on all branches), one for deployment
(runs only on `main` after tests pass).

### File structure

```
.github/
└── workflows/
    ├── test.yml       # Lint + full test suite
    └── deploy.yml     # Deploy to Fly.io (main only)
```

---

## 4. The Test Workflow

This is the primary workflow. It runs on every push and every pull request.

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile

      - name: Biome check
        run: bun run biome check .

  unit:
    name: Unit Tests
    needs: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile

      - name: Unit tests
        run: bun test --bail tests/unit/

  integration:
    name: Integration Tests
    needs: unit
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: payment_engine_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test
      TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile

      - name: Run migrations
        run: bun run db:migrate

      - name: Seed system accounts
        run: bun run db:seed

      - name: Integration tests (--bail stops on first failure)
        run: bun test --bail tests/integration/

  advanced:
    name: E2E + Advanced Tests
    needs: integration
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: payment_engine_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test
      TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile

      - name: Run migrations
        run: bun run db:migrate

      - name: Seed system accounts
        run: bun run db:seed

      - name: E2E tests
        run: bun test --bail tests/e2e/

      - name: Load tests
        run: bun test --bail tests/load/

      - name: Property-based tests
        run: bun test --bail tests/property/

      - name: Reconciliation tests
        run: bun test --bail tests/reconciliation/

      - name: Fuzz tests
        run: bun test --bail tests/fuzz/

      - name: Migration safety tests
        run: bun test --bail tests/migration/

      - name: Performance boundary tests
        run: bun test --bail tests/performance/

      - name: Test isolation verification
        run: bun test --bail tests/meta/
```

### Why this structure

| Decision | Reasoning |
|---|---|
| `--bail` on every test step | Fail fast. If the ledger is broken, don't waste 5 minutes running E2E tests. |
| Sequential jobs (`needs:`) | Unit tests catch 80% of issues in 2 seconds. No point spinning up Postgres if pure logic is broken. |
| `concurrency: cancel-in-progress` | Pushing a fix while a PR check is running cancels the stale run. Saves minutes and runner capacity. |
| Separate Postgres service per job | Each job gets a clean database. No state leakage between integration and advanced tests. |
| `--frozen-lockfile` on `bun install` | CI must use the exact dependency versions from `bun.lock`. No surprise upgrades. |

---

## 5. The Deploy Workflow

Deploys only from `main`, only after the test workflow passes.

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  workflow_run:
    workflows: [Test]
    types: [completed]
    branches: [main]

jobs:
  deploy:
    name: Deploy to Fly.io
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Fly CLI
        uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Why `workflow_run` instead of a job in the test workflow

Separation of concerns. The test workflow answers "is this code correct?" The
deploy workflow answers "should this code go to production?" Different
questions, different triggers, different secrets.

`workflow_run` triggers the deploy workflow only when the test workflow
completes successfully on `main`. Pull request branches run all the tests but
never trigger a deploy — even if every test passes.

### What happens during `flyctl deploy`

1. Fly builds the Docker image (multi-stage, see [16 — Deployment](./16-deployment.md))
2. The `release_command` runs: `bun run db:migrate` against Supabase
3. If migration fails, the deploy is aborted — old version keeps running
4. If migration succeeds, the new machine starts
5. Fly hits `GET /health` — if it returns 200, traffic is routed
6. Old machine is drained and stopped (rolling deploy, zero downtime)

---

## 6. GitHub Secrets

Secrets are configured in the repository settings: **Settings → Secrets and
variables → Actions**.

| Secret | Value | Used By | How To Get It |
|---|---|---|---|
| `FLY_API_TOKEN` | Fly.io deploy token | `deploy.yml` | `fly tokens create deploy -x 999999h` |

### What is NOT a GitHub secret

| Variable | Where It Lives | Why |
|---|---|---|
| `DATABASE_URL` (CI) | Hardcoded in workflow (`localhost:5432`) | It's the local Postgres service container. Not a secret — it's `postgres:postgres@localhost`. |
| `DATABASE_URL` (production) | Fly.io secrets (`fly secrets set`) | Production credentials are between Fly and Supabase. GitHub never sees them. |
| `NODE_ENV`, `APP_ENV`, `LOG_LEVEL` | `fly.toml` `[env]` section | Configuration, not credentials. Committed to git. |

### The principle

GitHub Actions knows how to deploy to Fly. It does NOT know the production
database URL, the Supabase credentials, or any runtime secret. The deploy
token gives it permission to push a Docker image to Fly. Fly's own secret
management handles everything else.

This means: if someone compromises your GitHub repository, they can deploy
code to Fly (bad, but revocable), but they cannot read or exfiltrate
production database credentials (much worse, and not possible).

---

## 7. The God Check as a Deployment Gate

The god check — `SUM(debits) === SUM(credits)` across all ledger entries — is
not just a test. It's the invariant that proves the system doesn't lose money.

### Where it runs in CI

The god check runs in **every integration test suite** and **every load test**.
It's not a separate step — it's embedded in the tests themselves:

```
tests/integration/invariants/god-check.test.ts     ← Dedicated god check tests
tests/integration/payments/authorize.test.ts       ← God check after auth flows
tests/integration/payments/capture.test.ts         ← God check after capture flows
tests/integration/concurrency/double-capture.test.ts ← God check after races
tests/load/payment-throughput.test.ts              ← God check after load burst
tests/property/random-sequences.test.ts            ← God check after random ops
tests/reconciliation/end-of-day.test.ts            ← God check in reconciliation
```

If **any** of these fail, the `integration` or `advanced` job fails, the test
workflow fails, and the deploy workflow never triggers.

### The chain

```
God check fails
  → Test fails
    → Job fails
      → Workflow fails
        → workflow_run condition is 'failure'
          → Deploy workflow does NOT run
            → Production is safe
```

No manual intervention. No "let's skip this one." The math doesn't lie.

---

## 8. Postgres Service Container

Every job that touches the database gets a fresh Postgres instance. GitHub
Actions runs it as a Docker service container alongside the workflow.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: payment_engine_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 5s
      --health-timeout 5s
      --health-retries 5
```

### Why `postgres:16-alpine`

- Same major version as Supabase (Postgres 16)
- Alpine variant is smaller (faster pull in CI)
- `pg_isready` health check ensures Postgres is accepting connections before
  tests start

### Why a fresh instance per job

The `integration` and `advanced` jobs each get their own Postgres. This
guarantees:
- No state leakage between test phases
- Integration tests can't leave artifacts that confuse advanced tests
- If a test corrupts the database, only its job fails

### Connection string

```
postgres://postgres:postgres@localhost:5432/payment_engine_test
```

This is not a secret. It's a disposable database that exists for ~5 minutes
and contains only test data. It's hardcoded in the workflow for clarity.

---

## 9. Bun Setup and Dependency Caching

```yaml
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
```

### Why `--frozen-lockfile`

`bun install` without `--frozen-lockfile` can update `bun.lock` if a
dependency range resolves to a newer version. In CI, this is a bug waiting to
happen — tests could pass with dependency version X but fail with version Y,
and you'd never know which version ran.

`--frozen-lockfile` enforces: use the exact versions committed to the
repository. If the lockfile is out of date, the install fails instead of
silently upgrading.

### Caching

The `oven-sh/setup-bun@v2` action caches the Bun binary automatically. For
`node_modules` caching, Bun's install is fast enough (~2-4 seconds) that
explicit caching adds complexity without meaningful benefit. If install times
grow, add:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.bun/install/cache
    key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
    restore-keys: bun-${{ runner.os }}-
```

For now, we skip it. Premature optimization in CI is still premature
optimization.

---

## 10. Migration Safety in CI

Migrations run twice in every deploy: once in CI (against the test database),
once in production (via `release_command`).

### In CI (test workflow)

```yaml
- name: Run migrations
  run: bun run db:migrate
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5432/payment_engine_test
```

This proves the migration SQL is valid and applies cleanly to a fresh
database. If a migration has a syntax error, references a non-existent column,
or violates a constraint, it fails here — not in production.

### In production (deploy workflow)

The `release_command` in `fly.toml` runs before the new machine starts:

```toml
[deploy]
  release_command = "bun run db:migrate"
```

Fly runs this in a temporary VM with access to the production `DATABASE_URL`
(set via `fly secrets`). If the migration fails:
- The deploy is aborted
- The old version keeps running
- No traffic is disrupted

### What this guarantees

| Scenario | Where It's Caught |
|---|---|
| Syntax error in migration SQL | CI (test workflow) |
| Column type mismatch | CI (test workflow) |
| Constraint violation on existing data | Production `release_command` (aborts deploy) |
| Migration applies but breaks a query | CI (integration tests run after migration) |
| Migration is not idempotent | CI (migration safety tests in `tests/migration/`) |

---

## 11. Branch Protection Rules

Configure these in GitHub: **Settings → Branches → Add rule**.

### For the `main` branch

| Rule | Setting | Why |
|---|---|---|
| Require pull request before merging | Enabled | No direct pushes to main. Every change is reviewed. |
| Require status checks to pass | Enabled | The test workflow must pass before merge. |
| Required status checks | `lint`, `unit`, `integration`, `advanced` | All four jobs must be green. |
| Require branches to be up to date | Enabled | PR must be rebased on latest main. No stale merges. |
| Require conversation resolution | Enabled | All review comments must be resolved. |
| Include administrators | Enabled | The rules apply to everyone. No exceptions. |

### Why every job is a required check

If only the `advanced` job were required, someone could remove the `needs:
integration` dependency and the `advanced` job would run (and possibly pass)
without integration tests ever executing. Requiring all four jobs ensures the
full chain runs.

---

## 12. Concurrency Control

```yaml
concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true
```

### What this does

If you push commit A to a PR branch and then immediately push commit B:
1. The workflow for commit A is **cancelled**
2. The workflow for commit B starts fresh

Without this, both workflows run to completion. That's wasted runner time —
commit A's results are irrelevant once commit B exists.

### The group key

`test-${{ github.ref }}` groups by branch reference. This means:
- Pushes to the same PR branch cancel each other (good)
- Pushes to different PR branches run independently (good)
- Pushes to `main` cancel previous `main` runs (acceptable — the latest
  commit is what matters)

---

## 13. Test Execution Order

Tests run in dependency order. Each phase builds confidence for the next.

| Phase | Job | What Runs | Time | Fails If |
|---|---|---|---|---|
| 1 | `lint` | Biome check (format + lint) | ~5s | Code doesn't match style rules |
| 2 | `unit` | Pure logic tests (~165) | ~3s | State machine, validation, money math broken |
| 3 | `integration` | Service + Postgres (~135) | ~30s | Ledger, payments, concurrency, idempotency broken |
| 4 | `advanced` | E2E + load + property + fuzz (~120) | ~60s | API contract, performance, randomized invariants broken |

**Total pipeline time: ~2 minutes** (sequential). Each job spins up its own
runner, installs dependencies, and (for phases 3-4) starts Postgres. The
sequential dependency chain means a unit test failure aborts the pipeline in
under 10 seconds.

### Why not run everything in parallel?

We could run all jobs simultaneously. The pipeline would complete faster when
everything passes. But when something fails:
- You'd see integration test failures alongside unit test failures, making it
  unclear which layer is broken
- You'd burn runner minutes on E2E tests that are guaranteed to fail because
  the service layer is broken
- The failure signal is diluted instead of focused

Sequential execution with `--bail` gives the clearest failure signal in the
shortest time.

---

## 14. Failure Debugging

When a CI run fails, you need to figure out why without SSH access to the
runner.

### Reading the logs

GitHub Actions shows each step's output inline. Click the failed step to see
the exact test failure, including:
- Test name
- Expected vs actual values
- Stack trace with file and line numbers

### God check failures

A god check failure in CI produces output like:

```
SYSTEM BALANCE VIOLATION
  Total debits:  150000
  Total credits: 147000
  Difference:    3000
  Entry count:   42
  Txn count:     14

  This means money was created or destroyed.
  STOP EVERYTHING AND INVESTIGATE.
```

This tells you:
- 3000 units (= $30.00) are unaccounted for
- 42 entries across 14 transactions
- Something in the preceding tests created an unbalanced transaction

### Reproducing CI failures locally

CI uses the same commands as local development. If CI fails, reproduce it:

```bash
# Same Postgres version as CI
docker compose up -d

# Same database setup
DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate
DATABASE_URL=$TEST_DATABASE_URL bun run db:seed

# Same test command (with --bail, like CI)
bun test --bail tests/integration/

# Or run the exact failing test file
bun test tests/integration/payments/capture.test.ts
```

If it passes locally but fails in CI, the most common causes are:
1. **Timing-dependent tests** — concurrency tests that depend on machine speed
2. **State leakage** — a test relies on data from a previous test (fix: clean
   between tests)
3. **Dependency drift** — `bun.lock` is out of date (fix: `bun install` and
   commit the lockfile)

---

## 15. Status Badge

Add this to the README to show pipeline status at a glance.

```markdown
[![Test](https://github.com/[owner]/[repo]/actions/workflows/test.yml/badge.svg)](https://github.com/[owner]/[repo]/actions/workflows/test.yml)
```

This renders as a green "passing" or red "failing" badge. A CTO browsing the
repository sees immediately whether the code is in a working state.

---

## 16. What Runs Where — Summary

| Concern | Where | Trigger |
|---|---|---|
| Formatting + lint | `test.yml` → `lint` job | Every push, every PR |
| Unit tests (165) | `test.yml` → `unit` job | Every push, every PR |
| Integration tests (135) | `test.yml` → `integration` job | Every push, every PR |
| E2E + advanced tests (120) | `test.yml` → `advanced` job | Every push, every PR |
| God check | Embedded in integration + advanced | Every push, every PR |
| Deploy to Fly.io | `deploy.yml` | Only `main`, only after test passes |
| Migrations (CI) | `test.yml` → before integration tests | Every push, every PR |
| Migrations (production) | `release_command` via Fly | Every deploy |
| Seed (CI) | `test.yml` → before integration tests | Every push, every PR |
| Seed (production) | Manual (`fly ssh console`) | First deploy only |

---

## 17. What NOT to Do

| Mistake | Why | Do This Instead |
|---|---|---|
| Run `bun test` as a single step | One failure buries signal in 420 test results | Split into phases with `--bail` |
| Skip tests on "small changes" | The smallest change can break a financial invariant | All tests, every time |
| Store `DATABASE_URL` in GitHub secrets | CI doesn't need production credentials, and it shouldn't have them | Hardcode the local CI connection string |
| Use `bun install` without `--frozen-lockfile` | Dependency upgrades in CI cause phantom failures | `--frozen-lockfile` always |
| Deploy from PRs | Untested code reaches production if the PR check is slow | Deploy only from `main` via `workflow_run` |
| Cache `node_modules` aggressively | Stale cache masks dependency issues | Let Bun's fast install handle it |
| Retry flaky tests automatically | Flaky tests in a payment engine are bugs, not noise | Fix the flake, don't hide it |
| Run tests against Supabase in CI | Adds latency, costs money, pollutes production data | Always test against local Postgres |
| Skip the lint step | "It's just formatting" — until a linting error masks a real bug | Lint first, always |
| Add `[skip ci]` to commit messages | Bypasses the safety net. One skipped commit could break everything. | Never skip. The pipeline is fast enough. |

---

## 18. Cost

GitHub Actions is free for public repositories. For private repositories:

| Plan | Included Minutes/Month | Enough? |
|---|---|---|
| Free | 2,000 | Yes — each run is ~2 minutes, so ~1,000 runs/month |
| Team | 3,000 | More than enough |
| Enterprise | 50,000 | Way more than enough |

At ~2 minutes per pipeline run, even aggressive development (50 pushes/day)
uses ~100 minutes/day = ~3,000 minutes/month. The free tier covers normal
development. The Team plan covers heavy development.

The deploy workflow (Fly build + push) adds ~1-2 minutes per deploy. Since
deploys only happen on merge to `main`, this is a small fraction of total
usage.

---

## 19. When to Build This

Per [14 — Development Flow](./14-development-flow.md), CI/CD is set up in
**Phase 4** (API Layer), after all routes and tests exist.

```
Phase 1: Foundation       ← No CI yet (nothing to test)
Phase 2: Ledger Layer     ← Can add lint + unit test workflow
Phase 3: Payment Layer    ← Can add integration test job
Phase 4: API Layer        ← Full pipeline: lint + unit + integration + advanced + deploy
Phase 5: Advanced Testing ← Pipeline already running, just adding more tests
```

You can add the test workflow incrementally — start with lint + unit in Phase
2, add integration in Phase 3, add the full pipeline + deploy in Phase 4.
Each phase makes the pipeline stronger without requiring a rewrite.

---

Previous: [16 — Deployment](./16-deployment.md) | Next: [18 — Accounting Model](./18-accounting-model.md)
