import type { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono) {
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Payment Engine API",
      version: "1.0.0",
      description:
        "A production-grade payment processing engine with double-entry bookkeeping, " +
        "idempotent operations, and full audit trail. Built to demonstrate how real " +
        "payment processors work internally.",
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Local development",
      },
    ],
  });

  app.get(
    "/docs",
    Scalar({
      url: "/openapi.json",
    }),
  );
}
