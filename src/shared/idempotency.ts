import { eq } from "drizzle-orm";
import { idempotencyKeys } from "../payments/schema";
import type { Database } from "./db";
import { IdempotencyConflictError } from "./errors";

export type IdempotencyResourceType =
  | "payment.authorize"
  | "payment.capture"
  | "payment.void"
  | "payment.settle"
  | "payment.refund";

export interface IdempotencyContext {
  key: string;
  resourceType: IdempotencyResourceType;
  resourceId: string;
  paramsHash: string;
}

export type TxLike = Parameters<Parameters<Database["transaction"]>[0]>[0];

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function hashParams(params: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(params));
}

/**
 * Atomically claim an idempotency key. Uses INSERT ... ON CONFLICT DO NOTHING
 * to make the check-and-insert a single race-safe operation.
 *
 * Returns { won: true } when the caller is the first to claim the key — the
 * caller must perform the work and the key already records the metadata.
 *
 * Returns { won: false, resourceId } when another request already claimed the
 * key with matching context. The caller should re-read the resource and return
 * its current state.
 *
 * Throws IdempotencyConflictError when the key exists with different
 * resourceType, resourceId, or paramsHash.
 */
export async function claimIdempotency(
  tx: TxLike,
  ctx: IdempotencyContext,
  responseCode: number,
): Promise<{ won: true } | { won: false; resourceId: string }> {
  const claimed = await tx
    .insert(idempotencyKeys)
    .values({
      key: ctx.key,
      resourceType: ctx.resourceType,
      resourceId: ctx.resourceId,
      responseCode,
      responseBody: { params_hash: ctx.paramsHash },
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();

  if (claimed.length > 0) return { won: true };

  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, ctx.key));

  if (existing.length === 0) {
    throw new IdempotencyConflictError(ctx.key);
  }

  const row = existing[0]!;
  const stored = row.responseBody as { params_hash?: string } | null;

  if (
    row.resourceType !== ctx.resourceType ||
    row.resourceId !== ctx.resourceId ||
    stored?.params_hash !== ctx.paramsHash
  ) {
    throw new IdempotencyConflictError(ctx.key);
  }

  return { won: false, resourceId: row.resourceId };
}
