import { OpenAPIHono } from "@hono/zod-openapi";
import { ledgerRoutes } from "./ledger/routes";
import { setupOpenAPI } from "./openapi";
import { paymentRoutes } from "./payments/routes";
import { config } from "./shared/config";
import { closeDatabase, validateDatabase } from "./shared/db";
import { errorHandler } from "./shared/middleware/error-handler";
import { rateLimiter } from "./shared/middleware/rate-limit";
import { requestTracing, securityHeaders } from "./shared/middleware/security";
import { logger } from "./shared/logger";

const app = new OpenAPIHono();

// Middleware (order matters)
app.use("*", requestTracing);
app.use("*", securityHeaders);
app.use("/api/*", rateLimiter);

// Global error handler
app.onError(errorHandler);

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    version: config.APP_VERSION,
    environment: config.APP_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.route("/", paymentRoutes);
app.route("/", ledgerRoutes);

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

if (import.meta.main) {
  start().catch((err) => {
    logger.fatal(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to start server",
    );
    process.exit(1);
  });
}

export default app;
export { app };
export type AppType = typeof app;
