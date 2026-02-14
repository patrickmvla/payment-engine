# Core Concepts — Understanding Money From The Ground Up

Before writing a single line of code, you need to understand how money actually
moves, how it's tracked, and why financial systems are built the way they are.

---

## 1. The Problem: Why Can't We Just Use a Balance Field?

The naive approach to tracking money:

```
users table
├── id
├── name
└── balance: 5000  ← just increment/decrement this
```

This breaks in every way that matters:

- **No audit trail** — If a balance is wrong, how do you figure out why? You
  can't. The history is gone.
- **No accountability** — Who changed it? When? Was it a payment, a refund, a
  manual adjustment? You have no idea.
- **Race conditions** — Two concurrent requests both read `balance = 5000`, both
  subtract 3000, both write 2000. You just lost $3000.
- **No reconciliation** — You can't verify your records against a bank statement
  because you don't have records, you have a number.

Every financial disaster, every misplaced dollar, every audit failure traces back
to systems that treated money as "just a number in a column."

---

## 2. Double-Entry Bookkeeping

This is the solution humanity invented in the 1400s. It's still the foundation
of every financial system on earth. Here's why.

### The Core Rule

> **Every financial movement must be recorded in at least two places.**
> Every debit has a matching credit. They always balance.

This isn't a suggestion. It's an invariant. If your books don't balance, money
has either been created from nothing or vanished. Both are catastrophic.

### Debits and Credits

Forget the everyday meaning of these words. In accounting:

| Account Type | Debit (increases) | Credit (increases) |
|---|---|---|
| **Asset** (cash, receivables) | ← Debit | |
| **Expense** (fees, costs) | ← Debit | |
| **Liability** (what you owe) | | Credit → |
| **Revenue** (income) | | Credit → |
| **Equity** (owner's value) | | Credit → |

The rule: **Assets + Expenses = Liabilities + Revenue + Equity**

This is the accounting equation. It must always hold. If it doesn't, something
is wrong.

### A Real Example

A customer pays $100 for a service:

```
Entry 1: DEBIT   Cash (Asset)          $100   ← cash came in
Entry 2: CREDIT  Revenue (Income)      $100   ← we earned it
```

Both sides equal $100. The books balance.

Now the customer wants a $30 refund:

```
Entry 3: DEBIT   Revenue (Income)      $30    ← reverse part of the income
Entry 4: CREDIT  Cash (Asset)          $30    ← cash went out
```

Still balanced. And now you have a complete, auditable history of exactly what
happened and why.

### Why This Matters For Your Payment Engine

Your ledger is the **source of truth**. Every payment, refund, fee, settlement —
they're all just entries in the ledger. The balance isn't stored; it's
**computed** from the sum of all entries.

```
balance = SUM(debits) - SUM(credits)   -- for asset accounts
balance = SUM(credits) - SUM(debits)   -- for liability accounts
```

This means:
- You can reconstruct the balance at any point in time
- You can explain every cent
- You can prove your records are correct
- You never lose history

---

## 3. Chart of Accounts

A "chart of accounts" is just the list of buckets where money can sit. For our
payment engine, we need:

```
ASSETS
├── customer_holds         — Authorized but uncaptured funds
└── platform_cash          — Our operating funds

LIABILITIES
├── customer_funds         — Money customers deposited with us (we owe it back)
└── merchant_payable       — Money we owe to merchants after capture

REVENUE
└── platform_fees          — Our cut from transactions (3% of captured amount)
```

Five accounts. `customer_funds` is a liability because it's money the platform
holds on behalf of customers — the platform owes it back (same reason your bank
balance is a liability on the bank's books). `customer_holds` is an asset
because the hold represents value the platform controls until capture or void.

When a payment moves through the system, money flows between these accounts.
The total across all accounts always nets to zero.

---

## 4. Transactions and Entries

**Transaction**: A logical financial event (e.g., "Customer paid $100")
**Entries**: The individual debit/credit lines within that transaction

```
Transaction: "Payment #PAY_001 authorized"
├── Entry: DEBIT   customer_holds    $100
└── Entry: CREDIT  customer_funds    $100

Transaction: "Payment #PAY_001 captured"
├── Entry: DEBIT   customer_funds    $100   (reverse hold via debit on liability)
├── Entry: CREDIT  customer_holds    $100   (release hold)
├── Entry: DEBIT   customer_funds    $97    (actual charge minus fee)
├── Entry: CREDIT  merchant_payable  $97    (merchant gets their share)
├── Entry: DEBIT   customer_funds    $3     (fee portion)
└── Entry: CREDIT  platform_fees     $3     (our revenue)
```

Every transaction must have entries that sum to zero (total debits = total
credits). This is enforced at the code level and at the database level. No
exceptions.

---

## 5. Immutability

**You never edit or delete a ledger entry. Ever.**

Made a mistake? You don't go back and change it. You create a new transaction
that reverses it. This is called a "correcting entry" or "reversal."

Why?
- **Audit trail** — Regulators and auditors need to see what actually happened,
  including the mistakes.
- **Reconciliation** — If records can change, you can't compare them against
  external statements.
- **Trust** — An immutable ledger is provably correct. A mutable one requires
  trust.

In our system, ledger entries are INSERT-only. No UPDATE. No DELETE.

---

## 6. Money Representation

**Never use floating point for money.**

```typescript
// WRONG — will lose money
0.1 + 0.2 = 0.30000000000000004

// RIGHT — use integer cents (or the smallest currency unit)
10 + 20 = 30  // represents $0.30
```

We store all amounts as **integers in the smallest currency unit**:
- USD: cents (1 dollar = 100)
- JPY: yen (no subunit, 1 yen = 1)
- BHD: fils (1 dinar = 1000)

In TypeScript, we use `bigint` to avoid any floating point contamination:

```typescript
const amount = 1050n  // $10.50
```

---

## 7. Idempotency

> If I accidentally send the same payment request twice, the customer should
> only be charged once.

Idempotency means: **performing the same operation multiple times produces the
same result as performing it once.**

How it works:
1. The client sends a unique `idempotency_key` with every request
2. Before processing, we check if we've seen this key before
3. If yes → return the original result (don't process again)
4. If no → process and store the result keyed to that idempotency key

This is critical because:
- Networks are unreliable. Requests get retried.
- Users double-click buttons.
- Webhooks can fire more than once.

Without idempotency, every retry is a potential duplicate charge. With it, your
system is safe to retry indefinitely.

---

## 8. ACID and Why It Matters Here

ACID is a set of database guarantees. For financial systems, every letter
matters:

**Atomicity** — A transaction (DB transaction) either fully completes or fully
rolls back. You can't debit one account and fail to credit another. That would
create or destroy money.

**Consistency** — The database moves from one valid state to another. Your
constraints (balances can't go negative, entries must balance) are always
enforced.

**Isolation** — Concurrent transactions don't interfere with each other. Two
simultaneous payments can't both read the same balance and cause an overdraft.

**Durability** — Once a transaction commits, it's permanent. Even if the server
crashes, the data survives.

This is why we use PostgreSQL. It gives us all four guarantees. Document
databases, eventual-consistency stores, and in-memory caches do not.

---

## 9. State Machines

Payments don't just have a "status" — they follow a strict state machine:

```
                    ┌──────────┐
                    │ CREATED  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
               ┌────│AUTHORIZED│────┐
               │    └────┬─────┘    │
               │         │          │
          ┌────▼───┐┌────▼────┐┌────▼────┐
          │ VOIDED ││CAPTURED ││ EXPIRED │
          └────────┘└────┬────┘└─────────┘
                         │
                    ┌────▼────┐
                    │ SETTLED │
                    └────┬────┘
                         │
               ┌─────────┼─────────┐
               │                    │
          ┌────▼──────┐    ┌───────▼────────┐
          │  REFUNDED │    │PARTIALLY_REFUND│
          └───────────┘    └────────────────┘
```

Rules:
- You can only move forward along valid transitions
- `AUTHORIZED → REFUNDED` is **not valid** (you can't refund what wasn't captured)
- `CAPTURED → AUTHORIZED` is **not valid** (you can't go backwards)
- `VOIDED → anything` is **not valid** (voided is terminal)

These transitions are enforced in code. Invalid state changes throw errors.

---

## Summary

| Concept | Why It Matters |
|---|---|
| Double-entry bookkeeping | Every cent is accounted for, always |
| Chart of accounts | Organizes where money sits |
| Immutability | You can prove what happened |
| Integer money | No floating point errors |
| Idempotency | No duplicate charges |
| ACID guarantees | No money created or destroyed |
| State machines | No invalid payment transitions |

These aren't optional nice-to-haves. They're the non-negotiable foundation.
Everything we build sits on top of these concepts.

For the complete mathematical trace of every cent through the system —
including industry comparisons with Stripe, TigerBeetle, and Modern
Treasury — see [18 — Accounting Model](./18-accounting-model.md).

---

Next: [02 — Payment Lifecycle](./02-payment-lifecycle.md)
