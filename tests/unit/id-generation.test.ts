import { describe, expect, it } from "bun:test";
import { generateId, ID_PREFIXES } from "../../src/shared/id";

// ─────────────────────────────────────────────────────────────
// 5a. Prefix
// ─────────────────────────────────────────────────────────────

describe("ID Generation — Prefix", () => {
  it("payment IDs start with pay_", () => {
    const id = generateId(ID_PREFIXES.PAYMENT);
    expect(id.startsWith("pay_")).toBe(true);
  });

  it("transaction IDs start with txn_", () => {
    const id = generateId(ID_PREFIXES.TRANSACTION);
    expect(id.startsWith("txn_")).toBe(true);
  });

  it("entry IDs start with ent_", () => {
    const id = generateId(ID_PREFIXES.ENTRY);
    expect(id.startsWith("ent_")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 5b. ULID Format
// ─────────────────────────────────────────────────────────────

describe("ID Generation — ULID Format", () => {
  it("ULID portion is 26 characters", () => {
    const id = generateId(ID_PREFIXES.PAYMENT);
    const ulidPart = id.slice(4); // after "pay_"
    expect(ulidPart).toHaveLength(26);
  });

  it("ULID uses Crockford Base32 charset", () => {
    const id = generateId(ID_PREFIXES.PAYMENT);
    const ulidPart = id.slice(4);
    expect(ulidPart).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("full ID matches prefix_ulid pattern", () => {
    const id = generateId(ID_PREFIXES.PAYMENT);
    expect(id).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

// ─────────────────────────────────────────────────────────────
// 5c. Sortability
// ─────────────────────────────────────────────────────────────

describe("ID Generation — Sortability", () => {
  it("later ID sorts after earlier ID", async () => {
    const first = generateId(ID_PREFIXES.PAYMENT);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = generateId(ID_PREFIXES.PAYMENT);
    expect(first < second).toBe(true);
  });

  it("100 sequential IDs maintain sort order", () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(generateId(ID_PREFIXES.PAYMENT));
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

// ─────────────────────────────────────────────────────────────
// 5d. Uniqueness
// ─────────────────────────────────────────────────────────────

describe("ID Generation — Uniqueness", () => {
  it("1000 rapid generations are all unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId(ID_PREFIXES.PAYMENT));
    }
    expect(ids.size).toBe(1000);
  });

  it("cross-generator IDs do not collide", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      ids.add(generateId(ID_PREFIXES.PAYMENT));
      ids.add(generateId(ID_PREFIXES.TRANSACTION));
      ids.add(generateId(ID_PREFIXES.ENTRY));
    }
    expect(ids.size).toBe(1500);
  });
});
