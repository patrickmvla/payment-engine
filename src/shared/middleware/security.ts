import type { MiddlewareHandler } from "hono";
import { generateId } from "../id";

export const requestTracing: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header("X-Request-ID") || generateId("req" as any);
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-ID", requestId);
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
};
