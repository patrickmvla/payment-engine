export interface EntryInput {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
}

export interface TransactionInput {
  description: string;
  referenceType?: string;
  referenceId?: string;
  entries: EntryInput[];
}

export interface EntryResult {
  id: string;
  transactionId: string;
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
  createdAt: Date;
}

export interface TransactionResult {
  id: string;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
  entries: EntryResult[];
}
