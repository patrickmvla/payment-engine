import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../shared/db";
import { ValidationError } from "../shared/errors";
import { generateId } from "../shared/id";
import { accounts, ledgerEntries, ledgerTransactions } from "./schema";
import type { EntryResult, TransactionInput, TransactionResult } from "./types";

async function postTransaction(db: Database, input: TransactionInput): Promise<TransactionResult> {
  if (!input.entries || input.entries.length < 2) {
    throw new ValidationError("Transaction requires at least 2 entries", {
      entry_count: input.entries?.length ?? 0,
    });
  }

  let totalDebits = 0n;
  let totalCredits = 0n;
  for (const entry of input.entries) {
    if (entry.direction === "DEBIT") totalDebits += entry.amount;
    else totalCredits += entry.amount;
  }

  if (totalDebits !== totalCredits) {
    throw new ValidationError(
      `Transaction is unbalanced: debits=${totalDebits}, credits=${totalCredits}`,
      {
        total_debits: totalDebits.toString(),
        total_credits: totalCredits.toString(),
      },
    );
  }

  const uniqueAccountIds = [...new Set(input.entries.map((e) => e.accountId))];
  const existingAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.id, uniqueAccountIds));

  const existingIds = new Set(existingAccounts.map((a) => a.id));
  for (const accountId of uniqueAccountIds) {
    if (!existingIds.has(accountId)) {
      throw new ValidationError(`Account '${accountId}' not found`, {
        account_id: accountId,
      });
    }
  }

  const txnId = generateId("txn");

  return await db.transaction(async (tx) => {
    const txnRows = await tx
      .insert(ledgerTransactions)
      .values({
        id: txnId,
        description: input.description,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
      })
      .returning();
    const txnRow = txnRows[0]!;

    const entries: EntryResult[] = [];

    for (const entry of input.entries) {
      const entryId = generateId("ent");
      const entryRows = await tx
        .insert(ledgerEntries)
        .values({
          id: entryId,
          transactionId: txnId,
          accountId: entry.accountId,
          direction: entry.direction,
          amount: entry.amount,
        })
        .returning();
      const entryRow = entryRows[0]!;

      entries.push({
        id: entryRow.id,
        transactionId: entryRow.transactionId,
        accountId: entryRow.accountId,
        direction: entryRow.direction as "DEBIT" | "CREDIT",
        amount: entryRow.amount,
        createdAt: entryRow.createdAt,
      });
    }

    return {
      id: txnRow.id,
      description: txnRow.description,
      referenceType: txnRow.referenceType,
      referenceId: txnRow.referenceId,
      createdAt: txnRow.createdAt,
      entries,
    };
  });
}

async function getBalance(db: Database, accountId: string): Promise<bigint> {
  const accountRows = await db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.id, accountId));

  if (accountRows.length === 0) {
    throw new ValidationError(`Account '${accountId}' not found`, {
      account_id: accountId,
    });
  }

  const accountType = accountRows[0]!.type;
  const isDebitNormal = accountType === "asset" || accountType === "expense";

  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS total_debits,
      COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS total_credits
    FROM ledger_entries
    WHERE account_id = ${accountId}
  `);

  const row = result[0] as { total_debits: string; total_credits: string };
  const debits = BigInt(row.total_debits);
  const credits = BigInt(row.total_credits);

  return isDebitNormal ? debits - credits : credits - debits;
}

async function getTransactionsByReference(
  db: Database,
  referenceType: string,
  referenceId: string,
): Promise<TransactionResult[]> {
  const txns = await db
    .select()
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.referenceType, referenceType),
        eq(ledgerTransactions.referenceId, referenceId),
      ),
    )
    .orderBy(asc(ledgerTransactions.createdAt));

  const results: TransactionResult[] = [];

  for (const txn of txns) {
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, txn.id));

    results.push({
      id: txn.id,
      description: txn.description,
      referenceType: txn.referenceType,
      referenceId: txn.referenceId,
      createdAt: txn.createdAt,
      entries: entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        accountId: e.accountId,
        direction: e.direction as "DEBIT" | "CREDIT",
        amount: e.amount,
        createdAt: e.createdAt,
      })),
    });
  }

  return results;
}

export const ledgerService = {
  postTransaction,
  getBalance,
  getTransactionsByReference,
};
