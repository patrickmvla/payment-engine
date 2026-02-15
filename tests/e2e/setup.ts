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

import {
  cleanBetweenTests,
  getTestSQL,
  setupTestDB,
  teardownTestDB,
} from "../helpers/setup";
import { uniqueKey } from "../helpers/factories";

export const TEST_PORT = 4567;
export const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve> | null = null;

export async function startTestServer() {
  const { default: app } = await import("../../src/server");

  server = Bun.serve({
    fetch: app.fetch,
    port: TEST_PORT,
    idleTimeout: 120,
  });
}

export async function stopTestServer() {
  if (server) {
    server.stop();
    server = null;
  }
}

// Re-export helpers
export { cleanBetweenTests, getTestSQL, setupTestDB, teardownTestDB, uniqueKey };
