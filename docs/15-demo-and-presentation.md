# Demo & Presentation — 5 Minutes to Prove You're Not Playing

> **STATUS (2026-04-26): SUPERSEDED.** This doc planned a synchronous
> 5-minute live-terminal demo with a bespoke CLI harness. The current
> presentation strategy uses a different surface stack:
>
> - **Astro + Vercel landing page** as the first-impression surface
>   (per `[[2026-04-26-surface-architecture-landing-page]]`)
> - **2-minute Loom walkthrough** with bug-find-and-fix story (60s) +
>   architecture walkthrough (60s), embedded on both surfaces
>   (per `[[2026-04-26-loom-walkthrough-content]]`)
> - **asciinema-curl recording** of the live Railway API for the
>   landing-page hero asset
>   (per `[[2026-04-26-readme-cli-and-landing-asset]]`)
> - **Case-study README** as the GitHub-landing technical-deep-dive
>   surface
>
> The bespoke CLI harness this doc specifies is NOT built. Section 1's
> 5-minute structure remains useful as REFERENCE for the synchronous
> live-demo case (e.g., a CTO interview screen-share), but it's no longer
> the primary presentation surface. The asciinema-curl recording is the
> closest equivalent for hero-asset use.
>
> Original doc preserved below for reference.

---

A CTO has decided whether you're serious before you finish your second
sentence. This document defines the demo — what to show, in what order, and
what to say. No slides. No Postman screenshots. A live terminal hitting a real
database.

The demo has one goal: prove this payment engine handles real money correctly,
even when things go wrong. The happy path is table stakes. Failure handling is
the demo.

---

## 1. The 5-Minute Structure

```
Act 1: "Here's a payment"           45 seconds    Setup credibility
Act 2: "Now break it"              120 seconds    The actual demo
Act 3: "Prove it"                   60 seconds    The mic drop
Act 4: "Explore it yourself"        60 seconds    Hand over control
                                   ───────────
                                   ~5 minutes
```

Every second is accounted for. No "let me just find that endpoint." No "hold
on, let me restart the server." The CLI harness handles everything.

---

## 2. Act 1 — "Here's a Payment" (45 seconds)

**What the CTO sees:**

```
┌─────────────────────────────────────────────────────┐
│  PAYMENT ENGINE DEMO                                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Creating payment: $150.00 USD                      │
│  ├── POST /api/v1/payments/authorize                │
│  ├── Status: 201 Created (23ms)                     │
│  ├── Payment ID: pay_01HX7Y9ABC...                  │
│  └── Status: authorized                             │
│                                                     │
│  Capturing payment: $150.00                         │
│  ├── POST /api/v1/payments/pay_01HX.../capture      │
│  ├── Status: 200 OK (31ms)                          │
│  └── Status: captured                               │
│                                                     │
│  LEDGER ENTRIES:                                    │
│  ┌────────────────────┬──────────┬─────────┐        │
│  │ Account            │ Debit    │ Credit  │        │
│  ├────────────────────┼──────────┼─────────┤        │
│  │ customer_holds     │ $150.00  │         │  auth  │
│  │ customer_funds     │          │ $150.00 │  auth  │
│  │ customer_funds     │ $150.00  │         │  cap   │
│  │ customer_holds     │          │ $150.00 │  cap   │
│  │ customer_funds     │ $145.50  │         │  cap   │
│  │ merchant_payable   │          │ $145.50 │  cap   │
│  │ customer_funds     │   $4.50  │         │  cap   │
│  │ platform_fees      │          │   $4.50 │  cap   │
│  ├────────────────────┼──────────┼─────────┤        │
│  │ TOTAL              │ $450.00  │ $450.00 │   ✓    │
│  └────────────────────┴──────────┴─────────┘        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**What you say:**

> "This is a payment engine. Authorize holds funds, capture charges them.
> Every operation creates double-entry ledger entries — debits always equal
> credits. The 3% platform fee is split out automatically. This is the same
> accounting model Stripe uses internally."

**What this proves:** You understand how money actually moves. Not a balance
field that gets incremented — a real ledger.

---

## 3. Act 2 — "Now Break It" (2 minutes)

This is the demo. Five attacks, five clean failures.

### Attack 1: Double Capture

```
  ATTACK: Double capture (5 concurrent requests)
  ├── Request 1: 200 OK  — captured ✓
  ├── Request 2: 409 Conflict — "Payment is not in 'authorized' status"
  ├── Request 3: 409 Conflict — "Payment is not in 'authorized' status"
  ├── Request 4: 409 Conflict — "Payment is not in 'authorized' status"
  └── Request 5: 409 Conflict — "Payment is not in 'authorized' status"

  Result: Exactly 1 capture. Pessimistic locking. No double charge.
```

**What you say:**

> "Five concurrent capture requests. One succeeds, four get a clean 409. This
> is SELECT FOR UPDATE — the database locks the row. No race condition, no
> double charge. Even if the client retries aggressively."

### Attack 2: Idempotency

```
  ATTACK: Retry with same idempotency key
  ├── Request 1: 201 Created — pay_01HX... (new payment)
  ├── Request 2: 201 Created — pay_01HX... (cached response, same ID)
  └── Request 3: 201 Created — pay_01HX... (cached response, same ID)

  Payments created: 1 (not 3)
  Ledger entries: 2 (not 6)
```

**What you say:**

> "Same idempotency key, three requests. One payment created. The second and
> third return the cached response — same payment ID, same status, same
> amounts. Networks are unreliable. Clients retry. This makes retries safe."

### Attack 3: Overspend

```
  ATTACK: Refund more than captured
  ├── Captured amount: $150.00
  ├── Refund $100.00: 200 OK — partially_refunded ✓
  ├── Refund $100.00: 422 Unprocessable
  │   └── "Refund amount $100.00 exceeds refundable amount $50.00"
  │       requested: 10000, maximum_allowed: 5000
  └── Refund  $50.00: 200 OK — refunded ✓ (exact remaining)

  Total refunded: $150.00 (exactly captured amount, not a cent more)
```

**What you say:**

> "Captured $150. Refunded $100. Tried to refund another $100 — rejected,
> because only $50 remains. The error tells the client exactly how much they
> can refund. Then $50 succeeds. The database constraint makes overspending
> physically impossible."

### Attack 4: State Machine Violation

```
  ATTACK: Invalid state transitions
  ├── Void a captured payment:  409 — "Cannot void, status is 'captured'"
  ├── Capture a voided payment: 409 — "Cannot capture, status is 'voided'"
  ├── Refund an authorized:     409 — "Cannot refund, status is 'authorized'"
  └── Capture an expired:       409 — "Cannot capture, status is 'expired'"

  Every error includes: payment_id, current_status, attempted_action
```

**What you say:**

> "You can't skip steps. You can't go backwards. The state machine is
> enforced server-side — the client never tells us what state to be in.
> They request actions, and we determine the transition."

### Attack 5: Concurrent Refund Race

```
  ATTACK: 10 concurrent $20 refunds on a $150 capture
  ├── Refund 1:  200 OK  — partially_refunded ($20)
  ├── Refund 2:  200 OK  — partially_refunded ($40)
  ├── Refund 3:  200 OK  — partially_refunded ($60)
  ├── Refund 4:  200 OK  — partially_refunded ($80)
  ├── Refund 5:  200 OK  — partially_refunded ($100)
  ├── Refund 6:  200 OK  — partially_refunded ($120)
  ├── Refund 7:  200 OK  — partially_refunded ($140)
  ├── Refund 8:  200 OK  — refunded ($150 — exact limit)
  ├── Refund 9:  422 — exceeds refundable amount
  └── Refund 10: 422 — exceeds refundable amount

  Total refunded: $150.00 (capped at captured, serialized by FOR UPDATE)
```

**What you say:**

> "Ten concurrent $20 refunds on a $150 capture. Seven partial refunds succeed,
> one hits the exact cap at $150, two are rejected. The pessimistic lock
> serializes them — no race condition can overspend. Every refund created
> balanced ledger entries."

---

## 4. Act 3 — "Prove It" (1 minute)

### The God Check

```
  ══════════════════════════════════════════════════════
   GOD CHECK: System-Wide Balance Verification
  ══════════════════════════════════════════════════════

   Total debits across all ledger entries:  $4,250.00
   Total credits across all ledger entries: $4,250.00
   Difference: $0.00

   ✓ SYSTEM BALANCED — No money created or destroyed.

   Transactions verified: 47
   Entries verified: 142
   Every transaction balanced individually: ✓
  ══════════════════════════════════════════════════════
```

**What you say:**

> "After all of that — concurrent captures, retries, partial refunds, rejected
> attacks — total debits equal total credits. Zero cents unaccounted for. This
> check runs after every test in the suite. If it ever fails, something is
> fundamentally broken."

### The Test Run

```
  Running tests...

  tests/unit/state-machine.test.ts         80 pass
  tests/unit/validation.test.ts            30 pass
  tests/unit/money.test.ts                 30 pass
  tests/unit/balance-computation.test.ts   15 pass
  tests/unit/id-generation.test.ts         10 pass
  tests/integration/ledger/                25 pass
  tests/integration/payments/              50 pass
  tests/integration/concurrency/           15 pass
  tests/integration/invariants/            18 pass
  tests/e2e/                               20 pass
  tests/load/                              10 pass
  tests/property/                          52 pass
  tests/reconciliation/                    10 pass
  tests/fuzz/                               4 pass
  tests/migration/                          4 pass
  tests/performance/                        4 pass
  tests/meta/                               6 pass

  ✓ 420+ tests passed in 8.3s
```

**What you say:**

> "420 tests. Unit, integration, E2E, property-based, fuzz, load, and
> financial reconciliation. Every invariant verified. Every edge case covered.
> Every race condition tested. This runs in under 10 seconds."

---

## 5. Act 4 — "Explore It Yourself" (1 minute)

Open a browser tab to the deployed Scalar docs.

```
  API Documentation: https://[deployed-url]/docs

  ┌─────────────────────────────────────────┐
  │  Payment Engine API  v1.0.0             │
  │                                         │
  │  Payments                               │
  │  ├── POST /authorize                    │
  │  ├── POST /:id/capture                  │
  │  ├── POST /:id/void                     │
  │  ├── POST /:id/refund                   │
  │  ├── GET  /:id                          │
  │  └── GET  /                             │
  │                                         │
  │  Ledger                                 │
  │  ├── GET  /payments/:id/ledger          │
  │  └── GET  /accounts/:id/balance         │
  │                                         │
  │  System                                 │
  │  └── GET  /health                       │
  │                                         │
  │  [Try It Out →]                         │
  └─────────────────────────────────────────┘
```

**What you say:**

> "Full OpenAPI 3.1 spec, auto-generated from the Zod schemas that also
> validate requests at runtime and enforce TypeScript types at compile time.
> One source of truth — change a schema, and the docs, validation, and types
> all update. You can try any endpoint directly from this page."

---

## 6. The CLI Demo Harness

The demo is driven by a single script: `bun run demo`.

### Architecture

```
scripts/
└── demo.ts          # The demo harness
```

The harness:
- Runs against the live API (local or deployed)
- Uses real HTTP requests (not service-level calls)
- Formats output with color and structure
- Pauses between acts for narration (configurable)
- Runs the god check via the API, not direct SQL
- Is idempotent (can be run repeatedly without cleanup)

### Implementation Sketch

```typescript
// scripts/demo.ts

const BASE_URL = process.env.DEMO_URL || "http://localhost:3000";

async function act1_happyPath() {
  header("ACT 1: Here's a Payment");

  const auth = await post("/api/v1/payments/authorize", {
    amount: 15000,
    currency: "USD",
    description: "Demo order #1",
  });
  show("Authorized", auth);

  const captured = await post(`/api/v1/payments/${auth.id}/capture`);
  show("Captured", captured);

  const ledger = await get(`/api/v1/payments/${auth.id}/ledger`);
  showLedgerTable(ledger);

  pause("Every debit has a matching credit. The books balance.");
}

async function act2_breakIt() {
  header("ACT 2: Now Break It");

  await attack_doubleCaptureRace();
  await attack_idempotencyRetry();
  await attack_overspend();
  await attack_stateMachineViolation();
  await attack_concurrentRefundRace();
}

async function act3_proveIt() {
  header("ACT 3: Prove It");

  await godCheck();
  await runTestSuite();
}

async function act4_explore() {
  header("ACT 4: Explore It Yourself");

  print(`API Documentation: ${BASE_URL}/docs`);
  print(`OpenAPI Spec:      ${BASE_URL}/openapi.json`);
  print(`Health Check:      ${BASE_URL}/health`);
}

// --- Run ---
await act1_happyPath();
await act2_breakIt();
await act3_proveIt();
await act4_explore();
```

### Helper Functions

```typescript
let keyCounter = 0;

function uniqueKey(): string {
  return `ik_demo_${Date.now()}_${++keyCounter}`;
}

async function post(path: string, body?: object) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": uniqueKey(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json()) };
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

function header(text: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${"═".repeat(60)}\n`);
}

function show(label: string, data: object) {
  console.log(`  ${label}:`);
  console.log(`    ${JSON.stringify(data, null, 2).split("\n").join("\n    ")}`);
}

function showLedgerTable(ledger: LedgerResponse) {
  // Format entries as a table with Account | Debit | Credit columns
  // Show the total row with a balance check mark
}

function pause(narration: string) {
  console.log(`\n  → ${narration}\n`);
}
```

### Running the Demo

```bash
# Against local (development)
bun run demo

# Against deployed Supabase instance
DEMO_URL=https://your-payment-engine.fly.dev bun run demo

# With pauses between acts (for live presentation)
DEMO_PAUSE=true bun run demo
```

### package.json Script

```json
{
  "scripts": {
    "demo": "bun run scripts/demo.ts"
  }
}
```

---

## 7. Deployment Checklist (Before the Demo)

The demo runs against a live, deployed instance. Not localhost.

### Pre-Demo

```
□ Supabase project active (not paused)
□ DATABASE_URL set to Supabase direct connection (port 5432)
□ DATABASE_SSL=true
□ Migrations run: bun run db:migrate
□ Accounts seeded: bun run db:seed
□ Server deployed and responding: curl https://[url]/health
□ /docs loads in browser (Scalar UI renders)
□ OpenAPI spec accessible: curl https://[url]/openapi.json
□ Demo harness tested once: DEMO_URL=https://[url] bun run demo
□ Database clean (no leftover data from previous runs)
```

### Deployment Options

| Option | Effort | Impression |
|---|---|---|
| **Fly.io** | Low — Dockerfile, `fly deploy` | Real deployment, custom domain possible |
| **Railway** | Low — connect repo, auto-deploy | Git push deploys |
| **Local + ngrok** | Minimal — `ngrok http 3000` | Works but feels hacky for a CTO demo |
| **VPS (DigitalOcean/Hetzner)** | Medium — manual setup | Maximum control |

For god-complex: **Fly.io** or **Railway**. Real deployment, real URL, real
SSL. Not ngrok.

---

## 8. What NOT to Show

A CTO demo is about density, not coverage. These are traps:

| Trap | Why It Bores |
|---|---|
| Walking through code files | "Let me show you my service.ts" — they don't care about your code, they care about what it does |
| Explaining the architecture doc | They can read. Show, don't tell. |
| Running individual test files | Run the full suite once. The number matters, not the individual tests. |
| Showing the database schema | The ledger table proves itself through the entries. No one wants to see CREATE TABLE. |
| Explaining double-entry bookkeeping | The ledger table in Act 1 explains itself. Two columns. They balance. Done. |
| Demoing GET endpoints | Reads are boring. Writes that handle failure are impressive. |
| Talking about "what I would add" | Ship what you have. Future features are excuses. |

### The One Exception

If the CTO asks "how does X work?" — THEN you show the code. Showing code
on request is engineering depth. Showing code unprompted is a lecture.

---

## 9. The Narrative Arc

The demo tells a story:

```
1. "This is a payment engine."              ← Credibility
2. "Every cent is tracked."                 ← Domain knowledge
3. "Try to break it."                       ← Confidence
4. "It doesn't break."                      ← Proof
5. "Prove it mathematically."               ← The god check
6. "420 tests agree."                       ← Engineering rigor
7. "Explore it yourself."                   ← Openness
```

The story moves from "what is this?" to "does it work?" to "prove it" to
"I believe you." Each act answers the question the CTO is thinking at that
moment.

After 5 minutes, the CTO knows:
- You understand how money moves in financial systems
- You've built something that handles real-world failure modes
- The system is provably correct, not just "it works on my machine"
- The engineering quality is production-grade
- You can explain complex systems concisely

That's the demo. Not a tour of your codebase. A proof that it works.

---

## 10. When to Build This

The demo harness is built in **Phase 4** (API layer), after all routes exist.
The demo script depends on:
- All API endpoints working (Phase 4)
- All tests passing (Phases 2-4)
- Deployment infrastructure (Phase 4, post-routes)

The harness is NOT part of the test suite. It's a presentation tool. It uses
the public API, not internal services. It's the client's view of the system.

---

Previous: [14 — Development Flow](./14-development-flow.md) | Next: [16 — Deployment](./16-deployment.md)
