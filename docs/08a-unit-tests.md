# Unit Tests — Pure Logic, No Database

Unit tests run in under a millisecond each, require no database, and test pure
functions in complete isolation. If a unit test needs infrastructure, it is not
a unit test.

Five areas. Money first.

1. **Money operations** — IEEE 754 proof-by-failure, currency precision, BigInt arithmetic, division with remainder
2. **State machine** — Full 8×8 transition matrix, valid transition queries, error diagnostics
3. **Balance computation** — Correct math for every account type including equity
4. **Validation schemas** — Adversarial inputs, mass assignment protection, all schema variants
5. **ID generation** — Prefixed ULIDs, sortability, uniqueness guarantees

---

## 1. Money Operations

Every financial bug starts here. Floating-point arithmetic is not broken — it
is working exactly as IEEE 754 specifies. The problem is that IEEE 754 was not
designed for money. This section proves it, then proves BigInt fixes it.

```typescript
// tests/unit/money.test.ts
import { describe, it, expect } from "bun:test";
import {
  toMinorUnits,
  fromMinorUnits,
  addAmounts,
  subtractAmounts,
  divideAmount,
  isWithinSafeRange,
  CURRENCY_DECIMALS,
} from "../../src/shared/money";

// ─────────────────────────────────────────────────────────────
// 1a. IEEE 754 Proof-by-Failure
// Why we use BigInt. Not theory — demonstration.
// ─────────────────────────────────────────────────────────────

describe("IEEE 754 Proof-by-Failure", () => {
  it("0.1 + 0.2 !== 0.3 in floating point", () => {
    // The classic. Every developer hits this eventually.
    // In a payment engine, this is a reconciliation nightmare.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(0.1 + 0.2).toBe(0.30000000000000004);
  });

  it("cumulative drift over 1000 additions of $0.10", () => {
    // Simulate processing 1000 transactions of $0.10 each.
    // Floating point: you lose track of money.
    let floatTotal = 0;
    for (let i = 0; i < 1000; i++) {
      floatTotal += 0.1;
    }
    expect(floatTotal).not.toBe(100);

    // BigInt: exact.
    let bigintTotal = 0n;
    for (let i = 0; i < 1000; i++) {
      bigintTotal += 10n; // 10 cents
    }
    expect(bigintTotal).toBe(100_000n); // 100_000 milli-units or 10000 cents
  });

  it("catastrophic cancellation: 1000000.01 - 1000000.00", () => {
    // Subtracting nearly-equal large numbers amplifies error.
    // A $10K refund on a $10K.01 charge should leave $0.01.
    const result = 1000000.01 - 1000000.00;
    expect(result).not.toBe(0.01);
  });

  it("MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2 in Number", () => {
    // Beyond 2^53, JavaScript Numbers silently lose precision.
    // Two different amounts become indistinguishable.
    expect(Number.MAX_SAFE_INTEGER + 1).toBe(Number.MAX_SAFE_INTEGER + 2);

    // BigInt: no upper bound on precision.
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(max + 1n).not.toBe(max + 2n);
  });

  it("comparison failure from order-of-operations", () => {
    // (a + b) + c !== a + (b + c) in floating point.
    // Associativity is not guaranteed.
    const a = 0.1, b = 0.2, c = 0.3;
    const leftToRight = (a + b) + c;
    const rightToLeft = a + (b + c);
    expect(leftToRight).not.toBe(rightToLeft);
  });

  it("BigInt addition is exact where floating point fails", () => {
    // The same $0.10 + $0.20 = $0.30 — done in cents.
    const tenCents = 10n;
    const twentyCents = 20n;
    const thirtyCents = 30n;
    expect(tenCents + twentyCents).toBe(thirtyCents);
  });
});

// ─────────────────────────────────────────────────────────────
// 1b. Currency Precision
// Not all currencies have 2 decimal places.
// JPY has 0. BHD has 3. Getting this wrong means
// charging someone 100x or 0.001x the intended amount.
// ─────────────────────────────────────────────────────────────

describe("Currency Precision", () => {
  it("CURRENCY_DECIMALS contains standard currencies", () => {
    expect(CURRENCY_DECIMALS["USD"]).toBe(2);
    expect(CURRENCY_DECIMALS["EUR"]).toBe(2);
    expect(CURRENCY_DECIMALS["GBP"]).toBe(2);
    expect(CURRENCY_DECIMALS["JPY"]).toBe(0);
    expect(CURRENCY_DECIMALS["BHD"]).toBe(3);
  });

  it("toMinorUnits: USD $1.00 → 100", () => {
    expect(toMinorUnits(1.0, "USD")).toBe(100n);
  });

  it("toMinorUnits: USD $0.01 → 1 (minimum representable)", () => {
    expect(toMinorUnits(0.01, "USD")).toBe(1n);
  });

  it("toMinorUnits: JPY ¥500 → 500 (zero decimal currency)", () => {
    // JPY has no minor unit. ¥500 is 500, not 50000.
    expect(toMinorUnits(500, "JPY")).toBe(500n);
  });

  it("toMinorUnits: BHD 1.000 → 1000 (three decimal currency)", () => {
    // Bahraini Dinar uses 3 decimal places (fils).
    expect(toMinorUnits(1.0, "BHD")).toBe(1000n);
  });

  it("fromMinorUnits: USD 100 → $1.00", () => {
    expect(fromMinorUnits(100n, "USD")).toBe(1.0);
  });

  it("fromMinorUnits: JPY 500 → ¥500", () => {
    expect(fromMinorUnits(500n, "JPY")).toBe(500);
  });

  it("fromMinorUnits: BHD 1000 → 1.000", () => {
    expect(fromMinorUnits(1000n, "BHD")).toBe(1.0);
  });

  it("round-trip: toMinorUnits → fromMinorUnits preserves value", () => {
    const original = 49.99;
    const minor = toMinorUnits(original, "USD");
    const restored = fromMinorUnits(minor, "USD");
    expect(restored).toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────
// 1c. BigInt Arithmetic
// The actual math primitives the ledger uses.
// ─────────────────────────────────────────────────────────────

describe("BigInt Arithmetic", () => {
  it("addAmounts computes correct sum", () => {
    expect(addAmounts(10000n, 5000n)).toBe(15000n);
  });

  it("subtractAmounts computes correct difference", () => {
    expect(subtractAmounts(10000n, 3000n)).toBe(7000n);
  });

  it("addition is commutative", () => {
    expect(addAmounts(7000n, 3000n)).toBe(addAmounts(3000n, 7000n));
  });

  it("addition identity: x + 0 = x", () => {
    expect(addAmounts(42000n, 0n)).toBe(42000n);
  });

  it("subtraction to zero: x - x = 0", () => {
    expect(subtractAmounts(10000n, 10000n)).toBe(0n);
  });

  it("100,000 additions produce exact result", () => {
    let total = 0n;
    for (let i = 0; i < 100_000; i++) {
      total = addAmounts(total, 1n);
    }
    expect(total).toBe(100_000n);
  });

  it("operates correctly beyond MAX_SAFE_INTEGER", () => {
    const big1 = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const big2 = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const sum = addAmounts(big1, big2);
    expect(sum).toBe(big1 + big2);
    expect(sum).toBe(18014398509481986n);
  });

  it("isWithinSafeRange detects boundary correctly", () => {
    expect(isWithinSafeRange(9007199254740991n)).toBe(true);  // MAX_SAFE_INTEGER
    expect(isWithinSafeRange(9007199254740992n)).toBe(false); // MAX_SAFE_INTEGER + 1
    expect(isWithinSafeRange(0n)).toBe(true);
    expect(isWithinSafeRange(-9007199254740991n)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 1d. Division with Remainder
// Money cannot have fractional cents. Division truncates.
// The conservation law guarantees no money is created or lost:
//   quotient × divisor + remainder === original
// ─────────────────────────────────────────────────────────────

describe("Division with Remainder", () => {
  it("divides evenly: 10000 ÷ 2 = 5000 remainder 0", () => {
    const result = divideAmount(10000n, 2n);
    expect(result.quotient).toBe(5000n);
    expect(result.remainder).toBe(0n);
  });

  it("uneven division: 10000 ÷ 3 = 3333 remainder 1", () => {
    const result = divideAmount(10000n, 3n);
    expect(result.quotient).toBe(3333n);
    expect(result.remainder).toBe(1n);
  });

  it("conservation law: quotient × divisor + remainder === original", () => {
    const amounts = [10000n, 7n, 1n, 99999n, 100001n];
    const divisors = [3n, 4n, 100n, 7n, 13n];

    for (let i = 0; i < amounts.length; i++) {
      const result = divideAmount(amounts[i], divisors[i]);
      expect(result.quotient * divisors[i] + result.remainder).toBe(amounts[i]);
    }
  });

  it("1 cent ÷ 100: quotient 0, remainder 1 (indivisible)", () => {
    const result = divideAmount(1n, 100n);
    expect(result.quotient).toBe(0n);
    expect(result.remainder).toBe(1n);
    // Nothing lost: 0 × 100 + 1 = 1
    expect(result.quotient * 100n + result.remainder).toBe(1n);
  });

  it("division by 1 is identity", () => {
    const result = divideAmount(7777n, 1n);
    expect(result.quotient).toBe(7777n);
    expect(result.remainder).toBe(0n);
  });

  it("division by zero throws", () => {
    expect(() => divideAmount(10000n, 0n)).toThrow();
  });

  it("large amount division preserves conservation", () => {
    const result = divideAmount(999_999_999_999n, 7n);
    expect(result.quotient * 7n + result.remainder).toBe(999_999_999_999n);
  });

  it("7 cents ÷ 4 = 1 remainder 3", () => {
    const result = divideAmount(7n, 4n);
    expect(result.quotient).toBe(1n);
    expect(result.remainder).toBe(3n);
    expect(result.quotient * 4n + result.remainder).toBe(7n);
  });
});
```

---

## 2. State Machine

The state machine is the control flow of the payment engine. A single invalid
transition means money moves when it should not. One 8×8 truth table.
No separate "valid transitions" and "invalid transitions" sections.

```typescript
// tests/unit/state-machine.test.ts
import { describe, it, expect } from "bun:test";
import {
  validateTransition,
  getValidTransitions,
  PaymentStatus,
  TERMINAL_STATES,
  InvalidStateTransitionError,
} from "../../src/payments/state-machine";

const STATES: PaymentStatus[] = [
  "created",
  "authorized",
  "captured",
  "settled",
  "voided",
  "expired",
  "refunded",
  "partially_refunded",
];

// ─────────────────────────────────────────────────────────────
// 2a. Full 8×8 Transition Matrix
// 12 valid cells, 52 invalid. Single source of truth.
// ─────────────────────────────────────────────────────────────

describe("State Machine — 8×8 Transition Matrix", () => {
  // true = valid transition. Everything else throws.
  const VALID: Record<PaymentStatus, Record<PaymentStatus, boolean>> = {
    created: {
      created: false,
      authorized: true,
      captured: false,
      settled: false,
      voided: false,
      expired: true,
      refunded: false,
      partially_refunded: false,
    },
    authorized: {
      created: false,
      authorized: false,
      captured: true,
      settled: false,
      voided: true,
      expired: true,
      refunded: false,
      partially_refunded: false,
    },
    captured: {
      created: false,
      authorized: false,
      captured: false,
      settled: true,
      voided: false,
      expired: false,
      refunded: true,
      partially_refunded: true,
    },
    settled: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: true,
      partially_refunded: true,
    },
    voided: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: false,
      partially_refunded: false,
    },
    expired: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: false,
      partially_refunded: false,
    },
    refunded: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: false,
      partially_refunded: false,
    },
    partially_refunded: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: true,
      partially_refunded: true,
    },
  };

  for (const from of STATES) {
    for (const to of STATES) {
      const expected = VALID[from][to];
      it(`${from} → ${to} is ${expected ? "VALID" : "INVALID"}`, () => {
        if (expected) {
          expect(() => validateTransition(from, to)).not.toThrow();
        } else {
          expect(() => validateTransition(from, to)).toThrow(
            InvalidStateTransitionError
          );
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// 2b. getValidTransitions — exact arrays per state
// ─────────────────────────────────────────────────────────────

describe("State Machine — getValidTransitions", () => {
  it("created → [authorized, expired]", () => {
    const valid = getValidTransitions("created");
    expect(valid).toContain("authorized");
    expect(valid).toContain("expired");
    expect(valid).toHaveLength(2);
  });

  it("authorized → [captured, voided, expired]", () => {
    const valid = getValidTransitions("authorized");
    expect(valid).toContain("captured");
    expect(valid).toContain("voided");
    expect(valid).toContain("expired");
    expect(valid).toHaveLength(3);
  });

  it("captured → [settled, refunded, partially_refunded]", () => {
    const valid = getValidTransitions("captured");
    expect(valid).toContain("settled");
    expect(valid).toContain("refunded");
    expect(valid).toContain("partially_refunded");
    expect(valid).toHaveLength(3);
  });

  it("settled → [refunded, partially_refunded]", () => {
    const valid = getValidTransitions("settled");
    expect(valid).toContain("refunded");
    expect(valid).toContain("partially_refunded");
    expect(valid).toHaveLength(2);
  });

  it("partially_refunded → [refunded, partially_refunded]", () => {
    const valid = getValidTransitions("partially_refunded");
    expect(valid).toContain("refunded");
    expect(valid).toContain("partially_refunded");
    expect(valid).toHaveLength(2);
  });

  it("voided → [] (terminal)", () => {
    expect(getValidTransitions("voided")).toEqual([]);
  });

  it("expired → [] (terminal)", () => {
    expect(getValidTransitions("expired")).toEqual([]);
  });

  it("refunded → [] (terminal)", () => {
    expect(getValidTransitions("refunded")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 2c. Terminal States Export
// ─────────────────────────────────────────────────────────────

describe("State Machine — Terminal States", () => {
  it("TERMINAL_STATES is exactly {voided, expired, refunded}", () => {
    const expected = new Set(["voided", "expired", "refunded"]);
    const actual = new Set(TERMINAL_STATES);
    expect(actual).toEqual(expected);
    expect(TERMINAL_STATES).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// 2d. Error Diagnostics
// In production, the error message in the logs determines
// whether an on-call engineer can diagnose the issue in
// 30 seconds or 30 minutes.
// ─────────────────────────────────────────────────────────────

describe("State Machine — Error Diagnostics", () => {
  it("InvalidStateTransitionError is an instance of Error", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("error carries .from property", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as InvalidStateTransitionError).from).toBe("created");
    }
  });

  it("error carries .to property", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as InvalidStateTransitionError).to).toBe("captured");
    }
  });

  it("error carries .allowedTransitions array", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      const allowed = (err as InvalidStateTransitionError).allowedTransitions;
      expect(Array.isArray(allowed)).toBe(true);
      expect(allowed).toContain("authorized");
      expect(allowed).toContain("expired");
    }
  });

  it("error .message is human-readable and includes context", () => {
    try {
      validateTransition("settled", "authorized");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as InvalidStateTransitionError).message;
      expect(msg).toContain("settled");
      expect(msg).toContain("authorized");
      expect(msg.length).toBeGreaterThan(10);
    }
  });
});
```

---

## 3. Balance Computation

Balances are derived from ledger entries, never stored. The computation depends
on account type per the accounting equation:

- **Asset** and **Expense**: `balance = SUM(debits) - SUM(credits)` (debit-normal)
- **Liability**, **Revenue**, and **Equity**: `balance = SUM(credits) - SUM(debits)` (credit-normal)

Getting the sign wrong inverts every balance in the system.

```typescript
// tests/unit/balance-computation.test.ts
import { describe, it, expect } from "bun:test";
import { computeBalance, AccountType } from "../../src/ledger/balance";

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
// Per the accounting equation: Assets = Liabilities + Equity.
// Equity is credit-normal, same as liability and revenue.
//
// NOTE: The current data model's CHECK constraint on account
// type excludes equity (only asset | liability | revenue |
// expense). The computation logic handles it correctly
// regardless — this tests that invariant so the constraint
// can be relaxed when equity accounts are added.
// ─────────────────────────────────────────────────────────────

describe("Balance — Equity (credit-normal)", () => {
  it("equity follows credit-normal convention", () => {
    const entries: LedgerEntry[] = [
      { direction: "CREDIT", amount: 50000n },
      { direction: "DEBIT", amount: 10000n },
    ];
    // If equity is supported, it behaves like liability/revenue.
    expect(computeBalance(entries, "equity" as AccountType)).toBe(40000n);
  });

  it("equity empty entries yield zero", () => {
    expect(computeBalance([], "equity" as AccountType)).toBe(0n);
  });
});
```

---

## 4. Validation Schemas

Validation is the first line of defense. If invalid data passes Zod schemas,
it can corrupt the ledger. These tests cover well-formed input, malformed input,
and adversarial input designed to exploit common web vulnerabilities.

```typescript
// tests/unit/validation.test.ts
import { describe, it, expect } from "bun:test";
import {
  AuthorizeSchema,
  CaptureSchema,
  RefundSchema,
} from "../../src/payments/schemas";

// ─────────────────────────────────────────────────────────────
// 4a. AuthorizeSchema — Valid Requests
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Valid Requests", () => {
  it("minimum valid request (amount + currency)", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1,
      currency: "USD",
    });
    expect(result.success).toBe(true);
  });

  it("all optional fields present", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 10000,
      currency: "USD",
      description: "Order #12345",
      metadata: { order_id: "ord_abc", customer_email: "user@example.com" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Order #12345");
      expect(result.data.metadata).toEqual({
        order_id: "ord_abc",
        customer_email: "user@example.com",
      });
    }
  });

  it("maximum valid amount", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 99999999,
      currency: "USD",
    });
    expect(result.success).toBe(true);
  });

  it("multiple valid currencies", () => {
    for (const currency of ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"]) {
      const result = AuthorizeSchema.safeParse({ amount: 1000, currency });
      expect(result.success).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4b. Invalid Amounts
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Invalid Amounts", () => {
  it("rejects zero amount", () => {
    expect(AuthorizeSchema.safeParse({ amount: 0, currency: "USD" }).success).toBe(false);
  });

  it("rejects negative amount", () => {
    expect(AuthorizeSchema.safeParse({ amount: -100, currency: "USD" }).success).toBe(false);
  });

  it("rejects float amount (no fractional cents)", () => {
    expect(AuthorizeSchema.safeParse({ amount: 10.5, currency: "USD" }).success).toBe(false);
  });

  it("rejects amount exceeding max", () => {
    expect(
      AuthorizeSchema.safeParse({ amount: 100_000_000_000, currency: "USD" }).success
    ).toBe(false);
  });

  it("rejects string amount", () => {
    expect(AuthorizeSchema.safeParse({ amount: "10000", currency: "USD" }).success).toBe(false);
  });

  it("rejects NaN", () => {
    expect(AuthorizeSchema.safeParse({ amount: NaN, currency: "USD" }).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(AuthorizeSchema.safeParse({ amount: Infinity, currency: "USD" }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4c. Invalid Currencies
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Invalid Currencies", () => {
  it("rejects lowercase", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "usd" }).success).toBe(false);
  });

  it("rejects wrong length (2 chars)", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "US" }).success).toBe(false);
  });

  it("rejects wrong length (4 chars)", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "USDD" }).success).toBe(false);
  });

  it("rejects numeric string", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "123" }).success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "" }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4d. Adversarial Inputs
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Adversarial Inputs", () => {
  it("rejects SQL injection in currency field", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "'; DROP TABLE payments;--",
      }).success
    ).toBe(false);
  });

  it("rejects __proto__ key in metadata", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      metadata: { __proto__: { admin: true } },
    });
    // Must either reject or strip the __proto__ key
    if (result.success) {
      expect((result.data.metadata as any).__proto__).toBeUndefined();
    }
  });

  it("rejects constructor pollution in metadata", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      metadata: { constructor: { prototype: { admin: true } } },
    });
    if (result.success) {
      expect((result.data.metadata as any).constructor).toBeUndefined();
    }
  });

  it("rejects metadata with more than 10 keys", () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 11; i++) {
      metadata[`key_${i}`] = `value_${i}`;
    }
    expect(
      AuthorizeSchema.safeParse({ amount: 1000, currency: "USD", metadata }).success
    ).toBe(false);
  });

  it("rejects nested objects in metadata", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "USD",
        metadata: { nested: { deep: "value" } },
      }).success
    ).toBe(false);
  });

  it("rejects array values in metadata", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "USD",
        metadata: { tags: ["a", "b"] },
      }).success
    ).toBe(false);
  });

  it("rejects Cyrillic confusable currency code", () => {
    // "USD" with Cyrillic "U" (U+0423) — visually identical, semantically wrong
    expect(
      AuthorizeSchema.safeParse({ amount: 1000, currency: "\u0423SD" }).success
    ).toBe(false);
  });

  it("rejects description exceeding 500 characters", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "USD",
        description: "x".repeat(501),
      }).success
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4e. Mass Assignment Protection
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Mass Assignment Protection", () => {
  it("strips status field", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      status: "captured",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).status).toBeUndefined();
    }
  });

  it("strips id field", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      id: "pay_malicious",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).id).toBeUndefined();
    }
  });

  it("strips refunded_amount field", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      refunded_amount: 9999,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).refunded_amount).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4f. CaptureSchema
// ─────────────────────────────────────────────────────────────

describe("CaptureSchema", () => {
  it("accepts empty body (full capture)", () => {
    const result = CaptureSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts partial capture amount", () => {
    const result = CaptureSchema.safeParse({ amount: 5000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(5000);
    }
  });

  it("rejects zero capture amount", () => {
    expect(CaptureSchema.safeParse({ amount: 0 }).success).toBe(false);
  });

  it("rejects negative capture amount", () => {
    expect(CaptureSchema.safeParse({ amount: -100 }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4g. RefundSchema
// ─────────────────────────────────────────────────────────────

describe("RefundSchema", () => {
  it("accepts empty body (full refund)", () => {
    const result = RefundSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts partial refund amount", () => {
    const result = RefundSchema.safeParse({ amount: 3000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(3000);
    }
  });

  it("accepts refund with reason", () => {
    const result = RefundSchema.safeParse({
      amount: 3000,
      reason: "Customer returned item",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("Customer returned item");
    }
  });

  it("rejects reason exceeding 500 characters", () => {
    expect(
      RefundSchema.safeParse({ amount: 3000, reason: "x".repeat(501) }).success
    ).toBe(false);
  });
});
```

---

## 5. ID Generation

Every resource in the system gets a prefixed ULID. The prefix makes IDs
human-readable in logs (`pay_`, `txn_`, `ent_`). The ULID provides
time-sortability and uniqueness without coordination.

```typescript
// tests/unit/id-generation.test.ts
import { describe, it, expect } from "bun:test";
import { generateId, ID_PREFIXES } from "../../src/shared/id-generation";

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
    // Crockford Base32: 0-9, A-H, J-N, P-T, V-Z (excludes I, L, O, U)
    expect(ulidPart).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("full ID matches prefix_ulid pattern", () => {
    const id = generateId(ID_PREFIXES.PAYMENT);
    expect(id).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

// ─────────────────────────────────────────────────────────────
// 5c. Sortability
// ULIDs encode a timestamp in the first 10 characters.
// Later IDs sort lexicographically after earlier ones.
// ─────────────────────────────────────────────────────────────

describe("ID Generation — Sortability", () => {
  it("later ID sorts after earlier ID", async () => {
    const first = generateId(ID_PREFIXES.PAYMENT);
    // Small delay to ensure different timestamp component
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
    // 1500 IDs, all unique (different prefixes guarantee no collision,
    // but the ULID portion should also be unique)
    expect(ids.size).toBe(1500);
  });
});
```

---

## Running

```bash
bun test tests/unit/

# Individual files
bun test tests/unit/money.test.ts
bun test tests/unit/state-machine.test.ts
bun test tests/unit/balance-computation.test.ts
bun test tests/unit/validation.test.ts
bun test tests/unit/id-generation.test.ts
```

All unit tests complete in under 1 second. If they take longer, something is
wrong — either a test has a side effect, or it is not a unit test.

---

Previous: [08 — Testing Strategy](./08-testing-strategy.md) | Next: [08b — Integration Tests](./08b-integration-tests.md)
