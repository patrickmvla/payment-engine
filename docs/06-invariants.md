# Invariants & Business Rules — The Laws That Must Never Break

An invariant is a condition that must ALWAYS be true, no matter what. If any of
these are violated, the system is in a corrupt state. These are the rules you'd
wake someone up at 3am for if they broke.

---

## The Invariants

### 1. Every Ledger Transaction Must Balance

```
For every transaction:
  SUM(debit amounts) == SUM(credit amounts)
```

**Why:** This is the fundamental law of double-entry bookkeeping. If debits
don't equal credits, money has been created from nothing or destroyed. Both are
catastrophic.

**Enforced at:**
- Application level: `postTransaction()` validates before inserting
- Test level: Every test that creates a transaction verifies this

**What happens if violated:** `LedgerImbalanceError` — the entire transaction
is rolled back. This error should never reach production. If it does, it's a
bug in our code, not a user error.

---

### 2. Ledger Entries Are Immutable

```
No UPDATE or DELETE on ledger_entries. Ever.
No UPDATE or DELETE on ledger_transactions. Ever.
```

**Why:** The audit trail must be tamper-proof. If entries can be modified, you
can't prove what happened. Regulators, auditors, and reconciliation all depend
on immutability.

**Enforced at:**
- Application level: No update/delete functions exist for these tables
- Database level: Can be enforced with a trigger (optional but recommended)

**To correct a mistake:** Create a new reversing transaction. The original entry
remains in the record, and the correction is visible.

```
Original (wrong):
  DEBIT  customer_holds   $100
  CREDIT customer_funds   $100

Correction:
  DEBIT  customer_funds   $100   ← reverse the original
  CREDIT customer_holds   $100

New (correct):
  DEBIT  customer_holds   $75    ← the right amount
  CREDIT customer_funds   $75
```

All three transactions exist in the ledger. The audit trail is complete.

---

### 3. Payment State Transitions Follow The State Machine

```
A payment can only move through valid transitions.
No skipping. No going backwards.
```

**Valid transitions:**

| From | Allowed To |
|---|---|
| `created` | `authorized` |
| `authorized` | `captured`, `voided`, `expired` |
| `captured` | `settled`, `refunded`, `partially_refunded` |
| `settled` | `refunded`, `partially_refunded` |
| `partially_refunded` | `refunded`, `partially_refunded` |
| `voided` | (terminal — nothing) |
| `expired` | (terminal — nothing) |
| `refunded` | (terminal — nothing) |

> **Note:** `created` is a transient internal state that exists only within
> the authorize transaction. The API never returns a payment in `created`
> status — it either completes as `authorized` or the transaction rolls back.
> Therefore, `created → expired` is not possible: only `authorized` payments
> can expire.

**Invalid examples:**
- `authorized → refunded` (can't refund what wasn't captured)
- `captured → authorized` (can't go backwards)
- `voided → captured` (voided is terminal)

**Enforced at:**
- Application level: `validateTransition(currentStatus, newStatus)` throws
  `InvalidStateTransitionError` on violation
- Every service method checks current status before proceeding

---

### 4. Amounts Are Always Positive Integers

```
All money amounts > 0 (for entries)
All money amounts >= 0 (for payment tracking fields)
No floating point. No negative amounts in entries.
```

**Why:**
- Floating point math loses money: `0.1 + 0.2 !== 0.3`
- Negative amounts in entries create ambiguity (is -100 credit a debit?)
- Direction (DEBIT/CREDIT) handles sign, not the amount itself

**Enforced at:**
- Database level: `CHECK (amount > 0)` on ledger_entries
- Application level: Zod validation rejects non-positive integers
- Type level: TypeScript `bigint` prevents float contamination

---

### 5. Capture Cannot Exceed Authorization

```
captured_amount <= authorized_amount
```

**Why:** You can't take more money than was reserved. The customer only
authorized a specific amount.

**Enforced at:**
- Database level: `CHECK (captured_amount <= authorized_amount)`
- Application level: `capture()` checks before proceeding

**Example:**
```
authorized_amount = 10000 ($100)
Capture $70 → captured_amount = 7000 ✓
Capture $40 → 7000 + 4000 = 11000 > 10000 ✗ REJECTED
Capture $30 → 7000 + 3000 = 10000 ✓
```

---

### 6. Refund Cannot Exceed Capture

```
refunded_amount <= captured_amount
```

**Why:** You can't return more money than was taken.

**Enforced at:**
- Database level: `CHECK (refunded_amount <= captured_amount)`
- Application level: `refund()` checks before proceeding

**Example:**
```
captured_amount = 7000 ($70)
Refund $30 → refunded_amount = 3000 ✓
Refund $50 → 3000 + 5000 = 8000 > 7000 ✗ REJECTED
Refund $40 → 3000 + 4000 = 7000 ✓ (fully refunded)
```

---

### 7. Idempotency Keys Are Honored

```
Same key + same parameters = same response (no duplicate processing)
Same key + different parameters = 409 Conflict error
```

**Why:** Networks are unreliable. Clients retry. Without idempotency, every
retry is a potential duplicate charge.

**Enforced at:**
- Middleware level: Checked before request reaches service layer
- Database level: `PRIMARY KEY` on idempotency_keys prevents duplicates

**The critical subtlety:** We don't just check if the key exists. We verify
that the request parameters match. If someone reuses a key with different
parameters, that's a client bug, and we reject it loudly.

---

### 8. Concurrent Operations Are Serialized Per Payment

```
Two concurrent operations on the same payment must not corrupt state.
```

**Why:** Two simultaneous capture requests on the same authorization could both
read `status = authorized` and both attempt to capture, resulting in a double
charge.

**Enforced at:**
- Database level: `SELECT ... FOR UPDATE` locks the payment row
- The second concurrent request waits until the first completes

**Example of what could go wrong without locking:**

```
Thread A: SELECT * FROM payments WHERE id = 'pay_1'  → status = authorized
Thread B: SELECT * FROM payments WHERE id = 'pay_1'  → status = authorized
Thread A: UPDATE payments SET status = 'captured'     → succeeds
Thread B: UPDATE payments SET status = 'captured'     → ALSO succeeds (double capture!)
```

**With FOR UPDATE:**

```
Thread A: SELECT * FROM payments WHERE id = 'pay_1' FOR UPDATE  → gets lock
Thread B: SELECT * FROM payments WHERE id = 'pay_1' FOR UPDATE  → WAITS
Thread A: UPDATE, COMMIT → releases lock
Thread B: SELECT returns status = 'captured' → rejects (409 Conflict)
```

---

### 9. Account Balances Are Derived, Not Stored

```
balance = f(ledger_entries) — not a stored column
```

**Why:**
- A stored balance can drift from reality if entries are missed
- Deriving from entries means the balance is always provably correct
- You can compute the balance at any point in time

**The tradeoff:** Computing balances requires summing entries, which gets slower
as entries grow. Solutions (for v2):
- Materialized balance snapshots (periodically computed, with a timestamp)
- Balance cache with invalidation
- Partial aggregation (sum entries since last snapshot)

For v1, direct computation is fine. We won't have millions of entries.

---

### 10. No Money Is Created or Destroyed

```
SUM of all account balances across the entire system == 0
```

**Why:** This is the ultimate check. Money enters the system (customer deposits)
and exits (merchant payouts). At any given moment, the total of all debits ever
recorded must equal the total of all credits. If they don't, money was created
or destroyed — a critical bug.

**Enforced at:**
- Test level: Integration tests verify system-wide balance after flows
- This is the "god check" — if this fails, everything stops

---

### 11. Authorization Hold Is Fully Released

```
After capture, void, or expiration:
  customer_holds balance for that payment == 0
```

**Why:** Partial capture ($70 of $100 authorization) still releases the
**entire** $100 hold. The hold is reversed as a complete unit, then only the
captured amount is charged. If the hold isn't fully released, the customer's
available funds are permanently reduced.

**Enforced at:**
- Application level: Capture always creates hold-reversal entries for the
  full authorized amount, regardless of capture amount
- Test level: `holdsBalance === 0n` after every capture, void, and expiration

---

### 12. Authorization Expiry Is Enforced

```
If NOW() > payment.expires_at AND status == 'authorized':
  Payment cannot be captured or voided.
  Hold must be released.
```

**Why:** Holds cannot persist indefinitely. If a merchant never captures, the
customer's funds must be freed. The default expiry is **7 days** from
authorization, matching industry standard for card authorizations.

**Enforced at:**
- Application level: `capture()` and `void()` check `expires_at` before
  proceeding. Expired payments transition to `expired` status.
- The expiry mechanism is **on-access** in v1 — checked when an operation is
  attempted on an expired payment. A background job for proactive expiry is
  a v2 enhancement.

---

## Summary: Defense in Depth

Each invariant is enforced at multiple levels:

```
┌──────────────────────────────────────────┐
│ Type System (TypeScript)                 │  Compile time
│   bigint for money, enums for status     │
├──────────────────────────────────────────┤
│ Validation (Zod)                         │  Request time
│   amount > 0, currency is valid, etc.    │
├──────────────────────────────────────────┤
│ Application Logic (Services)             │  Runtime
│   State machine, balance checks, locks   │
├──────────────────────────────────────────┤
│ Database Constraints (PostgreSQL)        │  Storage time
│   CHECK, FK, UNIQUE, FOR UPDATE          │
├──────────────────────────────────────────┤
│ Tests (bun:test)                         │  Build time
│   Every invariant has a test             │
└──────────────────────────────────────────┘
```

If an invariant passes through one layer uncaught, the next layer catches it.
This is not paranoia — it's how you build systems that handle real money.

---

Previous: [05 — API Design](./05-api-design.md) | Next: [07 — API Standards](./07-api-standards.md)
