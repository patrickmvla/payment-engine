/**
 * All money operations use BigInt. Zero floating point.
 * Amounts are always in the smallest currency unit (cents for USD).
 */

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
