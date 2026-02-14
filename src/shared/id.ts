import { ulid } from "ulid";

type IdPrefix = "pay" | "txn" | "ent";

export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
