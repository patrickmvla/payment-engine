import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for drizzle-kit");
}

const ssl = process.env.DATABASE_SSL === "true";

if (process.env.APP_ENV === "production") {
  const host = databaseUrl.split("@")[1] ?? "unknown";
  console.warn("PRODUCTION MIGRATION");
  console.warn(`Target: ${host}`);
  console.warn("Ensure you have reviewed the migration SQL.");
}

export default defineConfig({
  schema: "./src/**/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
    ssl,
  },
});
