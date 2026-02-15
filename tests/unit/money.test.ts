import { describe, expect, it } from "bun:test";
import {
  addAmounts,
  CURRENCY_DECIMALS,
  divideAmount,
  fromMinorUnits,
  isWithinSafeRange,
  subtractAmounts,
  toMinorUnits,
} from "../../src/shared/money";

// ─────────────────────────────────────────────────────────────
// 1a. IEEE 754 Proof-by-Failure
// Why we use BigInt. Not theory — demonstration.
// ─────────────────────────────────────────────────────────────

describe("IEEE 754 Proof-by-Failure", () => {
  it("0.1 + 0.2 !== 0.3 in floating point", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(0.1 + 0.2).toBe(0.30000000000000004);
  });

  it("cumulative drift over 1000 additions of $0.10", () => {
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
    expect(bigintTotal).toBe(10_000n);
  });

  it("catastrophic cancellation: 1000000.01 - 1000000.00", () => {
    const result = 1000000.01 - 1000000.0;
    expect(result).not.toBe(0.01);
  });

  it("MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2 in Number", () => {
    expect(Number.MAX_SAFE_INTEGER + 1).toBe(Number.MAX_SAFE_INTEGER + 2);

    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(max + 1n).not.toBe(max + 2n);
  });

  it("comparison failure from order-of-operations", () => {
    const a = 0.1,
      b = 0.2,
      c = 0.3;
    const leftToRight = a + b + c;
    const rightToLeft = a + (b + c);
    expect(leftToRight).not.toBe(rightToLeft);
  });

  it("BigInt addition is exact where floating point fails", () => {
    const tenCents = 10n;
    const twentyCents = 20n;
    const thirtyCents = 30n;
    expect(tenCents + twentyCents).toBe(thirtyCents);
  });
});

// ─────────────────────────────────────────────────────────────
// 1b. Currency Precision
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
    expect(toMinorUnits(500, "JPY")).toBe(500n);
  });

  it("toMinorUnits: BHD 1.000 → 1000 (three decimal currency)", () => {
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
    expect(sum).toBe(18014398509481985n);
  });

  it("isWithinSafeRange detects boundary correctly", () => {
    expect(isWithinSafeRange(9007199254740991n)).toBe(true); // MAX_SAFE_INTEGER
    expect(isWithinSafeRange(9007199254740992n)).toBe(false); // MAX_SAFE_INTEGER + 1
    expect(isWithinSafeRange(0n)).toBe(true);
    expect(isWithinSafeRange(-9007199254740991n)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 1d. Division with Remainder
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
      const result = divideAmount(amounts[i]!, divisors[i]!);
      expect(result.quotient * divisors[i]! + result.remainder).toBe(amounts[i]);
    }
  });

  it("1 cent ÷ 100: quotient 0, remainder 1 (indivisible)", () => {
    const result = divideAmount(1n, 100n);
    expect(result.quotient).toBe(0n);
    expect(result.remainder).toBe(1n);
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
