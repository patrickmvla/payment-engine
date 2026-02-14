# Accounting Model — How The Industry Does It, How We Do It, Why

This document is the mathematical proof that our payment engine tracks money
the same way Stripe, Adyen, and Square do internally. Not the API surface —
the accounting model underneath. Every account, every entry direction, every
fee split, every edge case.

If a fintech CTO asks "why did you model it this way?" — this is the answer.

---

## 1. How Real Payment Processors Model Money

We studied the accounting models of production financial systems before
designing ours. Here's what they all share.

### Stripe's Ledger

Stripe built **Ledger**, an immutable append-only log that tracks every cent
moving through their system.

Key facts (from their engineering blog):
- Processes **5 billion events daily**
- Each completed payment generates **~100 Ledger events**
- Uses **clearing accounts** — intermediate accounts that should be zero at
  steady state. A non-zero clearing account means something is stuck.
- **Balance Transaction** model: every charge creates a balance transaction
  with `amount` (gross), `fee` (Stripe's cut), and `net` (what the merchant
  gets). Refunds create **separate** balance transactions — the original is
  never modified.
- Idempotency keys: 255 characters, 24-hour TTL, saves status code + body.

The design principle: **immutable events, derived state.** You never update
a ledger record. You create new events. Balances are computed, not stored.

### TigerBeetle

A purpose-built financial accounting database. Their model uses **two-phase
transfers**:

- **Phase 1 (Pending):** Money moves to `debits_pending` / `credits_pending`.
  The posted balance is untouched.
- **Phase 2a (Post):** Pending amount moves to posted. Can post a partial
  amount — remainder returns to source automatically.
- **Phase 2b (Void):** Pending amount returns to source. Hold is released.

Each account tracks four balances: `debits_pending`, `debits_posted`,
`credits_pending`, `credits_posted`. This maps directly to authorization holds.

### Modern Treasury

Their ledger tracks **three balance types** per account:

| Balance Type | Formula | Meaning |
|---|---|---|
| **Posted** | SUM(posted entries) | Finalized, settled funds |
| **Pending** | Posted + pending entries | Includes expected-but-unfinished |
| **Available** | Posted - pending debits | What you can actually spend |

This is the industry standard for any system that handles authorization holds.

### Formance (Numscript)

Uses a DSL for financial transactions with native percentage-based splitting:

```
send [USD 100] (
  source = @customer
  destination = {
    97% to @merchant
    remaining to @platform:fees
  }
)
```

The `remaining` keyword handles rounding — the last recipient absorbs any
integer truncation. This eliminates the rounding problem entirely.

### What They All Share

| Pattern | Stripe | TigerBeetle | Modern Treasury | Us |
|---|---|---|---|---|
| Double-entry (debits = credits) | Yes | Yes | Yes | Yes |
| Immutable entries | Yes | Yes | Yes | Yes |
| Balance is derived, not stored | Yes | Yes | Yes | Yes |
| Authorization = pending state | Yes | Yes (pending) | Yes (pending) | Yes (hold account) |
| Fee split at capture time | Yes | Via linked transfers | Via multi-entry | Yes |
| Refund = new entries (not modify) | Yes | Yes | Yes | Yes |
| Idempotency | 24h TTL | Transfer ID | Built-in | 24h TTL |
| Clearing accounts (should be zero) | Yes | Yes | Yes | Yes (customer_holds) |

Our model is not novel. It's the industry consensus, implemented correctly.

---

## 2. Our Chart of Accounts — Justified

Five accounts. Each one exists because a real payment processor needs it.

```
ASSETS (increase with DEBIT)
├── customer_holds         — Authorized but uncaptured funds
└── platform_cash          — Our operating funds (used in settlement)

LIABILITIES (increase with CREDIT)
├── customer_funds         — Money the platform owes back to customers
└── merchant_payable       — Money the platform owes to merchants

REVENUE (increase with CREDIT)
└── platform_fees          — Transaction fees earned (3% of captured amount)
```

### Why customer_funds Is a LIABILITY

This confuses people who think "customer funds" should be an asset. It's not.

Your bank account balance is a **liability on the bank's books**. The bank
owes you that money. When you deposit $500, the bank records:

```
DEBIT   bank_vault (asset)     $500   ← cash came in
CREDIT  customer_deposits (liability)  $500   ← we owe it back
```

Our platform is the bank in this analogy. When a customer authorizes a
payment, we're saying "we hold $100 of the customer's money and owe it back
if the payment is voided or expires." That's a liability.

**Stripe models this the same way.** Their `charge_undisbursed` account is a
liability — money they hold on behalf of merchants until settlement.

### Why customer_holds Is an ASSET

When a customer authorizes $100, the platform **controls** those funds. The
customer can't spend them elsewhere. The platform decides whether to capture
(charge) or void (release). Control over a resource = asset.

This maps to TigerBeetle's `debits_pending` — funds reserved but not yet
posted.

### customer_holds Is a Clearing Account

**Clearing account**: an intermediate account that should be zero at steady
state. Money passes through it but doesn't stay.

- Authorization creates a position in customer_holds
- Capture, void, or expiry clears that position back to zero

At any point in time, `customer_holds` balance = sum of all outstanding
(uncaptured, un-voided, un-expired) authorization amounts. If no
authorizations are pending, customer_holds = 0.

**Stripe's clearing pattern:** "A single missing, late, or incorrect
transaction immediately creates a detectable accuracy issue with a simple
query — find the clearing accounts with nonzero balance."

We enforce this as Invariant #11: after capture, void, or expiry,
customer_holds balance for that payment = 0.

### Why platform_cash Exists

`platform_cash` records money that has left the platform — merchant
disbursements. When a captured payment is settled:

```
DEBIT   merchant_payable   [merchant_share]   ← we no longer owe the merchant
CREDIT  platform_cash      [merchant_share]   ← money flowed out
```

After settlement, `merchant_payable` for that payment is zero.
`platform_cash` shows a negative balance (outflow). In a complete system,
`platform_cash` would be funded by initial deposits or accumulated fee
revenue. The negative balance is not an error — it's a record of
disbursement.

**After auth + capture + settle:**
- `customer_holds`: 0 (cleared at capture)
- `customer_funds`: negative (customer was charged)
- `merchant_payable`: 0 (discharged at settlement)
- `platform_fees`: positive (our revenue)
- `platform_cash`: negative (we paid the merchant)

---

## 3. Complete Money Flow — Every Cent Traced

Starting from zero. All amounts in cents. 3% platform fee.

### Authorization ($100.00 = 10000 cents)

```
Transaction: "Authorize $100.00 for pay_01HX..."
  DEBIT   customer_holds    10000
  CREDIT  customer_funds    10000
  ─────────────────────────────
  Debits: 10000  Credits: 10000  ✓
```

| Account | Type | Balance | Meaning |
|---|---|---|---|
| customer_holds | ASSET | +10000 | We control $100 |
| customer_funds | LIABILITY | +10000 | We owe customer $100 back |

**Accounting equation:** Assets (10000) = Liabilities (10000). Holds.

**What the customer sees:** "Pending $100" on their statement. Money is
reserved, not charged.

### Capture ($100.00, full)

Six entries. First two reverse the hold, next four charge the customer and
split between merchant and platform.

```
Transaction: "Capture $100.00 for pay_01HX..."
  DEBIT   customer_funds    10000   ← undo auth credit (reduce liability)
  CREDIT  customer_holds    10000   ← undo auth debit (release hold)
  DEBIT   customer_funds     9700   ← charge customer (merchant share)
  CREDIT  merchant_payable   9700   ← we owe merchant
  DEBIT   customer_funds      300   ← charge customer (platform fee)
  CREDIT  platform_fees       300   ← our revenue
  ──────────────────────────────────
  Debits: 20000  Credits: 20000  ✓
```

| Account | Debits | Credits | Balance | Meaning |
|---|---|---|---|---|
| customer_holds | 10000 | 10000 | **0** | Hold fully released (clearing account cleared) |
| customer_funds | 20000 | 10000 | **-10000** | Customer charged $100 net |
| merchant_payable | 0 | 9700 | **+9700** | We owe merchant $97 |
| platform_fees | 0 | 300 | **+300** | We earned $3 |

**customer_funds = -10000.** A negative liability means the customer has been
charged. Think of it as: we owed them $10000 (the auth), then we collected
$20000 from them (the capture debits), net = -$10000. They paid $100.

**Accounting equation:** Assets (0) = Liabilities (-10000 + 9700) + Revenue
(300) = -300 + 300 = 0. Holds.

**What the customer sees:** "Charged $100.00" on their statement.

### Void (alternative path from authorized)

```
Transaction: "Void pay_01HX..."
  DEBIT   customer_funds    10000   ← undo auth credit
  CREDIT  customer_holds    10000   ← undo auth debit
  ──────────────────────────────────
  Debits: 10000  Credits: 10000  ✓
```

All accounts return to zero. **Exact mirror of authorization.** The customer's
hold is released. No money charged. No fees taken.

### Full Refund ($100.00, after capture)

The refund reverses the capture split. The merchant returns their share, the
platform returns the fee. The customer is made whole.

```
Transaction: "Refund $100.00 for pay_01HX..."
  DEBIT   merchant_payable   9700   ← merchant returns their share
  CREDIT  customer_funds     9700   ← customer gets merchant portion back
  DEBIT   platform_fees       300   ← platform returns fee
  CREDIT  customer_funds      300   ← customer gets fee portion back
  ──────────────────────────────────
  Debits: 10000  Credits: 10000  ✓
```

| Account | Balance | |
|---|---|---|
| customer_holds | **0** | |
| customer_funds | **0** | Customer fully refunded |
| merchant_payable | **0** | |
| platform_fees | **0** | |

**Everything nets to zero.** Full lifecycle proven: auth → capture → refund
returns the system to its initial state.

### Partial Capture ($70.00 of $100.00 auth)

The hold is released in full (the entire $100), then only the captured amount
($70) is charged. The remaining $30 was never charged — no separate "release
excess" transaction needed.

```
Fee = (7000 × 3) / 100 = 210 cents ($2.10)
Merchant share = 7000 - 210 = 6790 cents ($67.90)

Transaction: "Capture $70.00 for pay_01HX..."
  DEBIT   customer_funds    10000   ← release FULL hold (not $70)
  CREDIT  customer_holds    10000   ← full hold released
  DEBIT   customer_funds     6790   ← charge customer (merchant share of $70)
  CREDIT  merchant_payable   6790
  DEBIT   customer_funds      210   ← charge customer (3% fee of $70)
  CREDIT  platform_fees       210
  ──────────────────────────────────
  Debits: 17000  Credits: 17000  ✓
```

| Account | Balance | |
|---|---|---|
| customer_holds | **0** | Full hold released, not just $70 |
| customer_funds | **-7000** | Customer charged exactly $70 |
| merchant_payable | **+6790** | |
| platform_fees | **+210** | |

The remaining $30 vanishes naturally: the auth created a $100 liability
(customer_funds = +10000), the capture debited $100 to reverse it, then
debited $70 more to charge. Net: -7000. The $30 was never taken.

### Partial Refund ($30.00 of $70.00 captured)

**The rule:** the refund amount is split using the same fee rate as the
original capture (3%). This is proportional reversal.

```
Fee refund = (3000 × 3) / 100 = 90 cents ($0.90)
Merchant refund = 3000 - 90 = 2910 cents ($29.10)

Transaction: "Refund $30.00 for pay_01HX..."
  DEBIT   merchant_payable   2910   ← merchant returns proportional share
  CREDIT  customer_funds     2910
  DEBIT   platform_fees        90   ← platform returns proportional fee
  CREDIT  customer_funds       90
  ──────────────────────────────────
  Debits: 3000  Credits: 3000  ✓
```

After partial refund:

| Account | Balance | Meaning |
|---|---|---|
| customer_funds | -7000 + 3000 = **-4000** | Customer charged $40 net |
| merchant_payable | 6790 - 2910 = **+3880** | Merchant keeps $38.80 |
| platform_fees | 210 - 90 = **+120** | Platform keeps $1.20 |

Verification: 3880 + 120 = 4000 = captured (7000) - refunded (3000). Correct.

A second refund of the remaining $40.00 would return all accounts to zero.

---

## 4. Fee Model

### The Rule

```
platform_fee = (captured_amount × 3) / 100     (BigInt integer division)
merchant_share = captured_amount - platform_fee
```

The 3% rate is configurable in application config. In v1, it's hardcoded. The
split happens at **capture time**, not authorization or settlement. This is
industry standard — Stripe calculates fees when the charge is finalized, not
when it's authorized.

### Integer Math and Rounding

All amounts are BigInt (no floating point). Division truncates toward zero.

| Captured | Fee Calculation | Fee | Merchant | Total |
|---|---|---|---|---|
| 10000 ($100.00) | 10000 × 3 / 100 = 300 | 300 | 9700 | 10000 ✓ |
| 7000 ($70.00) | 7000 × 3 / 100 = 210 | 210 | 6790 | 7000 ✓ |
| 100 ($1.00) | 100 × 3 / 100 = 3 | 3 | 97 | 100 ✓ |
| 33 ($0.33) | 33 × 3 / 100 = 0 | **0** | 33 | 33 ✓ |
| 1 ($0.01) | 1 × 3 / 100 = 0 | **0** | 1 | 1 ✓ |

### The Zero-Fee Edge Case

When the captured amount is small enough that `amount × 3 / 100` truncates
to zero (any amount ≤ 33 cents at 3%), the fee is zero.

**Problem:** Ledger entries have a `CHECK (amount > 0)` constraint. We cannot
create a 0-amount entry.

**Solution:** When the fee is zero, skip the fee entries entirely. The capture
transaction has 4 entries instead of 6:

```
Fee = 0 → capture transaction:
  DEBIT   customer_funds    [authorized_amount]
  CREDIT  customer_holds    [authorized_amount]
  DEBIT   customer_funds    [captured_amount]     ← all goes to merchant
  CREDIT  merchant_payable  [captured_amount]
  (no fee entries)
```

This preserves the constraint, and the math still balances: debits = credits.

**Implementation note:** The `remaining` keyword pattern from Formance's
Numscript handles this naturally — "send 3% to platform, remaining to
merchant." If 3% rounds to zero, the merchant gets 100%. We achieve the
same result with an `if (fee > 0n)` guard.

### Refund Fee Calculation

Refunds use the same fee rate applied to the refund amount:

```
fee_refund = (refund_amount × 3) / 100
merchant_refund = refund_amount - fee_refund
```

This means each party (merchant, platform) returns their proportional share.
The same zero-fee guard applies: if `fee_refund` rounds to zero, skip the fee
reversal entries.

### Industry Comparison: Refund Fee Policies

| Processor | Refund Fee Policy |
|---|---|
| **Stripe** | Processing fee is NOT refunded. Merchant absorbs it. |
| **Adyen** | Processing fee is refunded. |
| **Square** | Processing fee is refunded. |
| **PayPal** | Fixed portion kept, percentage refunded. |
| **Us** | Fee is refunded (proportional reversal). |

We chose proportional reversal because:
1. **Simpler accounting.** Full refund returns all accounts to zero. No
   residual fee balance to reconcile.
2. **Fairer model for our use case.** We're a payment engine, not a
   marketplace charging for a service. The fee should reverse with the payment.
3. **Easier to verify.** The god check (SUM debits = SUM credits) combined
   with "full refund → all accounts zero" is a stronger invariant than Stripe's
   model where the platform retains fees after refund.

If we later want Stripe-style fee retention, it's a one-line change: skip the
`platform_fees` debit/credit in the refund transaction. The merchant returns
the full refund amount, and the platform keeps its fee. This changes the
invariant from "all accounts zero after full refund" to "only platform_fees
retains a balance after full refund."

---

## 5. Balance Computation

### Formula Per Account Type

| Account Type | Balance Formula | Increases With |
|---|---|---|
| ASSET | SUM(debits) - SUM(credits) | DEBIT |
| LIABILITY | SUM(credits) - SUM(debits) | CREDIT |
| REVENUE | SUM(credits) - SUM(debits) | CREDIT |
| EXPENSE | SUM(debits) - SUM(credits) | DEBIT |
| EQUITY | SUM(credits) - SUM(debits) | CREDIT |

### The Three-Balance Model (Industry Standard)

Most production systems track three balances:

```
┌───────────────────────────────────────────┐
│              Account Balance              │
├───────────────┬───────────────────────────┤
│  Posted       │  Finalized amounts only   │
├───────────────┼───────────────────────────┤
│  Pending      │  Posted + expected amounts│
├───────────────┼───────────────────────────┤
│  Available    │  Posted - pending debits  │
└───────────────┴───────────────────────────┘
```

**TigerBeetle** tracks `debits_pending`, `debits_posted`, `credits_pending`,
`credits_posted` per account. Authorization moves to pending. Capture moves
from pending to posted.

**Modern Treasury** exposes `posted_balance`, `pending_balance`, and
`available_balance` on every account.

### Our v1 Simplification

We use a single derived balance (equivalent to "posted" in the three-balance
model). Authorization holds create **posted entries** in a separate account
(`customer_holds`) rather than pending entries on `customer_funds`.

```
Industry approach (TigerBeetle/Modern Treasury):
  customer_funds.pending_balance += 10000  (auth)
  customer_funds.posted_balance  += 10000  (capture)
  customer_funds.pending_balance -= 10000  (capture releases hold)

Our approach:
  customer_holds (posted)  += 10000  (auth)
  customer_funds (posted)  += 10000  (auth)
  customer_holds (posted)  -= 10000  (capture, hold reversal)
  customer_funds (posted)  -= 10000  (capture, hold reversal)
  customer_funds (posted)  -= 10000  (capture, charge)
```

Both achieve the same result. The industry approach uses two balance types on
one account. Our approach uses two accounts with one balance type each. The
tradeoff:

| | Industry (pending/posted) | Ours (separate hold account) |
|---|---|---|
| Balance query complexity | One account, two columns | Two accounts, one column each |
| Ledger entry count | Fewer (no hold reversal) | More (6 entries per capture) |
| Auditability | Implicit (pending → posted) | Explicit (every movement is an entry) |
| Hold visibility | Query pending balance | Query customer_holds balance |
| God check | Needs pending-aware check | Simple SUM(debits) = SUM(credits) |

We chose separate accounts because:
1. **Every cent movement is an explicit ledger entry.** No implicit
   pending → posted transitions. An auditor can read the ledger and
   reconstruct the full history without understanding the pending/posted model.
2. **The god check stays simple.** SUM of all debits = SUM of all credits,
   across all accounts, at all times. No "but you have to exclude pending
   amounts" caveats.
3. **It's the traditional bookkeeping model.** The 600-year-old method that
   every accountant understands. T-accounts, not database column tricks.

---

## 6. The God Check — Mathematical Proof

### What It Is

```sql
SELECT
  SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS total_debits,
  SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS total_credits
FROM ledger_entries;

-- Invariant: total_debits = total_credits. Always.
```

### Why It Works

Every transaction we create has entries that sum to zero (debits = credits).
If every individual transaction balances, the sum of all transactions balances.
This is provable by induction:

- **Base case:** Empty system. 0 debits, 0 credits. Balanced.
- **Inductive step:** If the system is balanced before transaction N, and
  transaction N has debits = credits, then the system is balanced after
  transaction N.

The only way to break this is:
1. Insert an entry without a balancing counterpart (prevented by
   `postTransaction()` validation)
2. Modify an existing entry (prevented by immutability)
3. Delete an entry (prevented by immutability)

### When It's Checked

| Context | Frequency |
|---|---|
| After every integration test | Every test run |
| After every concurrency test | Every race condition test |
| After every load test burst | Every load test |
| After property-based tests | Every random sequence |
| In the CTO demo (Act 3) | Every demo |
| Production health check (v2) | Could run periodically |

### What a Failure Means

If the god check fails, **stop everything**. Money has been created or
destroyed. This is the financial equivalent of `2 + 2 = 5`. The system is
in a corrupt state. No amount of application-level retry will fix it.

Stripe's equivalent: "A single missing, late, or incorrect transaction
immediately creates a detectable accuracy issue."

---

## 7. Settlement Model

### What Settlement Is

Settlement is the transfer of money from the payment processor to the
merchant's bank account. In the real world, this is batched (once per day,
per merchant). In our system, settlement is per-payment.

### Our Model: Per-Payment Settlement With Ledger Entries

When `settle()` is called on a captured payment, two ledger entries discharge
the `merchant_payable` liability:

```
Transaction: "Settle payment pay_01HX..."
  DEBIT   merchant_payable   [merchant_share]   ← we no longer owe the merchant
  CREDIT  platform_cash      [merchant_share]   ← money left our platform
```

Where `merchant_share = captured_amount - fee` (the same split computed at
capture time).

**Example:** $100 captured, 3% fee ($3), merchant_share = $97.

```
After settlement:
  merchant_payable: 9700 - 9700 = 0      (liability discharged)
  platform_cash: 0 - 9700 = -9700        (outflow recorded)
  platform_fees: +300                      (revenue retained)
  customer_funds: -10000                   (customer was charged)
```

### Why Per-Payment, Not Batched

| | Per-Payment (our v1) | Batched (industry) |
|---|---|---|
| Complexity | Simple — settle one payment at a time | Needs batch grouping, net calculation, multi-payment transactions |
| Auditability | Each payment has its own settlement entries | Settlement entries span multiple payments |
| Refund interaction | Clear — settle before or after refund, each has its own entries | Complex — partial refund on a batched settlement requires adjustment entries |
| Demo value | Can show complete lifecycle: auth → capture → settle → refund | Needs batch infrastructure to demonstrate |

Batch settlement is a v2 enhancement. The per-payment model demonstrates the
same accounting principle (DEBIT merchant_payable / CREDIT platform_cash) with
less infrastructure.

### Settlement + Refund Interaction

A payment can be refunded whether it's `captured` or `settled`. The refund
entries are the same in both cases (DEBIT merchant_payable / CREDIT
customer_funds + fee reversal). The settlement entries are independent —
they track disbursement, not the customer-facing charge.

**Full lifecycle with settlement:**
```
Auth:    DEBIT customer_holds 10000 / CREDIT customer_funds 10000
Capture: (6 entries — hold reversal + charge split)
Settle:  DEBIT merchant_payable 9700 / CREDIT platform_cash 9700
Refund:  DEBIT merchant_payable 9700 / CREDIT customer_funds 9700
         DEBIT platform_fees 300 / CREDIT customer_funds 300

Final: all accounts at zero EXCEPT platform_cash = -9700
```

The `platform_cash` outflow remains after refund. In a production system, the
platform would recover this from the merchant (a "clawback"). That's beyond
v1 scope, but the ledger correctly shows the money trail.

### The platform_cash Balance

`platform_cash` will show a negative balance after settlements. This is
expected — it represents money that left the platform. In a complete system:

```
Inflows to platform_cash:
  - Initial funding deposit
  - Fee revenue (periodic transfer from platform_fees)
  - Merchant clawbacks after post-settlement refund

Outflows from platform_cash:
  - Settlement disbursements to merchants
```

v1 only models the outflow side. The negative balance is not an error — it's
an accurate record of disbursement.

---

## 8. Decisions We Made — Summary

| Decision | Our Choice | Alternative | Why |
|---|---|---|---|
| Hold model | Separate `customer_holds` account | Pending/posted balance on `customer_funds` | Explicit entries > implicit state transitions |
| Fee timing | At capture | At settlement | Industry standard. Merchant sees net immediately. |
| Fee on refund | Proportional reversal | Platform keeps fee (Stripe) | Simpler math. Full refund = all accounts zero. |
| Balance storage | Derived from entries | Stored + cached | Provably correct. v1 scale doesn't need caching. |
| Settlement | Per-payment with ledger entries | Batched settlement | Complete lifecycle in v1. Batch grouping is v2. |
| Money type | BigInt (cents) | Decimal / float | No precision loss. TypeScript `bigint` prevents contamination. |
| Hold reversal on partial capture | Release full hold | Release only captured portion | Industry standard. Simpler accounting. One reversal, one charge. |
| Zero-fee handling | Skip fee entries | Create 0-amount entries | Database constraint `amount > 0` prevents 0-amount entries. |
| Entry amounts | Always positive, direction field | Signed amounts | Unambiguous. `100 CREDIT` clearer than `-100`. |
| Account IDs | Readable strings (`customer_funds`) | ULIDs / integers | System accounts are referenced in code. Self-documenting. |

---

## 9. Entry Patterns Reference

Quick reference for every operation's ledger entries.

### Authorization

```
DEBIT   customer_holds    [authorized_amount]
CREDIT  customer_funds    [authorized_amount]
```

2 entries. Always the full authorized amount.

### Capture (Full or Partial)

```
fee = (captured_amount × fee_rate) / 100
merchant_share = captured_amount - fee

DEBIT   customer_funds    [authorized_amount]      ← always full auth, not capture
CREDIT  customer_holds    [authorized_amount]      ← full hold released
DEBIT   customer_funds    [merchant_share]
CREDIT  merchant_payable  [merchant_share]
DEBIT   customer_funds    [fee]                    ← skip if fee = 0
CREDIT  platform_fees     [fee]                    ← skip if fee = 0
```

4 or 6 entries. Hold reversal is always the full authorized amount, regardless
of capture amount.

### Void

```
DEBIT   customer_funds    [authorized_amount]
CREDIT  customer_holds    [authorized_amount]
```

2 entries. Exact mirror of authorization.

### Refund (Full or Partial)

```
fee_refund = (refund_amount × fee_rate) / 100
merchant_refund = refund_amount - fee_refund

DEBIT   merchant_payable  [merchant_refund]
CREDIT  customer_funds    [merchant_refund]
DEBIT   platform_fees     [fee_refund]             ← skip if fee_refund = 0
CREDIT  customer_funds    [fee_refund]             ← skip if fee_refund = 0
```

2 or 4 entries. Proportional reversal of the capture split.

### Expiration (v1: On-Access)

```
DEBIT   customer_funds    [authorized_amount]
CREDIT  customer_holds    [authorized_amount]
```

2 entries. Same as void. The hold is released. The only difference is the
trigger (time-based vs. explicit void request).

### Settlement

```
merchant_share = captured_amount - (captured_amount × fee_rate / 100)

DEBIT   merchant_payable  [merchant_share]
CREDIT  platform_cash     [merchant_share]
```

2 entries. Discharges the merchant liability. `merchant_share` is the same
value computed at capture time.

---

## 10. Verification Checklist

After implementing the accounting model, verify these invariants:

```
□ Auth + void = all accounts zero
□ Auth + capture (full) + refund (full) = all accounts zero
□ Auth + capture (partial) + refund (remaining captured) = all accounts zero
□ customer_holds = 0 after every capture, void, and expiry
□ SUM(debits) = SUM(credits) at all times (god check)
□ Every individual transaction balances (debits = credits within transaction)
□ captured_amount ≤ authorized_amount (database constraint)
□ refunded_amount ≤ captured_amount (database constraint)
□ All entry amounts > 0 (database constraint)
□ Fee entries skipped when fee rounds to zero
□ Partial capture hold reversal uses authorized_amount, not captured_amount
□ Partial refund split uses same fee rate as capture
□ platform_cash balance = negative(merchant_share) after settlement
□ Auth + capture + settle: merchant_payable = 0
□ Auth + capture + settle + refund (full): all accounts zero except platform_cash
```

---

Previous: [17 — CI/CD](./17-ci-cd.md) | Back to: [README](../README.md)
