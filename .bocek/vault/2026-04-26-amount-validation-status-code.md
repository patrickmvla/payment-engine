---
type: decision
features: [api-contract]
related: ["[[2026-04-26-amount-wire-format]]"]
created: 2026-04-26
confidence: high
---

# Schema-violating amounts return 400, not 422

## Decision

Non-positive `amount` (zero or negative) on `POST /payments/authorize` returns
HTTP 400 with `error.type: "validation_error"`. The Zod schema
(`AuthorizeSchema.amount: z.number().int().positive()`) at the request
boundary catches it. No runtime check is added.

422 with `error.type: "invalid_amount"` is reserved for runtime,
state-dependent business-rule violations:

- Capture amount > authorized amount
- Refund amount > captured amount minus already refunded

`docs/05-api-design.md:103` (the line listing 422 for "Amount is zero or
negative") is stale; the line two rows above it (line 101) already lists 400
for "negative amount." The 422 row gets removed.

## Reasoning

Aligns with the Stripe-shape commitment recorded in
[[2026-04-26-amount-wire-format]]. Stripe and Adyen both split error codes by
cause: 400 for malformed requests (schema violations), 422 for
well-formed-but-business-rule-violating requests. Mixing the two flattens a
useful distinction.

The response body already discriminates per-field:
`error.details.fields[].field == "amount"`. Clients can identify amount
issues without needing a unique status code.

Information value of separating the two:

- 400 spike → bad clients sending malformed data; investigate client-side
  bugs.
- 422 spike → users hitting business limits; investigate product flow.

Collapsing to a single code loses that operational signal.

## Strongest rejected alternative

Return 422 for ALL amount-related rejections (schema and runtime). The case
for it: clients only need one error code to handle for "amount was wrong";
slightly cleaner client code.

Why it lost:

- The response body already supports the distinction via `error.type`.
- Aligning with Stripe/Adyen convention is a stated commitment from
  [[2026-04-26-amount-wire-format]].
- Single-code amount errors lose the malformed-vs-runtime signal for
  monitoring.

## Failure mode

Minimal. Worst case: a client treats 400 and 422 the same way and ignores
the distinction. That's their choice, not a contract violation.

The doc fix itself can be miswritten if the reviewer doesn't realize line
101 already covers negative amounts. Mitigation: the implementation task
explicitly includes deleting line 103, not the line above.

## Revisit when

- The engine adds a new status code policy (e.g., 422 becomes the catch-all
  for any business-logic violation, regardless of cause). Unlikely but
  possible if the API moves to RFC 7807 problem-details with more granular
  type URIs.
- A client integration concretely complains that splitting 400 and 422 for
  amount errors causes them code complexity that 422-everywhere would solve.

## Implementation tasks

1. `docs/05-api-design.md:103`: remove the 422 row "Amount is zero or
   negative" from the authorize errors table. Confirm line 101's 400 row
   covers negative amounts; if it doesn't say "zero or negative," update it
   to do so.
