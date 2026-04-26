/**
 * E2E test setup — starts a real HTTP server and provides helpers.
 *
 * Overrides DATABASE_URL to the test database before loading the app
 * module, so the app's connection pool points at the test DB.
 */

// Must set env BEFORE any src/ imports trigger config/db module loading
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is required to run E2E tests");
}
process.env.DATABASE_URL = testUrl;
// Supabase requires SSL
if (testUrl.includes("supabase")) {
  process.env.DATABASE_SSL = "true";
}

// Test layer uses @hono/node-server so Vitest workers (running under Node)
// can spin up the test server. Production code (src/server.ts) keeps
// Bun.serve. Hono's adapter-agnostic design makes this transparent — the
// same `app.fetch` is consumed by either adapter.
// Resolved per amendment to [[2026-04-26-vitest-migration]] (option B).
import { serve, type ServerType } from "@hono/node-server";
import {
  cleanBetweenTests,
  getTestSQL,
  setupTestDB,
  teardownTestDB,
} from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

export const TEST_PORT = 4567;
export const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ServerType | null = null;

export async function startTestServer() {
  const { app } = await import("../../src/server");

  server = serve({
    fetch: app.fetch,
    port: TEST_PORT,
  });
}

export async function stopTestServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve, reject) => {
    s.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Re-export helpers
export { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB, uniqueKey };
