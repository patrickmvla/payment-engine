---
type: research
features: [ledger]
related: ["[[2026-04-26-tigerbeetle-takes-survey]]", "[[2026-04-26-tigerstyle-and-tigerbeetle-in-ts-adoption]]"]
created: 2026-04-26
confidence: high
---

# Who runs TigerBeetle in production, regardless of client language?

## Question

The prior TS-scoped entry surfaced one production case (Rafiki) and noted
Mojaloop as referenced. The broader question — is TigerBeetle a
battle-tested production database, or a thin set of demos with a marketing
funnel — needs the language filter dropped. This entry catalogs every
named production adopter found in primary sources.

## Sources examined

- [tigerbeetle.com](https://tigerbeetle.com/) — homepage customer testimonials (fetched 2026-04-26)
- [techcrunch.com/2024/07/23/tigerbeetle-is-building-database-software-optimized-for-financial-transactions](https://techcrunch.com/2024/07/23/tigerbeetle-is-building-database-software-optimized-for-financial-transactions/) — TechCrunch on Series-A (2024)
- [interledger.org/developers/blog/rafiki-tigerbeetle-integration](https://interledger.org/developers/blog/rafiki-tigerbeetle-integration/) — Rafiki + TigerBeetle integration post
- [ximedes.com/blog/solving-the-hot-key-problem](https://ximedes.com/blog/solving-the-hot-key-problem) — Joran Greef interview (TigerBeetle CEO) on Mojaloop adoption
- [mojaloop.io/faq-items/](https://mojaloop.io/faq-items/) — Mojaloop project FAQ
- [tigerbeetle.com/blog/2023-01-30-series-seed-announcement](https://tigerbeetle.com/blog/2023-01-30-series-seed-announcement/) — seed announcement (2023)
- [biggo.com/news/202510011913_TigerBeetle_Database_Community_Scrutiny](https://biggo.com/news/202510011913_TigerBeetle_Database_Community_Scrutiny) — counter-signal article (Oct 2025), not deep-fetched in this entry
- [softwaremill.com/whats-interesting-about-tigerbeetle](https://softwaremill.com/whats-interesting-about-tigerbeetle/) — technical deep-dive (Jan 2026); confirms NO specific production deployments mentioned (architectural focus)

## Findings

### Named production adopters

**Three publicly-named on tigerbeetle.com homepage (current as of fetch):**

1. **Super Payments** — UK fintech. CTO Aidan McGinley quoted: "If you are
   doing anything that requires a ledger or anything in the fintech space,
   take a look at TigerBeetle." Listed in Enterprise Solutions section.
2. **Pesawise** — payments platform. CEO/Co-Founder Jamal Khan: "TigerBeetle
   is now our source of truth, and the banks and whatever else we're matching
   against are secondary." Strong production signal — TigerBeetle is the
   authoritative system.
3. **Triple-A** — crypto-payments processor. CTO Vincent Serpoul: "The
   structural constraints of TigerBeetle mean we know exactly what everything
   should be doing. It's not possible to drop a constraint."

**Adopters surfaced in search but not on homepage:**

4. **Mojaloop** — open-source payments switch backed by the Gates Foundation.
   Piloting across 20+ countries including Rwanda at the national level.
   Reported deployment metric: **78 TPS on general-purpose database → 2,000
   TPS on TigerBeetle** for the accounting layer. Mojaloop's architecture
   has 600+ microservices; the general DB was the performance killer per
   Joran Greef's account in the Ximedes interview.
5. **Coil** — Interledger pioneer (Stefan Thomas, ex-Ripple). Reported as
   "began designing for TigerBeetle." Status caveat: Coil shut down its
   consumer streaming-payments product in 2023; the company may be defunct
   or pivoted. Treat this adopter as historical, not necessarily current.
6. **Fynbos** — digital wallet. Listed as "early adopter" in the Interledger
   Foundation context.
7. **Interledger Foundation / Rafiki** — reference Interledger Service
   Provider implementation. Rafiki "offers the option to use TigerBeetle as
   its accounting backend." Detailed in
   [[2026-04-26-tigerstyle-and-tigerbeetle-in-ts-adoption]].

### Aggregate scale claims (from CEO interviews)

Joran Greef (TigerBeetle CEO) has stated in interviews and homepage copy:

- **"Production customers have hit 100M transactions per month."**
  Verified production scale. Doesn't disclose which customers reached
  this; floor for at-scale usage.
- **"$100+ billion companies using TigerBeetle at the enterprise level."**
  Unnamed. Could be Mojaloop's national-scale deployments; could be other
  unannounced enterprise customers. CEO claim, not independently verified.
- **"Paying customers since day one."**
- **"Community growth 200% year-over-year."**

These are CEO-asserted figures from the homepage and interviews. They're
not third-party-audited but are consistent with the Mojaloop deployment
scale.

### Verticals where TigerBeetle is deployed

Per multiple Joran Greef interviews and the homepage:

- **Core banking** — fintech ledgers (Super Payments, Pesawise)
- **Crypto payments** — Triple-A
- **Cross-border / cross-currency settlement** — Interledger / Rafiki
- **Financial inclusion / mobile money** — Mojaloop / Gates Foundation
- **Energy (metering / billing)** — referenced as a deployment vertical
- **High-volume trading** — referenced
- **Smaller use cases** — gaming scores, property rents (claimed but not
  named)

### Independent validation signals

- **Jepsen analysis 0.16.11** (Kyle Kingsbury, June 2025): TigerBeetle's
  consensus and storage-fault tolerance survived Jepsen's safety probing.
  Kingsbury "was unable to break TigerBeetle's foundations." This is a
  high-bar third-party validation — Jepsen is the standard for distributed
  systems correctness analysis.
- **Funding signal:** Series Seed $6.4M (2023, Amplify Partners led),
  Series A covered by TechCrunch (July 2024). Not validation of production
  use, but signal that investors believe production traction is real.

### Counter-signal

A BigGo News article (October 2025) titled "TigerBeetle Database Faces
Community Scrutiny Over Performance Claims and Missing Features" exists
in search results but was not deep-fetched. Worth examining if the
adoption decision is on the table. Open thread.

## Conflicts

The homepage is marketing-curated — three named customers with quotes is
a small sample. The CEO's "$100B+ enterprise" claim is unverified.
Independent third-party adoption-tracking (e.g., a community-maintained
list of production deployments) does not appear to exist.

The Mojaloop case is the strongest non-vendor-curated signal: Gates
Foundation deployment with a measurable performance delta, multi-country
pilot. Mojaloop is open-source, so the integration is verifiable in their
codebase rather than relying on vendor claims.

The October 2025 BigGo article is a counter-signal of unknown weight; not
deep-fetched.

## Conditions

- **"Production" definition matters.** The homepage uses "production
  customers." The CEO claims "100M tx/month." Both are credible at the
  hundreds-of-thousands-of-transactions-per-day floor. Sub-million-tx
  deployments (most v1 SMB engines) are well below this floor and are
  unlikely to hit TigerBeetle's scale envelope.
- **Mojaloop is a financial-inclusion / mobile-money switch**, not a
  Stripe-shape consumer payment processor. The TPS improvement
  (78→2000) reflects high-volume small-value mobile transactions, not
  card-present consumer payments. Different problem domain.
- **Three of seven named adopters are crypto / Interledger-adjacent**
  (Triple-A, Coil, Fynbos, Interledger Foundation). The TigerBeetle
  community has gravity in crypto and cross-currency-settlement
  verticals more than in pure consumer-card payments. This may reflect
  early-adopter selection, not a permanent positioning.
- **Production environment constraint:** TigerBeetle docs require Linux
  >= 5.6. Excludes Vercel, Cloudflare Workers, and managed PaaS that
  don't expose kernel version.

## Open threads

- **The BigGo October 2025 community-scrutiny article** — what specifically
  is the criticism? Performance claims, missing features, both? Worth
  fetching before any adoption decision.
- **Coil's status** — alive, pivoted, or defunct. If defunct, that adopter
  reference is historical.
- **Are there any known production deployments OUTSIDE crypto/Interledger
  and Mojaloop?** The crypto-and-settlement gravity may be incidental, but
  it's also possible the database's positioning attracts that segment
  specifically. A Stripe-shape consumer-payment processor running
  TigerBeetle has not been surfaced in this research.
- **What's the scale floor where TigerBeetle's advantages start mattering?**
  At 1M tx/month an engine fits in a single Postgres instance comfortably.
  At 100M tx/month it doesn't. The crossover point isn't surfaced in
  current public docs.
