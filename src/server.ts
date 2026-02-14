import { OpenAPIHono } from "@hono/zod-openapi";
import { setupOpenAPI } from "./openapi.ts";
import { config } from "./shared/config.ts";
import { closeDatabase, validateDatabase } from "./shared/db.ts";
import { AppError } from "./shared/errors.ts";
import { logger } from "./shared/logger.ts";

const app = new OpenAPIHono();

// Global error handler
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode as 400);
  }

  logger.error({ error: err.message, stack: err.stack }, "Unhandled error");
  return c.json(
    {
      error: {
        type: "internal_error",
        message: "An unexpected error occurred",
      },
    },
    500,
  );
});

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: config.APP_VERSION,
    environment: config.APP_ENV,
    timestamp: new Date().toISOString(),
  });
});

// OpenAPI + Scalar docs
setupOpenAPI(app);

// Startup
async function start() {
  await validateDatabase();

  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  });

  logger.info({ port: config.PORT, environment: config.APP_ENV }, "Payment Engine running");
  logger.info(`API docs available at http://localhost:${config.PORT}/docs`);

  // Graceful shutdown
  async function gracefulShutdown(signal: string) {
    logger.info({ signal }, "Shutdown signal received");
    server.stop();
    logger.info("Stopped accepting new connections");
    await closeDatabase();
    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

start().catch((err) => {
  logger.fatal(
    { error: err instanceof Error ? err.message : String(err) },
    "Failed to start server",
  );
  process.exit(1);
});

export default app;
