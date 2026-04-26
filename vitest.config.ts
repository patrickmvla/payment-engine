// Load .env into process.env BEFORE the config evaluates, so the values
// propagate to vitest worker subprocesses. Without this, Bun's auto .env
// loading (which only applies to the parent script) doesn't reach the
// vitest workers spawned by `vitest run`.
import "dotenv/config";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Side-effect-loaded BEFORE each test file imports src/server, so the env
    // override (DATABASE_URL → TEST_DATABASE_URL) takes effect before
    // src/shared/config.ts evaluates. Same role this file played as a
    // side-effect import under bun:test.
    setupFiles: ["./tests/helpers/test-env.ts"],
    // Match prior `bun test --timeout 30000` baseline. Integration tests with
    // Postgres ops occasionally run >5s (Vitest's default), especially under
    // load-test files.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Per [[2026-04-26-vitest-migration]] failure-mode mitigation: start
    // with serial file execution to avoid Drizzle/postgres-js worker
    // isolation issues. Tune to true once parity is verified.
    fileParallelism: false,
    // Process isolation (forks) plays better with postgres-js's net-based
    // connection pool than worker-thread isolation.
    pool: "forks",
    // Restrict to tests/ to keep Vitest from picking up unrelated files
    // (e.g., scratch in .bocek/, dist artifacts, etc.).
    include: ["tests/**/*.test.ts"],
  },
});
