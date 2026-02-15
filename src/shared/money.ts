/**
 * All money operations use BigInt. Zero floating point.
 * Amounts are always in the smallest currency unit (cents for USD).
 */

/** Standard currency decimal places. */
export const CURRENCY_DECIMALS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  JPY: 0,
  BHD: 3,
};

/** Convert a major-unit amount to minor units using currency decimals. */
export function toMinorUnits(amount: number, currency: string): bigint {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const multiplier = 10 ** decimals;
  return BigInt(Math.round(amount * multiplier));
}

/** Convert minor units back to a major-unit number. */
export function fromMinorUnits(amount: bigint, currency: string): number {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const divisor = 10 ** decimals;
  return Number(amount) / divisor;
}

/** Add two BigInt amounts. */
export function addAmounts(a: bigint, b: bigint): bigint {
  return a + b;
}

/** Subtract two BigInt amounts. */
export function subtractAmounts(a: bigint, b: bigint): bigint {
  return a - b;
}

/** Integer division with remainder. Conservation: quotient * divisor + remainder === original. */
export function divideAmount(
  amount: bigint,
  divisor: bigint,
): { quotient: bigint; remainder: bigint } {
  if (divisor === 0n) throw new Error("Division by zero");
  const quotient = amount / divisor;
  const remainder = amount % divisor;
  return { quotient, remainder };
}

/** Check if a BigInt is within Number.MAX_SAFE_INTEGER range. */
export function isWithinSafeRange(value: bigint): boolean {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return value >= -max && value <= max;
}

/** Convert a dollar amount to cents. For testing convenience only. */
export function toCents(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100));
}

/** Format cents as a display string: 10000n -> "$100.00" */
export function toDisplayAmount(cents: bigint): string {
  const isNegative = cents < 0n;
  const absCents = isNegative ? -cents : cents;
  const dollars = absCents / 100n;
  const remainder = absCents % 100n;
  const sign = isNegative ? "-" : "";
  return `${sign}$${dollars}.${remainder.toString().padStart(2, "0")}`;
}

/** Calculate fee via integer division. Truncates (rounds down). */
export function calculateFee(amount: bigint, feePercent: number): bigint {
  return (amount * BigInt(feePercent)) / 100n;
}

/**
 * Split an amount into merchant share and platform fee.
 * fee + merchantShare = amount exactly (no rounding loss).
 */
export function splitAmount(
  amount: bigint,
  feePercent: number,
): { merchantShare: bigint; fee: bigint } {
  const fee = calculateFee(amount, feePercent);
  const merchantShare = amount - fee;
  return { merchantShare, fee };
}
