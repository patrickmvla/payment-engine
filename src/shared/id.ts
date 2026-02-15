import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

type IdPrefix = "pay" | "txn" | "ent";

export const ID_PREFIXES = {
  PAYMENT: "pay" as const,
  TRANSACTION: "txn" as const,
  ENTRY: "ent" as const,
};

export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
