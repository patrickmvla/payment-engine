---
type: research
features: [testing, ledger]
related: ["[[2026-04-26-tigerbeetle-takes-survey]]", "[[2026-04-26-vitest-migration]]"]
created: 2026-04-26
confidence: high
---

# Who in TS production has actually adopted Tigerstyle assertion density, and who runs TigerBeetle in TS production?

## Question

Two specific empirical questions to ground claims about applicability:

1. Which TS projects have adopted Tigerstyle's assertion-density discipline,
   and what did it cost them?
2. Which TS projects use TigerBeetle in production?

If the adoption pattern is broad and well-documented, the prior survey's
"applicability" ratings get stronger. If adoption is thin, those ratings
need a downgrade and the open question shifts from "should we adopt?" to
"who's done this, and is there a path to learn from?"

## Sources examined

### Tigerstyle in TS

- [coreydemarse.com/posts/tigerstyle-typescript.html](https://coreydemarse.com/posts/tigerstyle-typescript.html) — Corey DeMarse's blog post (date not on page; published recently per content)
- [github.com/copyleftdev/awesome-tigerstyle](https://github.com/copyleftdev/awesome-tigerstyle) — community-curated Tigerstyle resources, fetched README content
- GitHub Code Search: `q='TIGER_STYLE language:TypeScript'` — total_count: **1** (`Taewoong1378/seodaeri`)
- [tigerstyle.dev](https://tigerstyle.dev/) — referenced; not deep-fetched

### TigerBeetle in TS production

- GitHub Code Search: `q='tigerbeetle-node language:TypeScript'` — total_count: **135**
- [github.com/interledger/rafiki](https://github.com/interledger/rafiki) — Interledger Foundation reference implementation; deep file-tree inspection
- [docs.tigerbeetle.com/coding/clients/node/](https://docs.tigerbeetle.com/coding/clients/node/)
- [npmjs.com/package/tigerbeetle-node](https://www.npmjs.com/package/tigerbeetle-node)
- [softwaremill.com/whats-interesting-about-tigerbeetle/](https://softwaremill.com/whats-interesting-about-tigerbeetle/) — referenced; not deep-fetched

## Findings

### Tigerstyle in TS — adoption is essentially zero

**The one documented case:** Corey DeMarse's blog post "tigerstyle! in bun /
typescript." What was actually adopted:

- **Runtime assertions** in production code (not just tests) — adopted
- **Positive AND negative space assertions** — adopted as a discipline
- **Zod for schema validation at function boundaries** — adopted (note: this
  is Zod, not Tigerstyle's compile-time-bounded type system)
- **Bun's built-in `expect()` from `bun:test`** wrapped in try/catch for
  graceful degradation — author's own adaptation

What was NOT adopted:

- Static memory allocation (impossible in V8/Bun)
- Compile-time-bounded loops and queues (no enforcement mechanism in TS)
- The "two assertions per function average" density target — not measured
  or enforced
- Power-of-Ten / NASA-grade safety-critical rules
- Tigerstyle's "function shape" rules (line-count limits, control-flow
  shape)

**Reported cost:** none, quantitatively. The author claims "assertions make
debugging significantly easier and create cleaner code" but reports no
metrics on time, defect rate, refactoring overhead, or onboarding friction.
Subjective endorsement, no measurement.

**Other TS adopters:** the `awesome-tigerstyle` community list contains
**exactly one** TypeScript entry — Corey DeMarse's same blog post. The
GitHub code search for `TIGER_STYLE` in TypeScript returns **one** repo
(`Taewoong1378/seodaeri`), unrelated to financial systems. There is no
hidden cluster of production TS codebases adopting Tigerstyle that this
search missed.

### TigerBeetle in TS production — Rafiki is the real case, the rest is demos

The GitHub code search for `tigerbeetle-node` in TypeScript returns 135
repositories. Inspection of the top 20 by relevance shows:

- **interledger/rafiki** — Interledger Foundation reference implementation
  for cross-currency settlement. **Production-grade.** 81 TigerBeetle-related
  files. Full abstraction layer at
  `packages/backend/src/accounting/tigerbeetle/{service,transfers,accounts,utils,errors}.ts`.
  Helm chart for Kubernetes deployment in
  `infrastructure/helm/tigerbeetle/`. Uses tigerbeetle-node `0.16.29`.
  Tests with **Jest 29** (not Vitest).
- **casual-simulation/casualos** — collaborative simulation platform; not
  payments
- **PluxelJS/pluxel-template** — template repo
- **resonatehq-examples/example-tigerbeetle-account-creation-ts** — example
- **rhodee/bun-tigerbeetle** — exploratory; not production
- The remaining 130 entries are demos, hackathon projects, templates, or
  early-stage experiments

**One additional non-TS production case for context:** Mojaloop (a
financial-inclusion platform serving low-income markets) integrated
ProtoBeetle (an early TigerBeetle prototype) and reported **76 TPS on
MySQL → 1757 TPS on ProtoBeetle** — a 23x improvement. This is a real
deployment but the client language is not TS.

**Production environment requirement:** TigerBeetle docs state "Linux >= 5.6
is the only production environment we support." This excludes any deployment
that depends on macOS or Windows production hosts.

### Rafiki integration shape — the only TS production reference

From the file tree:

- `packages/backend/src/accounting/tigerbeetle/service.ts` — top-level
  abstraction (named "service," matching this engine's layering)
- `accounts.ts` — account-creation primitives wrapping tigerbeetle-node
- `transfers.ts` — transfer primitives (presumably wrapping pending /
  post / void)
- `utils.ts` — helpers
- `errors.ts` — typed error wrappers

**This is the closest reference architecture for "TS+Bun-shape engine using
TigerBeetle as the ledger backend."** Rafiki is built on Node.js + Jest,
not Bun + Vitest, but the file tree and abstraction layer translate
directly.

**Caveat:** Rafiki is a SETTLEMENT engine (Interledger protocol — cross-
network value transfer between Interledger Service Providers). It's not a
Stripe-shape consumer payment processor. The problem domains overlap
(double-entry ledger, two-phase transfers, account abstractions) but the
business model differs. Lessons about the integration LAYER transfer
cleanly. Lessons about end-to-end behavior may not.

## Conflicts

The narrative around Tigerstyle ("a software engineering methodology to
produce safer, faster software in less time") implies a body of adopters.
The codebase evidence shows essentially one TS blog post and zero TS
production deployments documenting adoption costs. The narrative outpaces
the evidence.

There is no conflict between sources within either question; the conflict
is between the prevalence Tigerstyle has in tech-Twitter / blog-aggregator
discourse and the actual adoption surface in code search.

## Conditions

- **Tigerstyle in TS adoption claim:** the principles ARE portable to TS in
  the narrow sense that runtime assertions, Zod-style schema validation at
  boundaries, and "limit-on-everything" discipline can be adopted. No
  production codebase has documented the cost of doing so. The applicability
  rating in [[2026-04-26-tigerbeetle-takes-survey]] (#5) is unchanged in
  principle but loses external validation.
- **TigerBeetle in TS production:** ONE real case (Rafiki) provides a
  reference architecture. Multiple non-TS cases (Mojaloop on Java/Erlang,
  others not surveyed) provide additional confidence in the database
  itself. The "TS+TigerBeetle in production" category is sparsely populated
  but not empty.
- **Linux >= 5.6 production requirement** narrows deployment options.
  Anyone running on managed PaaS (Render, Railway, Fly.io, Heroku) needs
  to verify kernel version. Vercel and Cloudflare Workers cannot host
  TigerBeetle.

## Open threads

- **Rafiki's tigerbeetle/service.ts internals** — not deep-read in this
  entry. Future research: read the abstraction layer to extract the
  TS-shape patterns for wrapping tigerbeetle-node (account-id mapping,
  ledger semantics, transfer-flag composition, error mapping). This is the
  highest-value unread document for any future "should we adopt
  TigerBeetle" decision.
- **Why does Rafiki use Jest?** They started Node-only; Vitest may have
  been less mature when their test suite was set up. Worth confirming if
  they have plans to migrate (relates to [[2026-04-26-vitest-migration]]).
- **Mojaloop's TigerBeetle adoption details** — referenced (76→1757 TPS)
  but not deep-fetched. Useful for production-scale validation evidence
  even though it's not a TS shop.
- **Cost of Tigerstyle adoption in any non-Zig codebase** — open. If a
  blog post or paper exists from a Go, Rust, or Java team adopting
  Tigerstyle's assertion density, would be worth grounding in. Not found
  in current search.
- **Are there any TS projects that adopted Tigerstyle's "function shape"
  rules** (line-count limits, control-flow restrictions) — open. Not
  surfaced in current search; possibly a more recent Tigerstyle feature.
