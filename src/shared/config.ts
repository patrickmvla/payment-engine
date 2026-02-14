import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_VERSION: z.string().default("1.0.0"),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  PLATFORM_FEE_PERCENT: z.coerce.number().int().min(0).max(100).default(3),
  AUTH_EXPIRY_DAYS: z.coerce.number().int().min(1).max(30).default(7),
});

export type Config = z.infer<typeof envSchema>;

export const config: Config = envSchema.parse(process.env);
