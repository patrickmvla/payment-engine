---
type: decision
features: [api-contract, money]
related: []
created: 2026-04-26
confidence: high
---

# Amount wire format: JSON integer (Number)

## Decision

API responses serialize all money amounts as JSON integers (TypeScript `Number()`).
Storage stays `BIGINT` (PostgreSQL) / `bigint` (TypeScript) — unchanged. Conversion
to `Number()` happens only at the response-serialization boundary
(`src/payments/routes.ts`, `src/ledger/routes.ts`).

Input cap at the Zod boundary stays at 99,999,999 cents (~$999,999.99 for
2-decimal currencies), matching Stripe's documented per-charge ceiling exactly.

## Reasoning

The engine is committed to a Stripe/Adyen/Square-shape: consumer/SMB/marketplace
fiat payments, card-network-class flows. That shape sits 27 orders of magnitude
below the JS `Number.MAX_SAFE_INTEGER` boundary (2^53 cents = ~$90 trillion).

Industry practice from research:

- Stripe — JSON integer, cap 99,999,999 (8 digits)
- Adyen — JSON integer, minor units
- Square — JSON integer, smallest denomination
- PayPal — JSON string with decimals (outlier; supports up to 15 decimals)

Three of four major processors use integers because the consumer-payment
problem fits comfortably under 53 bits. Owner has explicitly committed to the
Stripe-shape lane. PayPal's string format is the right answer when scope
includes crypto (BTC ≥ 8 decimals, ETH = 18 decimals) or planet-scale
aggregates — neither is in scope per owner's commitment.

Lock-out list owner accepts:

- Crypto-native unit precision (ETH/wei is unrepresentable safely)
- Per-payment amounts > $90 trillion (Stripe-shape doesn't go there)
- Aggregate-sum endpoints exceeding 2^53 (Stripe-shape doesn't expose these)

Lock-in list owner gains:

- Industry-standard wire format; OpenAPI consumers, browsers, jq, Postman, and
  Excel all handle integers under 2^53 without surprises.
- Compatible with all current and reasonably-foreseeable fiat currency
  precision (max BHD/KWD = 3 decimals; aggregate stays under 2^53).
- No wire-format coordination cost during v1 → v2 evolution that stays in lane.

## Strongest rejected alternative

JSON string serialization, PayPal-style (`"10000"` instead of `10000`).

Counter-argument considered:

- Defense in depth: zero precision-loss surface forever, regardless of what
  future code does.
- Forward-compatible with crypto and large-aggregate scope.
- Removes the class of "looks fine for years, blows up when amounts grow" bug.
- OpenAPI 3.1 explicitly supports `int64` as string (Google Discovery Document
  format defaulted to string for this exact reason).

Why it lost:

- The "future scope" justification is speculative. Owner has explicitly
  excluded crypto and large-aggregate trajectories. Without those, string
  format is solving a problem we've committed not to have.
- Migration cost is real but bounded if scope ever shifts: it's a v1 → v2
  breaking change like any other API evolution. Bounded by consumer count at
  migration time, which is small now.
- Choosing strings now imposes ergonomic cost on every consumer (parse before
  arithmetic, can't sort numerically without parsing, OpenAPI clients
  generated as `string` instead of `number`) for a defense against scenarios
  the product committed to never reaching.

## Failure mode

Silent precision loss occurs if any of these later become true:

1. Per-payment input cap is raised above `Number.MAX_SAFE_INTEGER / 10`
   (~9 × 10^14 cents = $9 quadrillion). The current cap is 27 orders of
   magnitude below this; raising the cap to anything reasonable (even $500B
   per payment) stays safe.
2. An aggregate balance endpoint sums entries that exceed 2^53 cents in total.
   At the current cap, this requires ~9 × 10^7 max-value payments (90M
   payments at $1M each = $90T total). Stripe-shape SMB volume is not at
   risk.
3. Scope expands into crypto-native unit precision (ETH/wei). Owner has
   excluded this.

When silent precision loss occurs, large amounts deserialize as approximations:
e.g., `9_007_199_254_740_993` becomes `9_007_199_254_740_992`. No error,
no log, no assertion — the wrong number is just used. Reconciliation is the
only thing that catches it.

Mitigation owed (separate follow-up): add a property test that fails loudly
if the input cap is ever raised above `Number.MAX_SAFE_INTEGER / 10`, AND
add a runtime assertion in the response serializer that `bigint <= 2^53 - 1`
before `Number()` conversion.

## Revisit when

- Product scope expands to include crypto-native precision (BTC at sat
  granularity, ETH at wei granularity, or any currency requiring > 4 decimals).
- A new endpoint is added that returns aggregate sums across many accounts
  or a long time horizon (planet-scale balances, year-end totals across
  enterprise tenants, etc.).
- Per-payment input cap is raised above $1B equivalent.
- The engine is repositioned away from Stripe-shape (e.g., pivoting to a
  treasury / interbank settlement engine where individual transactions
  routinely exceed $100M).

The migration path if any of these triggers: v2 API with string amounts,
deprecation period for v1, OpenAPI client regeneration. Bounded cost,
versioned breaking change.
