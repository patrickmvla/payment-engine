import { describe, expect, it } from "bun:test";
import { type AccountType, computeBalance } from "../../src/ledger/balance";

type LedgerEntry = {
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
};

// ─────────────────────────────────────────────────────────────
// 3a. Asset Accounts (debit-normal)
// ─────────────────────────────────────────────────────────────

describe("Balance — Asset (debit-normal)", () => {
  const type: AccountType = "asset";

  it("single debit increases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "DEBIT", amount: 10000n }];
    expect(computeBalance(entries, type)).toBe(10000n);
  });

  it("single credit decreases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "CREDIT", amount: 10000n }];
    expect(computeBalance(entries, type)).toBe(-10000n);
  });

  it("mixed entries net correctly", () => {
    const entries: LedgerEntry[] = [
      { direction: "DEBIT", amount: 10000n },
      { direction: "DEBIT", amount: 5000n },
      { direction: "CREDIT", amount: 3000n },
    ];
    expect(computeBalance(entries, type)).toBe(12000n);
  });

  it("equal debits and credits net to zero", () => {
    const entries: LedgerEntry[] = [
      { direction: "DEBIT", amount: 5000n },
      { direction: "CREDIT", amount: 5000n },
    ];
    expect(computeBalance(entries, type)).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────────
// 3b. Liability Accounts (credit-normal)
// ─────────────────────────────────────────────────────────────

describe("Balance — Liability (credit-normal)", () => {
  const type: AccountType = "liability";

  it("single credit increases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "CREDIT", amount: 10000n }];
    expect(computeBalance(entries, type)).toBe(10000n);
  });

  it("single debit decreases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "DEBIT", amount: 10000n }];
    expect(computeBalance(entries, type)).toBe(-10000n);
  });

  it("mixed entries net correctly", () => {
    const entries: LedgerEntry[] = [
      { direction: "CREDIT", amount: 20000n },
      { direction: "CREDIT", amount: 5000n },
      { direction: "DEBIT", amount: 8000n },
    ];
    expect(computeBalance(entries, type)).toBe(17000n);
  });
});

// ─────────────────────────────────────────────────────────────
// 3c. Revenue Accounts (credit-normal)
// ─────────────────────────────────────────────────────────────

describe("Balance — Revenue (credit-normal)", () => {
  const type: AccountType = "revenue";

  it("single credit increases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "CREDIT", amount: 3000n }];
    expect(computeBalance(entries, type)).toBe(3000n);
  });

  it("single debit decreases balance (fee reversal)", () => {
    const entries: LedgerEntry[] = [{ direction: "DEBIT", amount: 3000n }];
    expect(computeBalance(entries, type)).toBe(-3000n);
  });

  it("accumulated revenue with one reversal", () => {
    const entries: LedgerEntry[] = [
      { direction: "CREDIT", amount: 300n },
      { direction: "CREDIT", amount: 300n },
      { direction: "CREDIT", amount: 300n },
      { direction: "DEBIT", amount: 300n },
    ];
    expect(computeBalance(entries, type)).toBe(600n);
  });
});

// ─────────────────────────────────────────────────────────────
// 3d. Expense Accounts (debit-normal)
// ─────────────────────────────────────────────────────────────

describe("Balance — Expense (debit-normal)", () => {
  const type: AccountType = "expense";

  it("single debit increases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "DEBIT", amount: 500n }];
    expect(computeBalance(entries, type)).toBe(500n);
  });

  it("single credit decreases balance", () => {
    const entries: LedgerEntry[] = [{ direction: "CREDIT", amount: 500n }];
    expect(computeBalance(entries, type)).toBe(-500n);
  });

  it("expense tracking across operations", () => {
    const entries: LedgerEntry[] = [
      { direction: "DEBIT", amount: 1000n },
      { direction: "DEBIT", amount: 2000n },
      { direction: "CREDIT", amount: 500n },
    ];
    expect(computeBalance(entries, type)).toBe(2500n);
  });
});

// ─────────────────────────────────────────────────────────────
// 3e. Edge Cases
// ─────────────────────────────────────────────────────────────

describe("Balance — Edge Cases", () => {
  it("empty entries yield zero for all account types", () => {
    const types: AccountType[] = ["asset", "liability", "revenue", "expense"];
    for (const type of types) {
      expect(computeBalance([], type)).toBe(0n);
    }
  });

  it("handles very large amounts without overflow", () => {
    const entries: LedgerEntry[] = [
      { direction: "DEBIT", amount: 99_999_999_999_999n },
      { direction: "DEBIT", amount: 99_999_999_999_999n },
    ];
    expect(computeBalance(entries, "asset")).toBe(199_999_999_999_998n);
  });

  it("handles 10,000 entries correctly", () => {
    const entries: LedgerEntry[] = Array.from({ length: 10_000 }, () => ({
      direction: "DEBIT" as const,
      amount: 1n,
    }));
    expect(computeBalance(entries, "asset")).toBe(10_000n);
  });

  it("minimum representable amount (1 minor unit)", () => {
    const entries: LedgerEntry[] = [{ direction: "CREDIT", amount: 1n }];
    expect(computeBalance(entries, "liability")).toBe(1n);
  });

  it("unknown account type throws", () => {
    const entries: LedgerEntry[] = [{ direction: "DEBIT", amount: 100n }];
    expect(() => computeBalance(entries, "invalid" as AccountType)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// 3f. Equity Accounts
// ─────────────────────────────────────────────────────────────

describe("Balance — Equity (credit-normal)", () => {
  it("equity follows credit-normal convention", () => {
    const entries: LedgerEntry[] = [
      { direction: "CREDIT", amount: 50000n },
      { direction: "DEBIT", amount: 10000n },
    ];
    expect(computeBalance(entries, "equity" as AccountType)).toBe(40000n);
  });

  it("equity empty entries yield zero", () => {
    expect(computeBalance([], "equity" as AccountType)).toBe(0n);
  });
});
