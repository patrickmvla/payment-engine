/**
 * Imported FIRST by tests that statically import src/server.
 * Sets DATABASE_URL to the test database before the app's config/db
 * modules evaluate. Importing this file as a side effect is the only
 * reliable way to override env before a static `import { app }`.
 */

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is required to run tests against the app");
}
process.env.DATABASE_URL = testUrl;
if (testUrl.includes("supabase")) {
  process.env.DATABASE_SSL = "true";
} else {
  process.env.DATABASE_SSL = "false";
}
