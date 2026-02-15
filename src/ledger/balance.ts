export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

type LedgerEntry = {
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
};

const DEBIT_NORMAL: Set<string> = new Set(["asset", "expense"]);
const CREDIT_NORMAL: Set<string> = new Set(["liability", "revenue", "equity"]);

export function computeBalance(entries: LedgerEntry[], accountType: AccountType): bigint {
  if (!DEBIT_NORMAL.has(accountType) && !CREDIT_NORMAL.has(accountType)) {
    throw new Error(`Unknown account type: ${accountType}`);
  }

  let debits = 0n;
  let credits = 0n;

  for (const entry of entries) {
    if (entry.direction === "DEBIT") {
      debits += entry.amount;
    } else {
      credits += entry.amount;
    }
  }

  return DEBIT_NORMAL.has(accountType) ? debits - credits : credits - debits;
}
