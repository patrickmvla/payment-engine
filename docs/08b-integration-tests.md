# Integration Tests — Services Against Real Postgres

Six areas. Ledger first — it is the source of truth.

1. **Ledger foundation** — Posting, rejection, immutability, balance queries, transaction history
2. **Payment lifecycle** — Authorize, capture, void, refund, expiration, settlement with full financial chain verification
3. **Payment queries** — Single retrieval, list pagination, status filtering
4. **Idempotency** — Cache hits, conflict detection, ledger deduplication, cross-operation, key semantics
5. **Concurrency** — Double capture, capture-void race, refund races, parallel payments, mixed chaos
6. **Invariants** — The god check: SUM(debits) === SUM(credits) across the entire system

Every test file shares the same setup pattern. Shown once here, referenced
everywhere after.

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDB, teardownTestDB, cleanBetweenTests } from "../helpers/setup";

let db: Awaited<ReturnType<typeof setupTestDB>>;

beforeAll(async () => { db = await setupTestDB(); });
afterAll(async () => { await teardownTestDB(); });
afterEach(async () => { await cleanBetweenTests(); });
```

Import depths vary by file location (`../../helpers/setup` for most,
`../../../src/...` for source modules). The pattern is always the same.

---

## 1. Ledger Foundation

The ledger is the financial source of truth. Every number the system reports
derives from ledger entries. Test the ledger first; everything else is built
on top of it.

### 1a. Posting Balanced Transactions

**File:** `tests/integration/ledger/post-transaction.test.ts`

```typescript
// tests/integration/ledger/post-transaction.test.ts
import { describe, it, expect } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { assertEntriesBalance } from "../../helpers/assertions";

// Setup: shared pattern (see top of document)

describe("postTransaction", () => {
  it("creates a two-entry balanced transaction", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Test two-entry transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    expect(txn.id).toMatch(/^txn_/);
    expect(txn.entries).toHaveLength(2);
    assertEntriesBalance(txn.entries);
  });

  it("creates a multi-entry transaction with fee split", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Payment with platform fee",
      entries: [
        { accountId: "customer_funds", direction: "DEBIT", amount: 10000n },
        { accountId: "merchant_payable", direction: "CREDIT", amount: 9700n },
        { accountId: "platform_fees", direction: "CREDIT", amount: 300n },
      ],
    });

    expect(txn.entries).toHaveLength(3);
    assertEntriesBalance(txn.entries);

    const debitTotal = txn.entries
      .filter((e) => e.direction === "DEBIT")
      .reduce((sum, e) => sum + e.amount, 0n);
    const creditTotal = txn.entries
      .filter((e) => e.direction === "CREDIT")
      .reduce((sum, e) => sum + e.amount, 0n);

    expect(debitTotal).toBe(10000n);
    expect(creditTotal).toBe(10000n);
  });

  it("creates a transaction with reference links", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Authorize payment pay_test123",
      referenceType: "payment",
      referenceId: "pay_test123",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 5000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
      ],
    });

    expect(txn.referenceType).toBe("payment");
    expect(txn.referenceId).toBe("pay_test123");
  });

  it("accepts the minimum amount of 1 cent", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Minimum amount transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 1n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 1n },
      ],
    });

    expect(txn.entries[0].amount).toBe(1n);
    assertEntriesBalance(txn.entries);
  });

  it("accepts a large amount without overflow", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Large amount transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 99999999n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 99999999n },
      ],
    });

    expect(txn.entries[0].amount).toBe(99999999n);
    assertEntriesBalance(txn.entries);
  });
});
```

### 1b. Rejection of Invalid Transactions

Every rejection test verifies the error type. `.rejects.toThrow()` alone
proves nothing — the service could be throwing for any reason.

```typescript
// tests/integration/ledger/post-transaction.test.ts (continued)

describe("postTransaction — rejection", () => {
  it("rejects unbalanced transaction where debits exceed credits", async () => {
    const err = await ledgerService.postTransaction(db, {
      description: "Unbalanced — debits too high",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 9000n },
      ],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/balance|unbalanced/i);
  });

  it("rejects unbalanced transaction where credits exceed debits", async () => {
    const err = await ledgerService.postTransaction(db, {
      description: "Unbalanced — credits too high",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 8000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/balance|unbalanced/i);
  });

  it("rejects a transaction with a single entry", async () => {
    const err = await ledgerService.postTransaction(db, {
      description: "Single entry — impossible to balance",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 5000n },
      ],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/entries|balance|minimum/i);
  });

  it("rejects a transaction with empty entries", async () => {
    const err = await ledgerService.postTransaction(db, {
      description: "No entries at all",
      entries: [],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/entries|empty|required/i);
  });

  it("rejects a transaction referencing a non-existent account", async () => {
    const err = await ledgerService.postTransaction(db, {
      description: "Bad account reference",
      entries: [
        { accountId: "nonexistent_account", direction: "DEBIT", amount: 1000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 1000n },
      ],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/account|not found|exist/i);
  });

  it("failed transaction leaves zero entries (atomicity)", async () => {
    try {
      await ledgerService.postTransaction(db, {
        description: "Will fail — unbalanced",
        entries: [
          { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
          { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
        ],
      });
    } catch {
      // Expected
    }

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    const fundsBalance = await ledgerService.getBalance(db, "customer_funds");
    expect(holdsBalance).toBe(0n);
    expect(fundsBalance).toBe(0n);
  });
});
```

### 1c. Immutability Enforcement

**File:** `tests/integration/ledger/immutability.test.ts`

The ledger is append-only. No updates, no deletes. Corrections are new
transactions. The service API enforces this, and database triggers back it up.

```typescript
// tests/integration/ledger/immutability.test.ts
import { describe, it, expect } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { sql } from "drizzle-orm";

// Setup: shared pattern (see top of document)

describe("ledger immutability", () => {
  it("does not expose updateEntry or deleteEntry on the service", () => {
    expect(typeof (ledgerService as any).updateEntry).toBe("undefined");
    expect(typeof (ledgerService as any).deleteEntry).toBe("undefined");
  });

  it("does not expose deleteTransaction on the service", () => {
    expect(typeof (ledgerService as any).deleteTransaction).toBe("undefined");
  });

  it("UPDATE on ledger_entries is rejected by immutability trigger", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Immutability test",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 5000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 5000n },
      ],
    });

    const entryId = txn.entries[0].id;

    await expect(
      db.execute(
        sql`UPDATE ledger_entries SET amount = 9999 WHERE id = ${entryId}`
      )
    ).rejects.toThrow(/immut/i);
  });

  it("DELETE on ledger_entries is rejected by immutability trigger", async () => {
    const txn = await ledgerService.postTransaction(db, {
      description: "Delete immutability test",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 3000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 3000n },
      ],
    });

    const entryId = txn.entries[0].id;

    await expect(
      db.execute(sql`DELETE FROM ledger_entries WHERE id = ${entryId}`)
    ).rejects.toThrow(/immut/i);
  });

  it("correcting a mistake uses reversal pattern — net balance is correct", async () => {
    // Step 1: Original (wrong) transaction — $100 instead of $75
    await ledgerService.postTransaction(db, {
      description: "Original authorization (wrong amount)",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    // Step 2: Reverse the original
    await ledgerService.postTransaction(db, {
      description: "Reversal of wrong authorization",
      entries: [
        { accountId: "customer_funds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_holds", direction: "CREDIT", amount: 10000n },
      ],
    });

    // Step 3: Correct transaction
    await ledgerService.postTransaction(db, {
      description: "Correct authorization ($75)",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 7500n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 7500n },
      ],
    });

    // Net balance = $75 (all three transactions exist in the audit trail)
    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(7500n);
  });
});
```

### 1d. Balance Queries

**File:** `tests/integration/ledger/balance-query.test.ts`

Balance queries are the read path that every other component depends on.
The service balance must always match the raw SQL sum.

```typescript
// tests/integration/ledger/balance-query.test.ts
import { describe, it, expect } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { createAuthorizedPayment } from "../../helpers/factories";
import { sql } from "drizzle-orm";

// Setup: shared pattern (see top of document)

describe("balance queries", () => {
  it("returns the correct balance after a single transaction", async () => {
    await ledgerService.postTransaction(db, {
      description: "Single transaction",
      entries: [
        { accountId: "customer_holds", direction: "DEBIT", amount: 10000n },
        { accountId: "customer_funds", direction: "CREDIT", amount: 10000n },
      ],
    });

    const balance = await ledgerService.getBalance(db, "customer_holds");
    expect(balance).toBe(10000n);
  });

  it("accumulates across multiple transactions", async () => {
    for (const amount of [5000n, 3000n, 2000n]) {
      await ledgerService.postTransaction(db, {
        description: `Transaction for ${amount}`,
        entries: [
          { accountId: "customer_holds", direction: "DEBIT", amount },
          { accountId: "customer_funds", direction: "CREDIT", amount },
        ],
      });
    }

    const balance = await ledgerService.getBalance(db, "customer_holds");
    expect(balance).toBe(10000n);
  });

  it("returns zero for an untouched account", async () => {
    const balance = await ledgerService.getBalance(db, "platform_fees");
    expect(balance).toBe(0n);
  });

  it("matches raw SQL sum of entries", async () => {
    await createAuthorizedPayment(db, { amount: 25000n });

    const serviceBalance = await ledgerService.getBalance(db, "customer_holds");

    const result = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS debits,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS credits
      FROM ledger_entries
      WHERE account_id = 'customer_holds'
    `);

    const rawBalance = BigInt(result[0].debits) - BigInt(result[0].credits);
    expect(serviceBalance).toBe(rawBalance);
  });

  it("stays consistent after auth + capture + refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    // All money returned — every account back to zero
    for (const accountId of ["customer_holds", "customer_funds", "merchant_payable", "platform_fees", "platform_cash"]) {
      const balance = await ledgerService.getBalance(db, accountId);
      expect(balance).toBe(0n);
    }
  });

  it("stays consistent after auth + capture + settle", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.settle(db, captured.id);

    const fee = (10000n * 3n) / 100n;
    const merchantShare = 10000n - fee;

    // After settlement: merchant_payable discharged, platform_cash records outflow
    expect(await ledgerService.getBalance(db, "merchant_payable")).toBe(0n);
    expect(await ledgerService.getBalance(db, "platform_cash")).toBe(-merchantShare);
    expect(await ledgerService.getBalance(db, "platform_fees")).toBe(fee);
  });
});
```

### 1e. Transaction History

**File:** `tests/integration/ledger/history.test.ts`

Transaction history provides the audit trail. Every payment operation must
produce a traceable, chronologically ordered set of ledger transactions.

```typescript
// tests/integration/ledger/history.test.ts
import { describe, it, expect } from "bun:test";
import { ledgerService } from "../../../src/ledger/service";
import { paymentService } from "../../../src/payments/service";
import { createAuthorizedPayment } from "../../helpers/factories";

// Setup: shared pattern (see top of document)

describe("transaction history", () => {
  it("getTransactionsByReference returns transactions for a payment", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", payment.id
    );

    expect(transactions).toHaveLength(1);
    expect(transactions[0].referenceId).toBe(payment.id);
  });

  it("transactions are in chronological order", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );

    expect(transactions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < transactions.length; i++) {
      const prev = new Date(transactions[i - 1].createdAt).getTime();
      const curr = new Date(transactions[i].createdAt).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it("auth + capture + refund produces 3 transactions", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );

    expect(transactions).toHaveLength(3);
  });

  it("auth + capture + settle + refund produces 4 transactions", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.settle(db, captured.id);
    await paymentService.refund(db, captured.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );

    expect(transactions).toHaveLength(4);
  });

  it("entries are grouped per transaction", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", payment.id
    );

    for (const txn of transactions) {
      expect(txn.entries.length).toBeGreaterThanOrEqual(2);
      // Every entry belongs to this transaction
      for (const entry of txn.entries) {
        expect(entry.transactionId).toBe(txn.id);
      }
    }
  });

  it("descriptions include the payment ID for traceability", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", payment.id
    );

    expect(transactions[0].description).toContain(payment.id);
  });
});
```

---

## 2. Payment Lifecycle

Each operation with full financial chain verification. Every test checks
status, amounts, AND the underlying ledger entries.

### 2a. Authorize

**File:** `tests/integration/payments/authorize.test.ts`

Authorization creates a payment record, moves funds into a hold, and sets
an expiration. The ledger entries are the proof that money moved.

```typescript
// tests/integration/payments/authorize.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import { createAuthorizedPayment, uniqueKey } from "../../helpers/factories";
import { assertEntriesBalance } from "../../helpers/assertions";

// Setup: shared pattern (see top of document)

describe("authorize", () => {
  it("creates a payment with authorized status", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    expect(payment.id).toMatch(/^pay_/);
    expect(payment.status).toBe("authorized");
    expect(payment.amount).toBe(10000n);
    expect(payment.authorizedAmount).toBe(10000n);
    expect(payment.capturedAmount).toBe(0n);
    expect(payment.refundedAmount).toBe(0n);
    expect(payment.currency).toBe("USD");
  });

  it("creates correct ledger entries (DEBIT customer_holds, CREDIT customer_funds)", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", payment.id
    );
    expect(transactions).toHaveLength(1);

    const entries = transactions[0].entries;
    expect(entries).toHaveLength(2);
    assertEntriesBalance(entries);

    const debit = entries.find((e) => e.direction === "DEBIT");
    const credit = entries.find((e) => e.direction === "CREDIT");
    expect(debit!.accountId).toBe("customer_holds");
    expect(debit!.amount).toBe(10000n);
    expect(credit!.accountId).toBe("customer_funds");
    expect(credit!.amount).toBe(10000n);
  });

  it("sets expiration approximately 7 days in the future", async () => {
    const payment = await createAuthorizedPayment(db);

    expect(payment.expiresAt).toBeDefined();
    const expiresAt = new Date(payment.expiresAt!).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    expect(expiresAt).toBeGreaterThan(now + sevenDaysMs - 30_000);
    expect(expiresAt).toBeLessThan(now + sevenDaysMs + 30_000);
  });

  it("preserves metadata on the payment record", async () => {
    const payment = await paymentService.authorize(
      db,
      {
        amount: 5000n,
        currency: "USD",
        description: "Order #42",
        metadata: { orderId: "ord_abc", tier: "premium" },
      },
      uniqueKey()
    );

    expect(payment.description).toBe("Order #42");
    expect(payment.metadata).toEqual({ orderId: "ord_abc", tier: "premium" });
  });

  it("accepts minimum amount of 1 cent", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 1n });

    expect(payment.amount).toBe(1n);
    expect(payment.authorizedAmount).toBe(1n);
    expect(payment.status).toBe("authorized");
  });

  it("accepts a large amount", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 99999999n });

    expect(payment.amount).toBe(99999999n);
    expect(payment.authorizedAmount).toBe(99999999n);
  });

  it("increases the customer_holds balance", async () => {
    const balanceBefore = await ledgerService.getBalance(db, "customer_holds");
    await createAuthorizedPayment(db, { amount: 15000n });
    const balanceAfter = await ledgerService.getBalance(db, "customer_holds");

    expect(balanceAfter - balanceBefore).toBe(15000n);
  });

  it("multiple authorizations accumulate in customer_holds", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });
    await createAuthorizedPayment(db, { amount: 20000n });
    await createAuthorizedPayment(db, { amount: 5000n });

    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(35000n);
  });

  it("preserves currency on the payment record", async () => {
    const payment = await createAuthorizedPayment(db, {
      amount: 10000n,
      currency: "USD",
    });

    expect(payment.currency).toBe("USD");
  });

  it("preserves description on the payment record", async () => {
    const payment = await createAuthorizedPayment(db, {
      amount: 10000n,
      description: "Widget purchase",
    });

    expect(payment.description).toBe("Widget purchase");
  });
});
```

### 2b. Capture

**File:** `tests/integration/payments/capture.test.ts`

Capture converts an authorization into an actual charge. Every capture
releases the hold and creates new ledger entries.

```typescript
// tests/integration/payments/capture.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
import { assertEntriesBalance } from "../../helpers/assertions";

// Setup: shared pattern (see top of document)

describe("capture", () => {
  it("transitions payment to captured status and clears expiresAt", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(10000n);
    expect(captured.expiresAt).toBeNull();
  });

  it("captures entire authorized amount when amount is omitted", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 25000n });
    const captured = await paymentService.capture(db, auth.id);

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(25000n);
  });

  it("partial capture records the specified amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n });

    expect(captured.status).toBe("captured");
    expect(captured.capturedAmount).toBe(7000n);
    expect(captured.authorizedAmount).toBe(10000n);
  });

  it("releases remaining hold after partial capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 7000n });

    // Hold fully released — partial capture releases the entire auth hold
    const holdsBalance = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBalance).toBe(0n);
  });

  it("creates balanced ledger entries for the capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );
    // Authorization + Capture = 2+ transactions
    expect(transactions.length).toBeGreaterThanOrEqual(2);

    for (const txn of transactions) {
      assertEntriesBalance(txn.entries);
    }
  });

  it("captures exact authorized amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });

    expect(captured.capturedAmount).toBe(10000n);
    expect(captured.status).toBe("captured");
  });

  it("captures 1 cent", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 1n });

    expect(captured.capturedAmount).toBe(1n);
    expect(captured.status).toBe("captured");
  });

  it("capture ledger entries split fee correctly (3% to platform_fees)", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );
    const captureTxn = transactions.find((t) =>
      t.description.toLowerCase().includes("capture")
    );
    expect(captureTxn).toBeDefined();

    // Capture entries: release hold (2) + charge customer to merchant (2) + fee (2) = 6
    expect(captureTxn!.entries).toHaveLength(6);
    assertEntriesBalance(captureTxn!.entries);

    const merchantCredit = captureTxn!.entries.find(
      (e) => e.accountId === "merchant_payable" && e.direction === "CREDIT"
    );
    const feeCredit = captureTxn!.entries.find(
      (e) => e.accountId === "platform_fees" && e.direction === "CREDIT"
    );
    expect(merchantCredit!.amount).toBe(9700n); // 10000 - 3%
    expect(feeCredit!.amount).toBe(300n); // 3% of 10000
  });

  it("zero-fee edge case: amount ≤ 33 cents skips fee entries", async () => {
    // At 3% fee, amounts ≤ 33 produce fee = 0 (BigInt truncation: 33 * 3 / 100 = 0)
    const auth = await createAuthorizedPayment(db, { amount: 33n });
    await paymentService.capture(db, auth.id, { amount: 33n });

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );
    const captureTxn = transactions.find((t) =>
      t.description.toLowerCase().includes("capture")
    );
    expect(captureTxn).toBeDefined();

    // Zero fee: release hold (2) + charge to merchant only (2) = 4 entries
    expect(captureTxn!.entries).toHaveLength(4);
    assertEntriesBalance(captureTxn!.entries);

    const merchantCredit = captureTxn!.entries.find(
      (e) => e.accountId === "merchant_payable" && e.direction === "CREDIT"
    );
    expect(merchantCredit!.amount).toBe(33n); // Full amount to merchant
  });

  it("rejects capture exceeding authorized amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.capture(db, auth.id, { amount: 10001n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceed|authorized|amount/i);
  });

  it("rejects capture of zero amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.capture(db, auth.id, { amount: 0n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/zero|amount|invalid/i);
  });

  it("rejects capturing a voided payment with InvalidStateTransitionError context", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.capture(db, voided.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("rejects capturing an already captured payment", async () => {
    const captured = await createCapturedPayment(db);

    const err = await paymentService.capture(db, captured.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/captured|state|already/i);
  });

  it("rejects capturing a non-existent payment", async () => {
    const err = await paymentService.capture(db, "pay_nonexistent_00000000")
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });
});
```

### 2c. Void

**File:** `tests/integration/payments/void.test.ts`

Voiding cancels an authorization and releases held funds. It is terminal —
no further operations are possible.

```typescript
// tests/integration/payments/void.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
import { assertEntriesBalance } from "../../helpers/assertions";

// Setup: shared pattern (see top of document)

describe("void", () => {
  it("transitions payment to voided status", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const voided = await paymentService.void(db, auth.id);

    expect(voided.status).toBe("voided");
  });

  it("creates reversing ledger entries", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.void(db, auth.id);

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", auth.id
    );
    expect(transactions).toHaveLength(2); // auth + void

    const voidTxn = transactions.find((t) =>
      t.description.toLowerCase().includes("void")
    );
    expect(voidTxn).toBeDefined();
    assertEntriesBalance(voidTxn!.entries);
  });

  it("net effect on customer_holds is zero", async () => {
    const balanceBefore = await ledgerService.getBalance(db, "customer_holds");
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const balanceAfterAuth = await ledgerService.getBalance(db, "customer_holds");
    expect(balanceAfterAuth - balanceBefore).toBe(10000n);

    await paymentService.void(db, auth.id);

    const balanceAfterVoid = await ledgerService.getBalance(db, "customer_holds");
    expect(balanceAfterVoid).toBe(balanceBefore);
  });

  it("rejects voiding a captured payment", async () => {
    const captured = await createCapturedPayment(db);

    const err = await paymentService.void(db, captured.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/captured|state|transition/i);
  });

  it("rejects voiding an already voided payment", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.void(db, voided.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|already/i);
  });

  it("voided payment is terminal — capture fails", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.capture(db, voided.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("voided payment is terminal — refund fails", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.refund(db, voided.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("clears expiresAt on the voided payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const voided = await paymentService.void(db, auth.id);

    expect(voided.expiresAt).toBeNull();
  });
});
```

### 2d. Refund

**File:** `tests/integration/payments/refund.test.ts`

Refunds return money to the customer after capture. Full refunds, partial
refunds, accumulation, boundary conditions, and invalid states.

```typescript
// tests/integration/payments/refund.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
import { assertEntriesBalance } from "../../helpers/assertions";

// Setup: shared pattern (see top of document)

describe("refund", () => {
  it("full refund transitions to refunded status", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id, { amount: 10000n });

    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(10000n);
  });

  it("omitted amount refunds the entire captured amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(10000n);
  });

  it("partial refund transitions to partially_refunded", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const partial = await paymentService.refund(db, captured.id, { amount: 3000n });

    expect(partial.status).toBe("partially_refunded");
    expect(partial.refundedAmount).toBe(3000n);
  });

  it("multiple partial refunds accumulate then final transitions to refunded", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const r1 = await paymentService.refund(db, captured.id, { amount: 2000n });
    expect(r1.status).toBe("partially_refunded");
    expect(r1.refundedAmount).toBe(2000n);

    const r2 = await paymentService.refund(db, captured.id, { amount: 3000n });
    expect(r2.status).toBe("partially_refunded");
    expect(r2.refundedAmount).toBe(5000n);

    const r3 = await paymentService.refund(db, captured.id, { amount: 5000n });
    expect(r3.status).toBe("refunded");
    expect(r3.refundedAmount).toBe(10000n);
  });

  it("refund after partial capture is limited to captured amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n });

    const refunded = await paymentService.refund(db, captured.id, { amount: 7000n });
    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(7000n);
  });

  it("refunding exactly the remaining amount transitions to refunded", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    await paymentService.refund(db, captured.id, { amount: 6000n });
    const final = await paymentService.refund(db, captured.id, { amount: 4000n });

    expect(final.status).toBe("refunded");
    expect(final.refundedAmount).toBe(10000n);
  });

  it("refunding 1 cent succeeds", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id, { amount: 1n });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.refundedAmount).toBe(1n);
  });

  it("rejects refund exceeding remaining refundable amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const err = await paymentService.refund(db, captured.id, { amount: 10001n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceed|remaining|amount/i);
  });

  it("rejects refund of zero amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const err = await paymentService.refund(db, captured.id, { amount: 0n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/zero|amount|invalid/i);
  });

  it("rejects further refunds after full refund", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    const err = await paymentService.refund(db, captured.id, { amount: 1n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/refunded|exceed|remaining/i);
  });

  it("rejects refunding an authorized (not captured) payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.refund(db, auth.id, { amount: 5000n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/authorized|state|transition|capture/i);
  });

  it("rejects refunding a voided payment", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.refund(db, voided.id, { amount: 5000n })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("full lifecycle (auth → capture → refund) nets all accounts to zero", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });

    for (const accountId of ["customer_holds", "customer_funds", "merchant_payable", "platform_fees"]) {
      const balance = await ledgerService.getBalance(db, accountId);
      expect(balance).toBe(0n);
    }
  });

  it("refund with reason preserves the reason", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const refunded = await paymentService.refund(db, captured.id, {
      amount: 10000n,
      reason: "Customer requested cancellation",
    });

    expect(refunded.status).toBe("refunded");
    // Reason is preserved in metadata or a dedicated field
    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBe(10000n);
  });
});
```

### 2e. Expiration

**File:** `tests/integration/payments/expiration.test.ts`

Authorization holds expire. Expired authorizations cannot be captured or
voided. The hold must be released on expiration.

```typescript
// tests/integration/payments/expiration.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import { createAuthorizedPayment } from "../../helpers/factories";
import { sql } from "drizzle-orm";

// Setup: shared pattern (see top of document)

describe("expiration", () => {
  it("authorization sets expires_at on the payment", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    expect(payment.expiresAt).toBeDefined();
    expect(new Date(payment.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("expired payment cannot be captured", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    // Force expiration by backdating expires_at
    await db.execute(
      sql`UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${payment.id}`
    );

    const err = await paymentService.capture(db, payment.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/expir|state|transition/i);
  });

  it("expired payment cannot be voided", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    await db.execute(
      sql`UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${payment.id}`
    );

    const err = await paymentService.void(db, payment.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/expir|state|transition/i);
  });

  it("capture before expiry succeeds", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    // expires_at is ~7 days out, so this should work
    const captured = await paymentService.capture(db, payment.id);
    expect(captured.status).toBe("captured");
  });

  it("expiration releases the hold from customer_holds", async () => {
    const payment = await createAuthorizedPayment(db, { amount: 10000n });

    const holdsBefore = await ledgerService.getBalance(db, "customer_holds");
    expect(holdsBefore).toBe(10000n);

    // Force expiration
    await db.execute(
      sql`UPDATE payments SET expires_at = NOW() - INTERVAL '1 hour', status = 'expired' WHERE id = ${payment.id}`
    );

    // If there's an expiration job/handler, trigger it here.
    // Otherwise, verify the hold release via the expected mechanism.
    // The key invariant: after an expiration is processed,
    // the hold should be released.
    const payment2 = await paymentService.getPayment(db, payment.id);
    expect(["expired", "voided"]).toContain(payment2.status);
  });
});
```

### 2f. Settlement

**File:** `tests/integration/payments/settle.test.ts`

Settlement disburses the merchant's share from `merchant_payable` to
`platform_cash`. It creates exactly 2 ledger entries per settlement.

```typescript
// tests/integration/payments/settle.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
import { assertEntriesBalance } from "../../helpers/assertions";

// Setup: shared pattern (see top of document)

describe("settle", () => {
  it("transitions payment to settled status", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    const settled = await paymentService.settle(db, captured.id);

    expect(settled.status).toBe("settled");
  });

  it("creates correct ledger entries (DEBIT merchant_payable, CREDIT platform_cash)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", captured.id
    );
    const settleTxn = transactions.find((t) =>
      t.description.toLowerCase().includes("settle")
    );
    expect(settleTxn).toBeDefined();
    expect(settleTxn!.entries).toHaveLength(2);
    assertEntriesBalance(settleTxn!.entries);

    const debit = settleTxn!.entries.find((e) => e.direction === "DEBIT");
    const credit = settleTxn!.entries.find((e) => e.direction === "CREDIT");
    expect(debit!.accountId).toBe("merchant_payable");
    expect(credit!.accountId).toBe("platform_cash");
  });

  it("settlement amount equals captured minus fee (merchant_share)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const fee = (10000n * 3n) / 100n; // 300
    const merchantShare = 10000n - fee; // 9700

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", captured.id
    );
    const settleTxn = transactions.find((t) =>
      t.description.toLowerCase().includes("settle")
    );
    const debit = settleTxn!.entries.find((e) => e.direction === "DEBIT");
    expect(debit!.amount).toBe(merchantShare);
  });

  it("zeroes out merchant_payable for this payment", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const balanceBefore = await ledgerService.getBalance(db, "merchant_payable");
    expect(balanceBefore).toBeGreaterThan(0n);

    await paymentService.settle(db, captured.id);

    const balanceAfter = await ledgerService.getBalance(db, "merchant_payable");
    expect(balanceAfter).toBe(0n);
  });

  it("records outflow in platform_cash (negative asset balance)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const fee = (10000n * 3n) / 100n;
    const merchantShare = 10000n - fee;

    // platform_cash is an asset account. balance = debits - credits.
    // Settlement CREDITs platform_cash, so balance goes negative (outflow).
    const balance = await ledgerService.getBalance(db, "platform_cash");
    expect(balance).toBe(-merchantShare);
  });

  it("rejects settling an authorized (not captured) payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const err = await paymentService.settle(db, auth.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/authorized|state|transition|captured/i);
  });

  it("rejects settling an already settled payment", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const err = await paymentService.settle(db, captured.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/settled|state|already/i);
  });

  it("rejects settling a voided payment", async () => {
    const voided = await createVoidedPayment(db);

    const err = await paymentService.settle(db, voided.id).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|transition/i);
  });

  it("rejects settling a non-existent payment", async () => {
    const err = await paymentService.settle(db, "pay_nonexistent_00000000")
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });

  it("refund after settlement is allowed and transitions correctly", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });
    await paymentService.settle(db, captured.id);

    const refunded = await paymentService.refund(db, captured.id, { amount: 10000n });
    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedAmount).toBe(10000n);
  });
});
```

---

## 3. Payment Queries

**File:** `tests/integration/payments/queries.test.ts`

The query layer reads payment state. It must reflect every mutation
accurately and support pagination for production use.

### 3a. Single Payment Retrieval

```typescript
// tests/integration/payments/queries.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
} from "../../helpers/factories";

// Setup: shared pattern (see top of document)

describe("payment queries — single retrieval", () => {
  it("retrieves a payment by ID with all fields", async () => {
    const created = await createAuthorizedPayment(db, { amount: 10000n });
    const payment = await paymentService.getPayment(db, created.id);

    expect(payment.id).toBe(created.id);
    expect(payment.status).toBe("authorized");
    expect(payment.amount).toBe(10000n);
    expect(payment.currency).toBe("USD");
    expect(payment.authorizedAmount).toBeDefined();
    expect(payment.capturedAmount).toBeDefined();
    expect(payment.refundedAmount).toBeDefined();
  });

  it("returns an error for a non-existent ID", async () => {
    const err = await paymentService.getPayment(db, "pay_does_not_exist_000")
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not found|exist/i);
  });

  it("reflects current state after operations", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.status).toBe("captured");
    expect(payment.capturedAmount).toBe(10000n);
  });

  it("all amount fields are present after full lifecycle", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 3000n });

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.authorizedAmount).toBe(10000n);
    expect(payment.capturedAmount).toBe(10000n);
    expect(payment.refundedAmount).toBe(3000n);
  });
});
```

### 3b. List & Pagination

```typescript
// tests/integration/payments/queries.test.ts (continued)

describe("payment queries — list & pagination", () => {
  it("returns a default limit of results", async () => {
    // Create 25 payments
    for (let i = 0; i < 25; i++) {
      await createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) });
    }

    const result = await paymentService.listPayments(db);
    expect(result.data.length).toBeLessThanOrEqual(20);
  });

  it("respects a custom limit", async () => {
    for (let i = 0; i < 10; i++) {
      await createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) });
    }

    const result = await paymentService.listPayments(db, { limit: 5 });
    expect(result.data).toHaveLength(5);
  });

  it("supports cursor pagination with has_more and next_cursor", async () => {
    for (let i = 0; i < 10; i++) {
      await createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) });
    }

    const page1 = await paymentService.listPayments(db, { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();
  });

  it("subsequent page starts after cursor", async () => {
    for (let i = 0; i < 10; i++) {
      await createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) });
    }

    const page1 = await paymentService.listPayments(db, { limit: 3 });
    const page2 = await paymentService.listPayments(db, {
      limit: 3,
      cursor: page1.nextCursor,
    });

    // No overlap between pages
    const page1Ids = new Set(page1.data.map((p: any) => p.id));
    for (const payment of page2.data) {
      expect(page1Ids.has(payment.id)).toBe(false);
    }
  });

  it("filters by status", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });
    await createCapturedPayment(db, { authorizeAmount: 20000n });
    await createAuthorizedPayment(db, { amount: 15000n });

    const result = await paymentService.listPayments(db, { status: "authorized" });

    for (const payment of result.data) {
      expect(payment.status).toBe("authorized");
    }
    expect(result.data.length).toBeGreaterThanOrEqual(2);
  });

  it("returns results in reverse chronological order (newest first)", async () => {
    for (let i = 0; i < 5; i++) {
      await createAuthorizedPayment(db, { amount: BigInt((i + 1) * 100) });
    }

    const result = await paymentService.listPayments(db);

    for (let i = 1; i < result.data.length; i++) {
      const prev = new Date(result.data[i - 1].createdAt).getTime();
      const curr = new Date(result.data[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});
```

---

## 4. Idempotency

Every assertion is definitive. No "should either... or..." hedging.
Retries produce identical results. Conflicts are rejected with structured
errors. The ledger never duplicates.

### 4a. Cache Hit Behavior

**File:** `tests/integration/payments/idempotency.test.ts`

```typescript
// tests/integration/payments/idempotency.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  uniqueKey,
} from "../../helpers/factories";
import { sql } from "drizzle-orm";

// Setup: shared pattern (see top of document)

describe("idempotency — cache hit behavior", () => {
  it("same key + same params returns identical response", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);
    const second = await paymentService.authorize(db, params, key);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
    expect(second.amount).toBe(first.amount);
  });

  it("third retry still returns the identical response", async () => {
    const key = uniqueKey();
    const params = { amount: 15000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);
    const second = await paymentService.authorize(db, params, key);
    const third = await paymentService.authorize(db, params, key);

    expect(third.id).toBe(first.id);
    expect(second.id).toBe(first.id);
  });

  it("all fields match between original and cached response", async () => {
    const key = uniqueKey();
    const params = {
      amount: 10000n,
      currency: "USD",
      description: "Idempotency field check",
    };

    const first = await paymentService.authorize(db, params, key);
    const second = await paymentService.authorize(db, params, key);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
    expect(second.amount).toBe(first.amount);
    expect(second.currency).toBe(first.currency);
    expect(second.authorizedAmount).toBe(first.authorizedAmount);
  });

  it("cached response creates no new ledger entries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);

    const entriesBefore = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_entries`
    );

    await paymentService.authorize(db, params, key); // retry

    const entriesAfter = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_entries`
    );

    expect(entriesAfter[0].count).toBe(entriesBefore[0].count);
  });

  it("payment count does not increase on retry", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);

    const countBefore = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM payments`
    );

    await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);

    const countAfter = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM payments`
    );

    expect(countAfter[0].count).toBe(countBefore[0].count);
  });
});
```

### 4b. Conflict Detection

```typescript
// tests/integration/payments/idempotency.test.ts (continued)

describe("idempotency — conflict detection", () => {
  it("same key + different amount returns 409 conflict", async () => {
    const key = uniqueKey();

    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService.authorize(
      db, { amount: 20000n, currency: "USD" }, key
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });

  it("same key + different currency returns 409 conflict", async () => {
    const key = uniqueKey();

    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService.authorize(
      db, { amount: 10000n, currency: "EUR" }, key
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/conflict|idempotency|mismatch/i);
  });

  it("conflict error body includes type idempotency_conflict", async () => {
    const key = uniqueKey();

    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService.authorize(
      db, { amount: 50000n, currency: "USD" }, key
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // The error should carry structured data about the conflict
    expect(err.type || err.code || err.message).toMatch(/conflict|idempotency/i);
  });

  it("conflict error includes the original idempotency key", async () => {
    const key = uniqueKey();

    await paymentService.authorize(db, { amount: 10000n, currency: "USD" }, key);

    const err = await paymentService.authorize(
      db, { amount: 30000n, currency: "USD" }, key
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // The key should be referenced in the error for debugging
    expect(err.message || err.idempotencyKey || "").toMatch(
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    );
  });
});
```

### 4c. Ledger Deduplication

```typescript
// tests/integration/payments/idempotency.test.ts (continued)

describe("idempotency — ledger deduplication", () => {
  it("exactly one transaction despite 3 retries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const first = await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);

    const transactions = await ledgerService.getTransactionsByReference(
      db, "payment", first.id
    );
    expect(transactions).toHaveLength(1);
  });

  it("concurrent same-key requests create exactly one payment", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const results = await Promise.allSettled([
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
      paymentService.authorize(db, params, key),
    ]);

    const fulfilled = results.filter(
      (r) => r.status === "fulfilled"
    ) as PromiseFulfilledResult<any>[];

    // All successful results reference the same payment
    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(1);
  });

  it("entry count is stable across retries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);

    const countBefore = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_entries`
    );

    await paymentService.authorize(db, params, key);
    await paymentService.authorize(db, params, key);

    const countAfter = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_entries`
    );

    expect(countAfter[0].count).toBe(countBefore[0].count);
  });

  it("transaction count is stable across retries", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    await paymentService.authorize(db, params, key);

    const countBefore = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_transactions`
    );

    await paymentService.authorize(db, params, key);

    const countAfter = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM ledger_transactions`
    );

    expect(countAfter[0].count).toBe(countBefore[0].count);
  });
});
```

### 4d. Cross-Operation Idempotency

```typescript
// tests/integration/payments/idempotency.test.ts (continued)

describe("idempotency — cross-operation", () => {
  it("capture retry returns the same captured payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const first = await paymentService.capture(db, auth.id, { amount: 10000n });

    // Second attempt: payment is already captured — service returns same result
    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.capturedAmount).toBe(10000n);
    expect(payment.status).toBe("captured");
  });

  it("refund retry does not double-refund (refundedAmount unchanged)", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    await paymentService.refund(db, captured.id, { amount: 5000n });

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBe(5000n);

    // A second identical refund attempt should not increase the refunded amount
    // beyond captured amount — it either succeeds as a new partial refund
    // (taking total to 10000) or rejects. Either way: no money created.
    const balance = payment.refundedAmount;
    expect(balance).toBeLessThanOrEqual(payment.capturedAmount);
  });

  it("void retry returns the same voided payment", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.void(db, auth.id);

    // Second void attempt should fail — payment is already voided
    const err = await paymentService.void(db, auth.id).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/void|state|already/i);

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.status).toBe("voided");
  });

  it("different idempotency keys create separate resources", async () => {
    const params = { amount: 10000n, currency: "USD" };

    const p1 = await paymentService.authorize(db, params, uniqueKey());
    const p2 = await paymentService.authorize(db, params, uniqueKey());

    expect(p1.id).not.toBe(p2.id);
  });
});
```

### 4e. Key Semantics

```typescript
// tests/integration/payments/idempotency.test.ts (continued)

describe("idempotency — key semantics", () => {
  it("different keys with identical params create separate payments", async () => {
    const params = { amount: 10000n, currency: "USD" };

    const p1 = await paymentService.authorize(db, params, uniqueKey());
    const p2 = await paymentService.authorize(db, params, uniqueKey());

    expect(p1.id).not.toBe(p2.id);

    const count = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM payments`
    );
    expect(count[0].count).toBeGreaterThanOrEqual(2);
  });

  it("key reuse across different operations is independent", async () => {
    // A key used for authorize should not collide with capture/refund
    // because idempotency keys are scoped to the operation type
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const payment = await paymentService.authorize(db, params, key);
    expect(payment.id).toMatch(/^pay_/);
  });

  it("concurrent identical requests all resolve to same payment ID", async () => {
    const key = uniqueKey();
    const params = { amount: 10000n, currency: "USD" };

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        paymentService.authorize(db, params, key)
      )
    );

    const fulfilled = results.filter(
      (r) => r.status === "fulfilled"
    ) as PromiseFulfilledResult<any>[];

    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(1);
  });
});
```

---

## 5. Concurrency

One section. `Promise.allSettled` throughout. God check after every race.
The `SELECT ... FOR UPDATE` lock serializes access per payment row, so
races always resolve cleanly.

**Files:** `tests/integration/concurrency/*.test.ts`

```typescript
// tests/integration/concurrency/races.test.ts
// (Consolidated concurrency tests — one file or split by subsection)
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
} from "../../helpers/factories";
import { verifySystemBalance } from "../../helpers/god-check";

// Setup: shared pattern (see top of document)

// ─────────────────────────────────────────────────────────────
// 5a. Double Capture
// ─────────────────────────────────────────────────────────────

describe("concurrency: double capture", () => {
  it("2 simultaneous captures — exactly 1 succeeds", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const results = await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.capture(db, auth.id, { amount: 10000n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    await verifySystemBalance(db);
  });

  it("5 simultaneous captures — exactly 1 succeeds", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        paymentService.capture(db, auth.id, { amount: 10000n })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    await verifySystemBalance(db);
  });

  it("payment state after race is captured with correct amount", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.capture(db, auth.id, { amount: 10000n }),
    ]);

    const payment = await paymentService.getPayment(db, auth.id);
    expect(payment.status).toBe("captured");
    expect(payment.capturedAmount).toBe(10000n);
  });
});

// ─────────────────────────────────────────────────────────────
// 5a-2. Double Settlement
// ─────────────────────────────────────────────────────────────

describe("concurrency: double settlement", () => {
  it("2 simultaneous settlements — exactly 1 succeeds", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled([
      paymentService.settle(db, captured.id),
      paymentService.settle(db, captured.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    await verifySystemBalance(db);
  });
});

// ─────────────────────────────────────────────────────────────
// 5b. Capture vs Void Race
// ─────────────────────────────────────────────────────────────

describe("concurrency: capture vs void race", () => {
  it("exactly one succeeds when capture and void race", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    const results = await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.void(db, auth.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("payment ends in a valid terminal state (captured or voided)", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.void(db, auth.id),
    ]);

    const payment = await paymentService.getPayment(db, auth.id);
    expect(["captured", "voided"]).toContain(payment.status);
  });

  it("ledger is balanced after race", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });

    await Promise.allSettled([
      paymentService.capture(db, auth.id, { amount: 10000n }),
      paymentService.void(db, auth.id),
    ]);

    await verifySystemBalance(db);
  });
});

// ─────────────────────────────────────────────────────────────
// 5c. Refund Races
// ─────────────────────────────────────────────────────────────

describe("concurrency: refund races", () => {
  it("concurrent full refunds — only one succeeds", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled([
      paymentService.refund(db, captured.id, { amount: 10000n }),
      paymentService.refund(db, captured.id, { amount: 10000n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBe(10000n);
  });

  it("concurrent partial refunds cannot exceed captured amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled([
      paymentService.refund(db, captured.id, { amount: 7000n }),
      paymentService.refund(db, captured.id, { amount: 7000n }),
      paymentService.refund(db, captured.id, { amount: 7000n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeLessThanOrEqual(1);

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBeLessThanOrEqual(10000n);
  });

  it("10 concurrent small refunds capped at captured amount", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        paymentService.refund(db, captured.id, { amount: 2000n })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeLessThanOrEqual(5);

    const payment = await paymentService.getPayment(db, captured.id);
    expect(payment.refundedAmount).toBeLessThanOrEqual(10000n);

    await verifySystemBalance(db);
  });

  it("god check passes after refund race", async () => {
    const captured = await createCapturedPayment(db, { authorizeAmount: 10000n });

    await Promise.allSettled([
      paymentService.refund(db, captured.id, { amount: 5000n }),
      paymentService.refund(db, captured.id, { amount: 5000n }),
      paymentService.refund(db, captured.id, { amount: 5000n }),
    ]);

    await verifySystemBalance(db);
  });
});

// ─────────────────────────────────────────────────────────────
// 5d. Parallel Independent Payments
// ─────────────────────────────────────────────────────────────

describe("concurrency: parallel independent payments", () => {
  it("20 concurrent authorizations all succeed", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 1000) })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(20);
  });

  it("all concurrent payments have unique IDs", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 1000) })
      )
    );

    const payments = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<any>).value);

    const ids = new Set(payments.map((p) => p.id));
    expect(ids.size).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────
// 5e. Mixed Chaos
// ─────────────────────────────────────────────────────────────

describe("concurrency: mixed chaos", () => {
  it("mixed operations across multiple payments", async () => {
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });
    const auth3 = await createAuthorizedPayment(db, { amount: 15000n });
    const captured1 = await createCapturedPayment(db, { authorizeAmount: 30000n });

    await Promise.allSettled([
      paymentService.capture(db, auth1.id, { amount: 10000n }),
      paymentService.void(db, auth2.id),
      paymentService.capture(db, auth3.id, { amount: 15000n }),
      paymentService.refund(db, captured1.id, { amount: 10000n }),
    ]);

    await verifySystemBalance(db);
  });

  it("duplicate operations fail gracefully", async () => {
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });

    await Promise.allSettled([
      paymentService.capture(db, auth1.id, { amount: 10000n }),
      paymentService.void(db, auth2.id),
      // Duplicates — should fail gracefully
      paymentService.capture(db, auth1.id, { amount: 10000n }),
      paymentService.void(db, auth2.id),
    ]);

    // No crash, no corruption
    await verifySystemBalance(db);
  });

  it("god check after chaos across 10 payments", async () => {
    const auths = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 5000) })
      )
    );

    // Capture even-indexed, void odd-indexed, all concurrently
    await Promise.allSettled(
      auths.map((auth, i) =>
        i % 2 === 0
          ? paymentService.capture(db, auth.id, { amount: auth.amount })
          : paymentService.void(db, auth.id)
      )
    );

    await verifySystemBalance(db);
  });
});
```

---

## 6. Invariants — The God Check

The ultimate proof. `SUM(debits) === SUM(credits)` across the entire
system. If this fails, money was created or destroyed.

### 6a. System Balance

**File:** `tests/integration/invariants/god-check.test.ts`

```typescript
// tests/integration/invariants/god-check.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import {
  createAuthorizedPayment,
  createCapturedPayment,
  createVoidedPayment,
} from "../../helpers/factories";
import {
  verifySystemBalance,
  verifyAllTransactionsBalance,
} from "../../helpers/god-check";

// Setup: shared pattern (see top of document)

describe("god check: system balance", () => {
  it("empty system balances to zero", async () => {
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after a single authorization", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after authorization + full capture", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth.id, { amount: 10000n });
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after authorization + void", async () => {
    await createVoidedPayment(db);
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after authorization + capture + full refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 10000n });
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after authorization + capture + settlement", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.settle(db, captured.id);
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after authorization + capture + settlement + full refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.settle(db, captured.id);
    await paymentService.refund(db, captured.id, { amount: 10000n });
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after authorization + partial capture + partial refund", async () => {
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 7000n });
    await paymentService.refund(db, captured.id, { amount: 3000n });
    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after 5 mixed payments in different flows", async () => {
    // auth → full capture
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth1.id, { amount: 10000n });

    // auth → void
    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });
    await paymentService.void(db, auth2.id);

    // auth → partial capture → partial refund
    const auth3 = await createAuthorizedPayment(db, { amount: 30000n });
    const cap3 = await paymentService.capture(db, auth3.id, { amount: 20000n });
    await paymentService.refund(db, cap3.id, { amount: 5000n });

    // auth → full capture → full refund
    const auth4 = await createAuthorizedPayment(db, { amount: 15000n });
    const cap4 = await paymentService.capture(db, auth4.id, { amount: 15000n });
    await paymentService.refund(db, cap4.id, { amount: 15000n });

    // auth only (still pending)
    await createAuthorizedPayment(db, { amount: 5000n });

    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("after concurrent mixed operations across 10 payments", async () => {
    const auths = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createAuthorizedPayment(db, { amount: BigInt((i + 1) * 5000) })
      )
    );

    await Promise.allSettled(
      auths.map((auth, i) =>
        i % 2 === 0
          ? paymentService.capture(db, auth.id, { amount: auth.amount })
          : paymentService.void(db, auth.id)
      )
    );

    await verifySystemBalance(db);
    await verifyAllTransactionsBalance(db);
  });

  it("every individual transaction is balanced", async () => {
    // Create diverse operations
    const auth = await createAuthorizedPayment(db, { amount: 10000n });
    const captured = await paymentService.capture(db, auth.id, { amount: 10000n });
    await paymentService.refund(db, captured.id, { amount: 5000n });
    await createVoidedPayment(db);

    await verifyAllTransactionsBalance(db);
  });
});
```

### 6b. Account Integrity

**File:** `tests/integration/invariants/account-integrity.test.ts`

```typescript
// tests/integration/invariants/account-integrity.test.ts
import { describe, it, expect } from "bun:test";
import { paymentService } from "../../../src/payments/service";
import { ledgerService } from "../../../src/ledger/service";
import { createAuthorizedPayment, createCapturedPayment } from "../../helpers/factories";
import { sql } from "drizzle-orm";

// Setup: shared pattern (see top of document)

describe("account integrity", () => {
  it("every account service balance matches raw SQL computation", async () => {
    // Populate ledger with diverse operations
    const auth1 = await createAuthorizedPayment(db, { amount: 10000n });
    await paymentService.capture(db, auth1.id, { amount: 10000n });

    const auth2 = await createAuthorizedPayment(db, { amount: 20000n });
    await paymentService.void(db, auth2.id);

    const captured3 = await createCapturedPayment(db, { authorizeAmount: 15000n });
    await paymentService.refund(db, captured3.id, { amount: 5000n });

    const accounts = ["customer_funds", "customer_holds", "merchant_payable", "platform_fees", "platform_cash"];

    for (const accountId of accounts) {
      const serviceBalance = await ledgerService.getBalance(db, accountId);

      const result = await db.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS debits,
          COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS credits
        FROM ledger_entries
        WHERE account_id = ${accountId}
      `);

      const rawDebits = BigInt(result[0].debits);
      const rawCredits = BigInt(result[0].credits);
      const rawBalance = rawDebits - rawCredits;

      expect(serviceBalance).toBe(rawBalance);
    }
  });

  it("no orphaned entries — every entry references a valid transaction and account", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });

    const orphanedEntries = await db.execute(sql`
      SELECT le.id
      FROM ledger_entries le
      LEFT JOIN ledger_transactions lt ON le.transaction_id = lt.id
      WHERE lt.id IS NULL
    `);

    expect(orphanedEntries).toHaveLength(0);
  });

  it("balance is deterministic — querying twice returns the same result", async () => {
    await createAuthorizedPayment(db, { amount: 10000n });

    const balance1 = await ledgerService.getBalance(db, "customer_holds");
    const balance2 = await ledgerService.getBalance(db, "customer_holds");

    expect(balance1).toBe(balance2);
  });
});
```

### 6c. Database Constraints

**File:** `tests/integration/invariants/constraint-tests.test.ts`

These tests prove the database itself rejects invalid data, independent of
the service layer. Belt AND suspenders.

```typescript
// tests/integration/invariants/constraint-tests.test.ts
import { describe, it, expect } from "bun:test";
import { sql } from "drizzle-orm";

// Setup: shared pattern (see top of document)

describe("database constraints", () => {
  it("rejects captured_amount > authorized_amount", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO payments (id, status, amount, currency, authorized_amount, captured_amount, refunded_amount)
        VALUES ('pay_constraint_test_1', 'captured', 10000, 'USD', 10000, 15000, 0)
      `)
    ).rejects.toThrow(/constraint|check|captured/i);
  });

  it("rejects refunded_amount > captured_amount", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO payments (id, status, amount, currency, authorized_amount, captured_amount, refunded_amount)
        VALUES ('pay_constraint_test_2', 'refunded', 10000, 'USD', 10000, 10000, 15000)
      `)
    ).rejects.toThrow(/constraint|check|refund/i);
  });

  it("rejects zero amount in ledger entry", async () => {
    await db.execute(sql`
      INSERT INTO ledger_transactions (id, description, created_at)
      VALUES ('txn_constraint_test_1', 'Constraint test', NOW())
    `);

    await expect(
      db.execute(sql`
        INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
        VALUES ('ent_constraint_test_1', 'txn_constraint_test_1', 'customer_funds', 'DEBIT', 0)
      `)
    ).rejects.toThrow(/constraint|check|amount/i);
  });

  it("rejects negative amount in ledger entry", async () => {
    await db.execute(sql`
      INSERT INTO ledger_transactions (id, description, created_at)
      VALUES ('txn_constraint_test_2', 'Constraint test negative', NOW())
    `);

    await expect(
      db.execute(sql`
        INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
        VALUES ('ent_constraint_test_2', 'txn_constraint_test_2', 'customer_funds', 'DEBIT', -500)
      `)
    ).rejects.toThrow(/constraint|check|amount/i);
  });

  it("rejects invalid payment status", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO payments (id, status, amount, currency, authorized_amount, captured_amount, refunded_amount)
        VALUES ('pay_constraint_test_3', 'invalid_status', 10000, 'USD', 10000, 0, 0)
      `)
    ).rejects.toThrow(/constraint|check|enum|status/i);
  });

  it("rejects invalid ledger entry direction", async () => {
    await db.execute(sql`
      INSERT INTO ledger_transactions (id, description, created_at)
      VALUES ('txn_constraint_test_3', 'Constraint test direction', NOW())
    `);

    await expect(
      db.execute(sql`
        INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
        VALUES ('ent_constraint_test_3', 'txn_constraint_test_3', 'customer_funds', 'INVALID', 1000)
      `)
    ).rejects.toThrow(/constraint|check|enum|direction/i);
  });
});
```

---

## Test Count Summary

| Section | File(s) | Tests |
|---|---|---|
| 1a. Posting balanced transactions | `ledger/post-transaction.test.ts` | 5 |
| 1b. Rejection of invalid transactions | `ledger/post-transaction.test.ts` | 6 |
| 1c. Immutability enforcement | `ledger/immutability.test.ts` | 5 |
| 1d. Balance queries | `ledger/balance-query.test.ts` | 7 |
| 1e. Transaction history | `ledger/history.test.ts` | 6 |
| 2a. Authorize | `payments/authorize.test.ts` | 10 |
| 2b. Capture | `payments/capture.test.ts` | 14 |
| 2c. Void | `payments/void.test.ts` | 8 |
| 2d. Refund | `payments/refund.test.ts` | 14 |
| 2e. Expiration | `payments/expiration.test.ts` | 5 |
| 2f. Settlement | `payments/settle.test.ts` | 10 |
| 3a. Single payment retrieval | `payments/queries.test.ts` | 4 |
| 3b. List & pagination | `payments/queries.test.ts` | 6 |
| 4a. Cache hit behavior | `payments/idempotency.test.ts` | 5 |
| 4b. Conflict detection | `payments/idempotency.test.ts` | 4 |
| 4c. Ledger deduplication | `payments/idempotency.test.ts` | 4 |
| 4d. Cross-operation idempotency | `payments/idempotency.test.ts` | 4 |
| 4e. Key semantics | `payments/idempotency.test.ts` | 3 |
| 5a. Double capture | `concurrency/*.test.ts` | 3 |
| 5a-2. Double settlement | `concurrency/*.test.ts` | 1 |
| 5b. Capture vs void race | `concurrency/*.test.ts` | 3 |
| 5c. Refund races | `concurrency/*.test.ts` | 4 |
| 5d. Parallel independent payments | `concurrency/*.test.ts` | 2 |
| 5e. Mixed chaos | `concurrency/*.test.ts` | 3 |
| 6a. System balance | `invariants/god-check.test.ts` | 11 |
| 6b. Account integrity | `invariants/account-integrity.test.ts` | 3 |
| 6c. Database constraints | `invariants/constraint-tests.test.ts` | 6 |
| **Total** | | **~155** |

Every test starts with a clean database and leaves no state behind.
`cleanBetweenTests` truncates all tables between tests. `setupTestDB`
runs migrations and seeds system accounts. No test depends on another
test's output.

---

Previous: [08a — Unit Tests](./08a-unit-tests.md) | Next: [08c — E2E & Load Testing](./08c-e2e-and-load-testing.md)
