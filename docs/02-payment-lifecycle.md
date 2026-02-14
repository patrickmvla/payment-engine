# Payment Lifecycle — What Actually Happens When Someone Pays

Every time you tap your card, click "Pay Now," or send money — a carefully
orchestrated sequence of events fires. Most developers have no idea what happens
between "user clicks pay" and "money arrives." You will.

---

## The Players

Before understanding the flow, know who's involved:

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Customer │────▶│ Merchant │────▶│ Payment  │────▶│  Bank /  │
│          │     │  (App)   │     │ Processor│     │ Network  │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

- **Customer** — The person paying
- **Merchant** — The business receiving payment (your API client)
- **Payment Processor** — That's us. We sit between merchant and bank.
- **Bank / Card Network** — The actual money holders (Visa, Mastercard, banks)

In our project, we're building the **Payment Processor**. We don't talk to real
banks (we'll mock that), but we implement the same flows that Stripe, Adyen, and
Square use internally.

---

## The Full Lifecycle

### Phase 1: Authorization

**What happens:** The customer's payment method is validated and funds are
"held" (reserved) but NOT yet transferred.

**Real-world analogy:** A hotel puts a hold on your credit card at check-in.
The money isn't taken yet, but it's reserved so you can't spend it elsewhere.

**Why this exists:**
- Verify the customer has sufficient funds
- Lock the amount so it can't be double-spent
- Give the merchant time to fulfill the order before taking money

**In our ledger:**
```
Transaction: "Authorize $100 for Payment #PAY_001"
├── DEBIT   customer_holds     $100   ← funds reserved
└── CREDIT  customer_funds     $100   ← removed from available balance
```

The money hasn't moved to the merchant yet. It's in limbo — held but not taken.

**Key details:**
- Authorizations have an **expiry** (typically 7 days for cards)
- If not captured before expiry, the hold is automatically released
- The customer sees "pending" on their bank statement

---

### Phase 2: Capture

**What happens:** The merchant confirms they want to take the money. The
authorization is converted into an actual charge.

**Real-world analogy:** The hotel charges your card when you check out.

**Why this exists:**
- Merchants might not want to charge immediately (e.g., ship first, charge
  after)
- Allows partial captures (order was $100 but one item was out of stock, capture
  only $70)
- Separates "can they pay?" from "take the money"

**In our ledger:**
```
Transaction: "Capture $100 for Payment #PAY_001"
├── DEBIT   customer_funds     $100   ← reverse the hold (undo auth credit)
├── CREDIT  customer_holds     $100   ← release the hold (undo auth debit)
├── DEBIT   customer_funds     $97    ← charge customer (merchant share)
├── CREDIT  merchant_payable   $97    ← merchant is owed this
├── DEBIT   customer_funds     $3     ← charge customer (platform fee: 3%)
└── CREDIT  platform_fees      $3     ← revenue
```

**Key details:**
- Can only capture what was authorized (no more)
- Can capture partially (capture $70 of a $100 auth)
- Partial capture releases the **entire** hold first, then charges only the
  captured amount. The remaining $30 was never charged — no explicit "release"
  transaction is needed for it.
- Once captured, the customer sees a real charge on their statement
- Platform fee: **3%** of the captured amount, deducted from the customer and
  credited to `platform_fees`. Configurable in application config.
- **Zero-fee edge case:** If the captured amount is small enough that
  `amount × 3 / 100` truncates to zero (≤ 33 cents at 3%), the fee entries
  are skipped. The capture transaction has 4 entries instead of 6, and the
  full captured amount goes to `merchant_payable`.

---

### Phase 3: Settlement

**What happens:** Money is actually moved from us to the merchant. The
`merchant_payable` liability is discharged and `platform_cash` records the
outflow.

**Real-world analogy:** At the end of the day, the hotel sends all charges to
the bank for processing.

**Why this exists:**
- Separates "charge the customer" (capture) from "pay the merchant" (settlement)
- Gives time for chargebacks/disputes before money leaves
- In production, settlement is typically batched (once per day)

**In our ledger:**
```
Transaction: "Settle payment #PAY_001"
├── DEBIT   merchant_payable   $97    ← we no longer owe the merchant
└── CREDIT  platform_cash      $97    ← money leaves our platform
```

The settlement amount is the merchant's share from the capture:
`merchant_share = captured_amount - fee`. The fee has already been split at
capture time. Settlement only moves the merchant's portion.

**Key details:**
- Settlement operates per-payment (`POST /payments/:id/settle`), not batched
- Can only settle a `captured` payment (not authorized, not already settled)
- Creates 2 ledger entries: DEBIT merchant_payable, CREDIT platform_cash
- After settlement, `merchant_payable` for this payment = 0
- `platform_cash` records a negative balance (outflow) — in a complete system,
  this would be offset by initial funding or accumulated fee revenue
- Batch settlement across multiple payments is a v2 enhancement

---

## Alternative Flows

### Void (Cancel an Authorization)

**When:** The merchant decides not to charge the customer after authorization.

**Real-world analogy:** You cancel your hotel reservation before check-out.

```
Transaction: "Void Payment #PAY_001"
├── DEBIT   customer_funds     $100   ← restore available balance (undo auth credit)
└── CREDIT  customer_holds     $100   ← release the hold (undo auth debit)
```

Void is the exact mirror of authorization — it reverses every entry. After void,
both `customer_holds` and the auth's effect on `customer_funds` net to zero.

**Rules:**
- Can only void an AUTHORIZED payment (not captured)
- Immediate — the hold is released right away
- Terminal state — payment is done after this

---

### Refund (Return Money After Capture)

**When:** The customer wants their money back after being charged.

**Real-world analogy:** Returning a product to a store.

```
Transaction: "Refund $100 for Payment #PAY_001"
├── DEBIT   merchant_payable   $97    ← merchant gives back their share
├── CREDIT  customer_funds     $97    ← customer gets merchant's portion back
├── DEBIT   platform_fees      $3     ← we give back our fee
└── CREDIT  customer_funds     $3     ← customer gets fee portion back
```

**Rules:**
- Can only refund a CAPTURED or SETTLED payment
- Can be full or partial
- Total refunds cannot exceed original capture amount
- Multiple partial refunds are allowed until the total is reached
- **Fee split rule:** The refund amount is split using the same fee rate as
  the capture (3%). `fee_refund = (refund_amount × 3) / 100`,
  `merchant_refund = refund_amount - fee_refund`. Each party (merchant,
  platform) returns their proportional share.
- **Zero-fee refund:** If the refund amount is small enough that the fee
  portion rounds to zero, the fee reversal entries are skipped. The merchant
  returns the full refund amount.
- **Our policy:** We refund the platform fee proportionally. Stripe does NOT —
  they keep the processing fee on refund. We chose proportional reversal
  because it's simpler: full refund = all accounts return to zero. See
  [18 — Accounting Model](./18-accounting-model.md) for the detailed rationale.

---

### Partial Capture

**When:** The merchant only wants to charge part of the authorized amount.

**Example:** Auth was $100, but one item ($30) was out of stock.

```
Capture $70 of $100 authorization
→ Customer is charged $70
→ Remaining $30 hold is released automatically
```

---

### Partial Refund

**When:** Customer returns one item from a multi-item order.

**Example:** Paid $100, returns one item worth $40.

```
Refund $40 of $100 capture
→ Customer gets $40 back
→ $60 remains with the merchant
→ Another refund of up to $60 is still possible
```

---

## The State Machine (Detailed)

```
CREATED
  │
  ├── authorize() ──────────────▶ AUTHORIZED
  │                                   │
  │                    ┌──────────────┼──────────────┐
  │                    │              │              │
  │               void()        capture()      [expiry]
  │                    │              │              │
  │                    ▼              ▼              ▼
  │                 VOIDED        CAPTURED       EXPIRED
  │                               │
  │                          settle()
  │                               │
  │                               ▼
  │                           SETTLED
  │                               │
  │                    ┌──────────┴──────────┐
  │                    │                     │
  │              refund(full)         refund(partial)
  │                    │                     │
  │                    ▼                     ▼
  │               REFUNDED          PARTIALLY_REFUNDED
  │                                          │
  │                                   refund(remaining)
  │                                          │
  │                                          ▼
  │                                      REFUNDED
```

### Valid Transitions Table

| From | To | Action | Conditions |
|---|---|---|---|
| CREATED | AUTHORIZED | `authorize()` | Payment method valid, funds available |
| AUTHORIZED | CAPTURED | `capture()` | Amount <= authorized amount, not expired |
| AUTHORIZED | VOIDED | `void()` | — |
| AUTHORIZED | EXPIRED | `expire()` | Authorization TTL exceeded |
| CAPTURED | SETTLED | `settle()` | Per-payment settlement with ledger entries |
| CAPTURED | REFUNDED | `refund(full)` | — |
| CAPTURED | PARTIALLY_REFUNDED | `refund(partial)` | Amount < captured amount |
| SETTLED | REFUNDED | `refund(full)` | — |
| SETTLED | PARTIALLY_REFUNDED | `refund(partial)` | Amount < settled amount |
| PARTIALLY_REFUNDED | REFUNDED | `refund(remaining)` | Total refunds = captured amount |
| PARTIALLY_REFUNDED | PARTIALLY_REFUNDED | `refund(partial)` | Total refunds < captured amount |

### Terminal States (no further transitions)

- `VOIDED` — Authorization was cancelled
- `EXPIRED` — Authorization timed out
- `REFUNDED` — All money returned

---

## Timing: When Things Happen

```
Time ──────────────────────────────────────────────────▶

Customer     Merchant        Us (Processor)        Bank
clicks pay
    │
    └──────▶ POST /authorize
                  │
                  └──────▶ Validate
                           Create ledger entries
                           Return auth_id ──────▶ Hold funds
                  ◀────────────────────────────────
             Show "pending"
             to customer

  ... hours or days later ...

             POST /capture
                  │
                  └──────▶ Verify auth valid
                           Create ledger entries
                           Return capture ───────▶ Charge card
                  ◀────────────────────────────────
             Ship the order

  ... end of day ...

                           Batch settlement ─────▶ Transfer to
                                                   merchant bank
```

---

## What We're Building vs What We're Mocking

| Component | Building | Mocking |
|---|---|---|
| Payment API (authorize/capture/settle/refund/void) | Yes | — |
| Double-entry ledger | Yes | — |
| State machine transitions | Yes | — |
| Idempotency handling | Yes | — |
| Per-payment settlement (with ledger entries) | Yes | — |
| Bank/card network communication | — | Yes (simulated responses) |
| Real money movement | — | Yes (ledger entries only) |
| Batch settlement (multi-payment) | — | v2 (per-payment in v1) |
| Customer-facing UI | — | No (API only) |

We're building the **brain** — the part that makes decisions, tracks money, and
enforces rules. The bank integration is the plumbing, and it's not what makes
you impressive.

---

Previous: [01 — Core Concepts](./01-core-concepts.md) | Next: [03 — Architecture](./03-architecture.md)
