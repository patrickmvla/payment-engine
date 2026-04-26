---
type: research
features: [ledger, testing, payments]
related: ["[[2026-04-26-multi-capture-model]]", "[[2026-04-26-test-category-separation]]"]
created: 2026-04-26
confidence: high
---

# Which TigerBeetle design takes are evidence-grounded AND apply to a TS+Postgres+Bun payment engine?

## Question

The engine owner reports having considered TigerBeetle during design but
proceeding with a TS+Postgres+Drizzle ledger because the ledger was already
built. They asked which TigerBeetle takes "resonated." This research entry
catalogs TigerBeetle's documented design takes against the engine's current
shape so the owner can pick a shortlist in design mode.

The output is evidence with applicability filtering. No recommendations.

## Sources examined

- [docs.tigerbeetle.com/coding/two-phase-transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/) — current docs (fetched 2026-04-26)
- [docs.tigerbeetle.com/coding/data-modeling](https://docs.tigerbeetle.com/coding/data-modeling/) — current docs (fetched 2026-04-26)
- [docs.tigerbeetle.com/concepts/safety](https://docs.tigerbeetle.com/concepts/safety/) — current docs (fetched 2026-04-26)
- [github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) — current Tigerstyle guide (fetched 2026-04-26)
- [tigerbeetle.com/blog/2023-07-06-simulation-testing-for-liveness](https://tigerbeetle.com/blog/2023-07-06-simulation-testing-for-liveness/) — VOPR liveness post (2023, may be partially superseded)
- [jepsen.io/analyses/tigerbeetle-0.16.11](https://jepsen.io/analyses/tigerbeetle-0.16.11) — Jepsen verification (referenced but not deep-fetched in this entry)
- Engine codebase: `src/ledger/{schema.ts, service.ts, types.ts}`, `src/payments/{schema.ts, service.ts, state-machine.ts}`

## Findings

### 1. Account flags enforce per-account balance invariants at the storage layer

**Evidence (data-modeling docs):**
> `credits_must_not_exceed_debits` — enforces a positive debit balance where `balance = debits - credits`
> `debits_must_not_exceed_credits` — enforces a positive credit balance where `balance = credits - debits`

TigerBeetle accounts carry flags that the storage layer enforces on every
transfer. A transfer that would violate a flag's invariant fails atomically —
the balance check is part of the write path, not application code.

**Engine current state:** `src/ledger/schema.ts:46` has CHECK constraints for
`positive_amount` and `valid_direction` but **no per-account
balance-direction enforcement.** The `customer_funds` account is liability
(credits-positive), but nothing in the schema prevents it from going debit-
heavy. The application logic happens to keep it balanced because
authorize/capture/void/refund post symmetric entries — but a bug in service
code could violate this without the database catching it.

**Adoption surface (TS+Postgres):**
- A Postgres `CHECK` constraint on a derived view, OR a trigger on
  `ledger_entries` insert that recomputes the affected account's signed
  balance and rejects the insert if a per-account flag is violated.
- Alternatively, a service-layer assertion in `postTransaction` that
  computes the post-insert signed balance for each affected account and
  throws if a flag is violated.
- The 5 system accounts already have implicit "natural side" rules per
  CLAUDE.md (LIABILITY-credit, ASSET-debit, etc.). Encoding those as
  per-account flags makes it impossible for a future bug to silently
  violate them.

**Applicability:** HIGH. Defense in depth, no architectural change, ~30 LOC.

---

### 2. Two-phase transfer as a single primitive (pending → post/void)

**Evidence (two-phase-transfers docs):**
> Phase 1 - Pending (Reserve): A transfer marked with `flags.pending`
> reserves funds in `debits_pending`/`credits_pending` fields while leaving
> `debits_posted`/`credits_posted` unchanged.
> Phase 2a - Post-Pending: A transfer with `flags.post_pending_transfer`
> and a `pending_id` reference moves reserved amounts to posted balances.
> Phase 2b - Void-Pending: A transfer with `flags.void_pending_transfer`
> returns the full reserved amount to original accounts.
> Single Resolution: A pending transfer can only be posted or voided once.
> Pessimistic Validation: Account balance constraints are checked during
> Phase 1, preventing failures during Phase 2.

The TigerBeetle model collapses the entire authorize/capture/void state
machine into TWO transfer types: a `pending` transfer and a resolution
transfer (`post_pending` or `void_pending`) that references the pending one
by `pending_id`. There is no payment-level state machine separate from the
transfer type — the resolution transfer's flag IS the state transition.

**Engine current state:** `src/payments/state-machine.ts` carries an explicit
`PaymentStatus` enum with 8 states and a `TRANSITIONS` map. `src/payments/
service.ts` has separate functions for `authorize`, `capture`, `void`, `settle`,
`refund`, each posting its own ledger transaction. The `payments` row tracks
status separately from the ledger entries. The state machine and the ledger
are two consistency surfaces that have to be kept aligned via service-layer
discipline.

**Adoption surface (TS+Postgres):**
- Refactor `ledger_entries` to track `pending_id` and a `flags` integer (or
  enum column).
- Authorize creates entries with `pending=true`. Capture creates new entries
  with `post_pending_transfer=true` and a `pending_id` pointing back. Void
  similar with `void_pending_transfer=true`.
- The `payments` table becomes a thin index pointer rather than a state-
  machine carrier; status is derived from "does this payment have a posted
  transfer?" / "does it have a void transfer?"
- Removes the `validateTransition()` machinery entirely. The transfer flag
  IS the only valid resolution.

**Caveats:**
- Big refactor. Touches `src/ledger/`, `src/payments/`, every test that
  asserts intermediate state.
- The ENGINE owner just locked in the multi-capture model in
  [[2026-04-26-multi-capture-model]] under the existing architecture. A
  TigerBeetle-shape rewrite would re-do that work in a new shape.
- The two-phase model in TigerBeetle assumes ONE pending → ONE posted (or
  voided). Multi-capture (1 pending → N partial posts totalling pending)
  needs a different shape — probably multiple `post_pending_transfer`s
  referencing the same `pending_id`, each posting a partial amount, with
  the final one posting the remainder. Achievable, but the canonical
  TigerBeetle docs only show single-shot resolution.

**Applicability:** MEDIUM. Architecturally cleaner; refactor cost is
substantial; v1 ships fine without it. Strong v2 candidate.

---

### 3. Deterministic simulation testing (VOPR-style fault injection)

**Evidence (safety docs):**
> Simulation Testing (VOPR): An entire cluster, running real code, is
> subjected to all kinds of network, storage and process faults, at 1000x
> speed. This finds both algorithmic errors and coding bugs. The simulator
> runs continuously on 1024 cores.

**Evidence (liveness blog):**
> Safety Mode: Verifies strict serializability by injecting faults
> uniformly. That is, on every tick it rolled a dice and, with some
> probability, crashed a healthy replica or disrupted network/storage
> operations.
> Liveness Mode: Ensures cluster availability when a quorum remains
> healthy. It picks a quorum of replicas to be fully available (the core),
> restarting any core replicas which are down while making those failures
> permanent for non-core nodes.

VOPR is a deterministic simulator: same seed = same fault sequence =
reproducible bug. The 1000x speedup comes from fully simulated time —
network latency, disk I/O, clock progression are all controlled by the
simulator's tick, not wall-clock.

**Engine current state:** `tests/property/random-sequences.test.ts` exists
and runs property-based test sequences. `tests/fuzz/validation-fuzz.test.ts`
exists for input validation. Neither implements deterministic seeded replay,
fault injection (network, storage), or simulated time. The "simulation"
piece — driving the engine through long sequences of operations under fault
conditions — is absent.

**Adoption surface (TS+Postgres):**
- Pattern is language-portable; the Zig implementation is not.
- Build a deterministic seed-based test harness that:
  - Generates a sequence of payment operations (authorize/capture/void/etc.)
  - Optionally injects faults: forced rollbacks, simulated connection drops,
    forced expiry timeouts, concurrent requests with fixed scheduling
  - Asserts invariants after every operation: god check, account-flag
    checks, state-machine validity
  - Replays from seed for reproducibility
- The 1024-core / 1000x speedup is unrealistic for a TS implementation; but
  even single-process seeded runs produce bug-finding-power that integration
  tests don't.

**Caveats:**
- Wall-clock time still real (no simulated `setTimeout`); fault injection
  is shallower than TigerBeetle's.
- Postgres state has to be reset cleanly between simulated steps OR the
  simulator runs against an in-memory mock of the ledger (which loses
  realism — probably defeats the purpose for a financial system).

**Applicability:** MEDIUM-HIGH for the pattern. v2 capability.

---

### 4. Strict serializability via single-core sequential execution

**Evidence (safety docs):**
> All transfers execute sequentially on a single core, eliminating
> isolation-level misconfiguration risks. Each transfer has a unique
> client-generated ID and processes at most once, following end-to-end
> idempotency principle.

TigerBeetle does NOT do row-level locking, optimistic concurrency, or
isolation-level configuration. There IS one queue. One executor. One thread.
Strict serializability is free because there's no parallelism at the engine
level.

**Engine current state:** `src/payments/service.ts:48` uses pessimistic
`SELECT ... FOR UPDATE` per-payment-row. Concurrent operations on the same
payment serialize via the row lock; concurrent operations on different
payments run in parallel via Postgres's MVCC. The engine relies on
Postgres's default `READ COMMITTED` isolation (per Drizzle defaults).

**Adoption surface:** ZERO without rewriting the runtime model. Postgres
under TS doesn't give you single-threaded sequential execution unless you
serialize via a queue at the application layer (which would tank
throughput).

**Caveats:** TigerBeetle achieves this because it owns the storage engine.
A Postgres-backed engine cannot replicate this without a queue layer. The
end-to-end idempotency principle (already implemented via the
[[2026-04-26-vitest-migration]] / idempotency_keys table) is portable; the
single-core execution model is not.

**Applicability:** N/A architecturally. The end-to-end idempotency principle
is already aligned.

---

### 5. Tigerstyle engineering principles (assertion density, integer-only, bounded loops)

**Evidence (Tigerstyle):**
> Functions must average a minimum of two assertions per function.
> Assert the positive space that you do expect AND to assert the negative
> space that you do not expect.
> All memory must be statically allocated at startup.
> Put a limit on everything including all loops and queues to prevent
> infinite loops and tail latency spikes.
> All errors must be handled. Almost all (92%) of the catastrophic system
> failures are the result of incorrect handling of non-fatal errors.
> Use explicitly-sized types like `u32` rather than architecture-specific
> types.

A code-discipline guide rather than an architecture doc. Most principles
encode habits.

**Engine current state:**
- Integer-only money math: ALREADY DONE (BigInt throughout, see
  [[2026-04-26-amount-wire-format]]).
- Static memory allocation: NOT APPLICABLE in V8/Bun's GC environment.
- Error handling: PARTIAL — the engine has typed error classes
  (`src/shared/errors.ts`) and catches them at route boundaries; whether
  every non-fatal error is explicitly handled is a code-review question.
- Bounded loops/queues: rate limiter exists; idempotency_keys has expiry;
  ledger queries have implicit bounds (per-payment); but no global "limit
  on every loop" discipline.
- Assertion density: TS culture is much weaker on runtime asserts than Zig.
  The `god-check.ts` helper is the closest analog. Most service functions
  have no internal assertions.
- Explicitly-sized types: BigInt covers the money side. `number` is used
  for some non-money fields (timeouts, limits) — implicit 64-bit float, not
  a sized integer.

**Adoption surface (TS-portable subset):**
- Add runtime assertions in `postTransaction`, `capture`, `refund`, `void`,
  `settle` for invariants the spec docs (06-invariants.md) call out.
  E.g., assert `customer_holds === 0n` after capture/void/expire (currently
  tested but not asserted in code).
- Add bounded-iteration guards on any future loops over user-supplied data.
- Audit error paths for swallowed catches.

**Applicability:** LOW (already done) for money math, integer types,
idempotency. MEDIUM for assertion density discipline.

---

### 6. Hash-chained immutable ledger records for tamper detection

**Evidence (safety docs):**
> Storage Fault Tolerance: TigerBeetle assumes disk failure will occur.
> The system uses immutable, checksummed, hash-chained data for corruption
> detection and repair.

Each record references the hash of the prior record. Any tampering
invalidates the chain. Audit-grade tamper-evidence built into the storage
format.

**Engine current state:** Ledger entries are immutable per project spec
(no UPDATE, no DELETE) — enforced at the application level. Postgres-level
trigger-based prevention of UPDATE/DELETE on `ledger_entries` is mentioned
as optional in `docs/06-invariants.md:43-46` but isn't implemented in the
schema. No hash-chaining.

**Adoption surface (TS+Postgres):**
- Add a `prev_hash` and `hash` column to `ledger_entries`.
- Compute hash at insert: `sha256(prev_hash || canonical_serialization(this_entry))`.
- The first entry per partition uses zero or a genesis hash.
- A tamper-detection job periodically scans the chain and flags
  discrepancies.

**Caveats:**
- Adds CPU per insert (hash computation).
- Postgres-side BEFORE INSERT trigger needs to compute the hash relative to
  the most-recent entry, which is a serialization point for inserts (per
  partition). May affect concurrent throughput.
- Only useful if the threat model includes "operator with database write
  access tampers with ledger." For most v1 SMB engines, this isn't in scope.

**Applicability:** LOW for v1. Worth a v2 audit-feature marker if
compliance/regulatory scope appears.

---

### 7. Pessimistic balance validation at Phase 1

**Evidence (two-phase-transfers docs):**
> Pessimistic Validation: Account balance constraints are checked during
> Phase 1, preventing failures during Phase 2.

When a pending transfer is created, TigerBeetle checks the account flag
constraints (e.g., `credits_must_not_exceed_debits`) immediately. If the
pending would violate a flag, the pending fails. The corresponding post or
void cannot fail for balance reasons because the resources were already
reserved.

**Engine current state:** Authorize creates `customer_holds` debit and
`customer_funds` credit. There's NO check that `customer_funds` has the
funds available — the engine doesn't model the customer's actual balance.
That's because the engine is a payment-processor model (we ARE the
processor; the customer's bank validates the funds, not us). The pending
balance check would only matter if the engine grew a "wallet" model where
customers have balances WITH us.

**Adoption surface:** Tied to take #1 (account flags). Worth marking only if
the product moves to a wallet-balance model.

**Applicability:** N/A for current engine; could become HIGH if the engine
adds a customer-wallet feature.

---

## Conflicts

The Tigerstyle "static memory allocation only" principle directly conflicts
with TS/V8/Bun's GC runtime model. There is no path to adopt this in TS
short of a runtime rewrite. The principle's INTENT — predictable latency,
no allocation surprises — partially survives via "use bounded data
structures" and "don't allocate on hot paths" disciplines, but the
guarantee TigerBeetle gets does not transfer.

The "single-core sequential execution" guarantee similarly does not
transfer to a Postgres-backed engine. The end-to-end idempotency PRINCIPLE
that TigerBeetle cites in the same paragraph DOES transfer and is already
implemented in this engine.

The two-phase transfer architecture (#2) and the existing multi-capture
decision ([[2026-04-26-multi-capture-model]]) are both valid models but
implement different shapes. Adopting #2 would re-shape the multi-capture
implementation in flight. The conflict is timing, not principle.

## Conditions

- **#1 (account flags):** applies cleanly. Conditions: the per-account
  invariant must be expressible as "balance is signed in direction X." For
  more complex invariants (e.g., "balance must be within range [a,b]"),
  TigerBeetle has no flag for it and neither would this engine.
- **#2 (two-phase transfer primitive):** applies cleanly only if the
  refactor budget exists. v1 already shipped a different shape. Best window
  is v2 boundary, not now.
- **#3 (VOPR-style testing):** the PATTERN applies; the implementation does
  not. A TS port loses simulated time and 1000x speedup but keeps
  determinism, fault injection, and replayability. Bug-finding power is
  proportional to fault-coverage breadth.
- **#5 (Tigerstyle):** applies as a code-discipline standard. Doesn't
  require code changes today; requires a review checklist.
- **#6 (hash-chain):** applies only when audit/regulatory scope demands
  tamper evidence. Not v1.

## Open threads

- **What does TigerBeetle's `code` field carry semantically?** The data-
  modeling doc describes it as "indicates account type" or "indicates
  purpose (purchase, refund, currency exchange, etc.)" but doesn't define
  the codespace. The engine's `ledger_transactions.description` and
  `reference_type` fields cover similar ground; whether there's a richer
  taxonomy worth importing is unanswered.
- **How does TigerBeetle handle multi-capture analogues?** The two-phase
  docs only show single-shot post or void. A real-world multi-shipment
  flow needs partial posts. Current docs may not cover the canonical
  pattern; deeper code reading needed.
- **What's the current state of VOPR after Jepsen 0.16.11?** The 2023 blog
  post is the visible primary source on liveness mode. The Jepsen analysis
  is more recent but wasn't deep-fetched in this entry; should be examined
  if the engine adopts simulation-style testing.
- **Tigerstyle's assertion-density discipline in non-Zig codebases:** is
  there evidence of TS or Go projects adopting "two assertions per
  function" successfully without Zig's compile-time guarantees? Open.
