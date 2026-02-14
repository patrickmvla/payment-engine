interface LedgerEntry {
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
}

/** Assert that a set of ledger entries balance (total debits === total credits). */
export function assertEntriesBalance(entries: LedgerEntry[]): void {
  let debits = 0n;
  let credits = 0n;

  for (const entry of entries) {
    if (entry.direction === "DEBIT") {
      debits += entry.amount;
    } else {
      credits += entry.amount;
    }
  }

  if (debits !== credits) {
    throw new Error(
      `Entries do not balance: debits=${debits}, credits=${credits}, diff=${debits - credits}`,
    );
  }
}

interface PaymentRecord {
  amount: bigint;
  authorizedAmount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
}

/** Assert that a payment's amount fields satisfy all constraints. */
export function assertPaymentConsistency(payment: PaymentRecord): void {
  if (payment.amount < 0n) {
    throw new Error(`Payment amount is negative: ${payment.amount}`);
  }
  if (payment.authorizedAmount < 0n) {
    throw new Error(`Authorized amount is negative: ${payment.authorizedAmount}`);
  }
  if (payment.capturedAmount < 0n) {
    throw new Error(`Captured amount is negative: ${payment.capturedAmount}`);
  }
  if (payment.refundedAmount < 0n) {
    throw new Error(`Refunded amount is negative: ${payment.refundedAmount}`);
  }
  if (payment.capturedAmount > payment.authorizedAmount) {
    throw new Error(
      `Captured (${payment.capturedAmount}) exceeds authorized (${payment.authorizedAmount})`,
    );
  }
  if (payment.refundedAmount > payment.capturedAmount) {
    throw new Error(
      `Refunded (${payment.refundedAmount}) exceeds captured (${payment.capturedAmount})`,
    );
  }
}

/** Assert that an error response matches the expected shape. */
export function assertErrorResponse(
  body: { error?: { type?: string; message?: string } },
  expectedType: string,
  expectedStatus?: number,
): void {
  if (!body.error) {
    throw new Error(`Expected error response, got: ${JSON.stringify(body)}`);
  }
  if (body.error.type !== expectedType) {
    throw new Error(`Expected error type '${expectedType}', got '${body.error.type}'`);
  }
  if (!body.error.message || body.error.message.length === 0) {
    throw new Error("Error message is empty");
  }
}
