---
type: research
features: [code-style, testing, ledger]
related: ["[[2026-04-26-tigerbeetle-takes-survey]]", "[[2026-04-26-tigerstyle-and-tigerbeetle-in-ts-adoption]]"]
created: 2026-04-26
confidence: high
---

# Which Tigerstyle coding-level patterns port directly to a TS payment engine, and where do they degrade?

## Question

The prior survey ([[2026-04-26-tigerbeetle-takes-survey]]) covered
ARCHITECTURE-level takes (account flags, two-phase transfers, simulation
testing). This entry catalogs CODE-level patterns — the line-by-line
discipline rules — and rates each on TS-portability so the engine owner
can pick a shortlist in design mode.

## Sources examined

- [github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) — full Tigerstyle guide (fetched 2026-04-26)
- [double-trouble.dev/post/negativ-space-programming/](https://double-trouble.dev/post/negativ-space-programming/) — negative-space-programming pattern (fetched 2026-04-26)
- TigerBeetle source: `src/state_machine.zig`, `src/lsm/tree.zig` (assertion-density sample: tree.zig contains ~55 `assert(...)` calls across the file)
- NASA Power-of-Ten safety-critical rules (referenced by Tigerstyle as the inspiration)

## Findings — TS-portable patterns (HIGH portability)

### 1. Two assertions per function (average), in production code

**Tigerstyle quote:** "Functions must average a minimum of two assertions
per function."

**Mechanics:** assertions detect programmer errors at runtime. They run in
production, not just tests. Examples include argument bounds checks,
precondition checks, postcondition checks, and invariant maintenance.

**TS port:**
- `import { strict as assert } from "node:assert"` — built-in, runtime-active
- Or a custom `invariant(condition, message): asserts condition` function
- Throw a typed `InvariantError` extending the existing `AppError` pattern in
  `src/shared/errors.ts` so the error handler routes them as
  `internal_error` (500)
- Production-mode is the key: TS culture often gates assertions to
  `process.env.NODE_ENV === 'development'`. Tigerstyle's principle is the
  opposite — production is exactly where you need them most

**Applicability for this engine:** the existing `verifySystemBalance()` in
`tests/helpers/god-check.ts` IS an assertion. The pattern is to lift that
discipline from test-helpers into service-function entry/exit points.

### 2. Positive AND negative space assertions

**Tigerstyle quote:** "Assert the positive space that you do expect AND to
assert the negative space that you do not expect, because where data moves
across the valid/invalid boundary between these spaces is where interesting
bugs are often found."

**Mechanics:** for every property X you expect, also explicitly assert
`!X_violation` to catch errors that fall through the valid-condition check.

**TS port:** straightforward. Concrete example in this engine's domain:

```ts
// Positive space: capturedAmount must equal what we just set
assert(updated.capturedAmount === expectedCapturedAmount);
// Negative space: capturedAmount must NEVER exceed authorizedAmount
assert(updated.capturedAmount <= updated.authorizedAmount);
// Negative space: refundedAmount must NEVER exceed capturedAmount
assert(updated.refundedAmount <= updated.capturedAmount);
```

The negative-space assertions catch DB-CHECK-constraint-evading bugs, race
conditions that violate invariants, or future code paths that mutate state
without going through the service.

**Applicability:** very high. The 12 invariants in `docs/06-invariants.md`
each map to at least one negative-space assertion at the service-layer
boundary.

### 3. Pair assertions — at least two enforcement points per property

**Tigerstyle quote:** "Find at least two different code paths where an
assertion can be added."

**Mechanics:** for each invariant, find multiple places where it can be
checked. Belt-and-suspenders defense. If one path is broken or removed,
the other catches it.

**TS port (examples for this engine):**
- `captured_amount <= authorized_amount`: enforced at DB level (`capture_limit`
  CHECK constraint at `src/payments/schema.ts:40`), at service-validation
  level (`if (captureAmount > row.authorizedAmount) throw`), and assertable
  at update-return level (`assert(updated.capturedAmount <= updated.authorizedAmount)`)
- Currently 2 of 3 paths enforced. The third (post-update assertion) is the
  Tigerstyle-recommended addition.

**Applicability:** high. Audit pass over the 12 invariants to count
enforcement paths and add the missing one each time.

### 4. Hard 70-line function limit

**Tigerstyle quote:** "Hard limit of 70 lines per function maximum."

**Mechanics:** mechanical bound on cognitive complexity. Forces extraction
when functions grow.

**TS port:** Biome (already used in this project) supports `max-lines-per-function`
through linting. ESLint rule:
`max-lines-per-function: ["error", { max: 70, skipBlankLines: true }]`.
Applies cleanly.

**Applicability concrete count for this engine:**
- `src/payments/service.ts` `refund()` is currently >70 LOC including its
  validation and ledger-posting block. Would need extraction.
- Most other service functions are under 70.

### 5. No recursion

**Tigerstyle quote:** "Do not use recursion to ensure that all executions
that should be bounded are bounded."

**Mechanics:** recursion can be unbounded by design or by bug. Iteration
with explicit bounds is always finite.

**TS port:** trivial. `eslint-plugin-no-recursion` exists; or
`no-restricted-syntax` with a recursion AST pattern.

**Applicability for this engine:** unlikely to bite — no obvious recursion
in current code. A code-review rule, not a refactoring need.

### 6. All errors handled, no swallowed catches

**Tigerstyle quote:** "All errors must be handled. Almost all (92%) of the
catastrophic system failures are the result of incorrect handling of
non-fatal errors."

**Mechanics:** every error path has an explicit handler. No silent catches,
no empty catch blocks.

**TS port:** ESLint rules `no-empty`, `@typescript-eslint/no-useless-catch`,
`@typescript-eslint/only-throw-error`. The user's existing
`src/shared/errors.ts` uses typed AppError hierarchy — discipline is
already there for typed errors; the missing piece is enforcing that nothing
is caught-and-discarded.

**Applicability:** medium-high. Existing code is mostly aligned; lint config
to enforce.

### 7. Compound assertions split into single-property asserts

**Tigerstyle quote:** "Prefer `assert(a); assert(b);` over `assert(a and b);`"

**Mechanics:** when an assertion fails, you know exactly which property
broke. `assert(a && b && c)` failing tells you only that ONE of three
broke.

**TS port:** trivial. Pure discipline.

**Applicability:** high. Discipline rule.

### 8. Variable naming — units last, descending significance

**Tigerstyle quote:** "Add units or qualifiers to variable names, placing
them last in descending significance. Prefer `latency_ms_max` over
`max_latency_ms` to group related variables."

**Mechanics:** sortable, groupable, less ambiguous. `latency_ms_min`,
`latency_ms_max`, `latency_ms_p95` line up.

**TS port:** pure naming convention. camelCase analog: `latencyMsMax`,
`latencyMsP95`.

**Applicability for this engine:** check `src/shared/money.ts` and service
functions for ambiguous units. Mostly already aligned because BigInt cents
is unambiguous, but `expiresAt`/`expiresAtMs`/`expiresAtSec` could benefit.

### 9. Variable scope minimization, declare close to use

**Tigerstyle quote:** "Declare variables at the smallest possible scope.
Calculate or check variables close to where/when used."

**Mechanics:** less surface area for wrong-variable bugs.

**TS port:** discipline rule, ESLint can help via `no-var`,
`prefer-const`, `block-scoped-var`.

**Applicability:** existing TS practice mostly aligns; review-time
discipline.

### 10. Single-purpose helper functions named with caller prefix

**Tigerstyle quote:** "Prefix helper function names with calling function
name to show call history."

**Example:** if `capture()` calls a helper to compute fee split, the helper
is named `capture_compute_split()` not `compute_split()`.

**Mechanics:** call history visible at the call site without jump-to-definition.

**TS port:** trivial; pure naming.

**Applicability:** discretionary. Helper-heavy codebases benefit; service
functions like `paymentService.capture()` that call `splitAmount()` and
`generateId()` are general-purpose helpers, not capture-specific. Pattern
applies when extracting capture-specific helpers.

### 11. Tests assert exhaustively, including invalid-data transitions

**Tigerstyle quote:** "Tests must test exhaustively, not only with valid
data but also with invalid data, and as valid data becomes invalid."

**Mechanics:** tests cover invalid input AND the boundary where valid input
becomes invalid (e.g., a sequence where a once-valid payment becomes
expired).

**TS port:** the engine already has fuzz tests
(`tests/fuzz/validation-fuzz.test.ts`) and property tests
(`tests/property/random-sequences.test.ts`). The "valid becomes invalid"
boundary is exactly what `tests/integration/payments/expiration.test.ts`
addresses. Pattern is already partially adopted.

**Applicability:** check if every state-transition boundary has a "valid
becomes invalid" test. Likely some do, some don't.

### 12. Comments motivate ("why"), code documents ("what")

**Tigerstyle quote:** "Don't forget to say why. Code alone is not
documentation."

**Mechanics:** every non-obvious comment explains motivation. Code shows
mechanics; comments explain reasoning.

**TS port:** discipline rule. Existing engine docs do this well at the
docs/ level; in-code comments are sparse, which means low surface area to
violate but also low coverage.

**Applicability:** discretionary. Apply on new code; don't retrofit.

## Findings — MEDIUM portability (TS analog exists with degradation)

### 13. Bounded loops and queues

**Tigerstyle quote:** "Put a limit on everything including all loops and
queues to prevent infinite loops and tail latency spikes."

**Mechanics:** every loop has a compile-time-known maximum iteration count.
Every queue has a maximum depth. No unbounded `while (cond)` or
`for (item of stream)` without an iteration cap.

**TS port (degraded):** TS has no compile-time loop bounds. You can
runtime-assert:

```ts
let iterations = 0;
const MAX = 10_000;
for (const x of items) {
  assert(++iterations <= MAX, `loop exceeded ${MAX} iterations`);
  // ...
}
```

Less rigorous than Zig's compile-time bound, but defends against
runaway loops.

**Applicability for this engine:** check fuzz/property test loops, list
endpoints, retry loops. The `tests/property/random-sequences.test.ts` runs
fixed-iteration loops that already comply. Pagination is already bounded
via `limit`. Scope of work is small.

### 14. Static memory allocation at startup

**Tigerstyle quote:** "All memory must be statically allocated at startup.
No memory may be dynamically allocated (or freed and reallocated) after
initialization."

**Mechanics:** eliminates allocation latency, fragmentation, use-after-free.

**TS port (heavily degraded):** V8/Bun GC means dynamic allocation is
unavoidable. The portable principle is "don't allocate on hot paths" —
e.g., reuse buffers in tight loops, prefer object pools for frequently-
created objects, avoid creating closures inside hot loops. The Tigerstyle
GUARANTEE doesn't transfer; the SPIRIT does as a discipline.

**Applicability for this engine:** v1 doesn't have hot loops. v2 if
benchmarking shows GC pressure on a specific path.

### 15. Explicitly-sized types

**Tigerstyle quote:** "Use explicitly-sized types like `u32` rather than
architecture-specific types."

**Mechanics:** prevents 32-vs-64-bit silent behavior changes.

**TS port:** TS has only `number` (64-bit float) and `bigint`. The relevant
TS analog is "use `bigint` for any quantity where overflow at 2^53 matters,"
which the engine already does for money. Counts/IDs that fit in 53 bits
stay as `number`.

**Applicability:** already aligned per
[[2026-04-26-amount-wire-format]]. No further work.

### 16. Return-value preference: `void > bool > u64 > ?u64 > !u64`

**Tigerstyle quote:** "Use simpler function signatures to reduce
dimensionality at call site. Return value hierarchy by preference: `void`
> `bool` > `u64` > `?u64` > `!u64`."

**Mechanics:** narrower return types are easier to reason about. Optional
and error-bearing types are last resort.

**TS port:** analog: prefer `void` over `T`, prefer `T` over `T | null`,
prefer `T | null` over `T | Error`. TS doesn't enforce ordering, but the
discipline is "make signatures the smallest type that can carry the
result."

**Applicability:** discretionary review at function-design time.

## Findings — LOW or N/A portability

### 17. `zig fmt`, 4-space indent, snake_case files
TS has Biome with its own conventions. N/A.

### 18. Pass arguments larger than 16 bytes as `*const`
TS objects are by-reference. N/A.

### 19. Allocator/tracer positional argument convention
N/A in TS.

### 20. `@This()` aliasing
TS has `typeof this`. Pattern doesn't apply.

### 21. Don't react to external events directly; run program at own pace (batching loop)
This IS portable in principle but is an architectural pattern, not a
coding-level logic. Better fit for a separate design entry if pursued.

## Conflicts

The "production assertions" rule conflicts with TS ecosystem norms. Most
TS codebases gate assertions to development via `process.env.NODE_ENV` or
strip them entirely in production. Tigerstyle's position is the opposite:
production is exactly where assertions catch the bugs you didn't see in
test. A discipline change is required, not just a tool change.

The "70-line function limit" conflicts with the engine's current
`paymentService.refund()` function (currently >70 LOC). Adopting this rule
forces an extraction that is mechanical but real.

The "two assertions per function average" rule does not have an obvious
auto-enforce in TS — counting assertions per function is not a standard
linter capability. ESLint AST-traversal rules can be written for it; not
out-of-the-box.

## Conditions

- **Assertion patterns (#1, #2, #3):** apply cleanly. Discipline + small
  utility function + production-mode operation.
- **Function-shape rules (#4, #5):** apply via Biome/ESLint config. One
  refactor (refund function) needed.
- **Naming conventions (#8, #10):** discretionary; pure rename with
  no behavior change.
- **Loop bounds (#13):** apply with runtime-assertion degradation. Less
  rigorous than Zig's compile-time but defends against runaway.
- **All errors handled (#6):** existing AppError discipline is most of the
  way there; lint config to enforce.

## Open threads

- **Is there a community ESLint plugin that enforces "minimum two
  assertions per function"?** Custom AST rule possible; off-the-shelf
  unlikely. Open to investigation.
- **What's the runtime cost of leaving assertions on in production for a
  TS payment service?** TigerBeetle's claim is "negligible" because Zig
  asserts compile to single instructions. TS `assert()` is a function call
  with overhead. Whether this matters at scale is open. Probably small for
  service-boundary asserts; could matter for hot loops (which v1 doesn't
  have).
- **Are there documented TS codebases that adopted Tigerstyle assertion
  discipline and reported the cost / benefit?** Per
  [[2026-04-26-tigerstyle-and-tigerbeetle-in-ts-adoption]], answer is no.
  Open thread carried forward.
- **Tigerstyle's "Don't react to external events directly; run at own
  pace" principle** — this is a batching architecture pattern (the engine
  pulls work from a queue rather than reacting to each request as it
  arrives). Not a coding-level pattern but a design-level one. If
  attractive, deserves its own design entry.
