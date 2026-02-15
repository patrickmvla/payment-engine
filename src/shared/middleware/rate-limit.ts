import type { MiddlewareHandler } from "hono";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 1000;

function getClientIp(c: Parameters<MiddlewareHandler>[0]): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

export const rateLimiter: MiddlewareHandler = async (c, next) => {
  const ip = getClientIp(c);
  const now = Date.now();

  let entry = store.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, entry);
  }

  entry.count++;

  const remaining = Math.max(0, MAX_REQUESTS - entry.count);
  const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

  c.header("RateLimit-Limit", String(MAX_REQUESTS));
  c.header("RateLimit-Remaining", String(remaining));
  c.header("RateLimit-Reset", String(resetSeconds));

  if (entry.count > MAX_REQUESTS) {
    c.header("Retry-After", String(resetSeconds));
    return c.json(
      {
        error: {
          type: "rate_limit_exceeded",
          message: `Rate limit exceeded. Retry after ${resetSeconds} seconds.`,
          retry_after: resetSeconds,
        },
      },
      429,
    );
  }

  await next();
};
