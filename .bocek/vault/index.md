---
vault_version: 1
---

# Vault Index

## api-contract

- [[2026-04-26-amount-wire-format]] — type: decision — JSON integer for money amounts (Stripe-shape commitment, crypto out of scope)
- [[2026-04-26-amount-validation-status-code]] — type: decision — Non-positive amount → 400 (schema), not 422 (runtime). Aligns with Stripe/Adyen.

## money

- [[2026-04-26-amount-wire-format]] — type: decision — JSON integer for money amounts (Stripe-shape commitment, crypto out of scope)

## payments

- [[2026-04-26-multi-capture-model]] — type: decision — Multi-capture v1; capture accumulates, ledger writes per call, hold release on first capture only
- [[2026-04-26-tigerbeetle-takes-survey]] — type: research

## state-machine

- [[2026-04-26-multi-capture-model]] — type: decision — Multi-capture v1; capture accumulates, ledger writes per call, hold release on first capture only

## ledger

- [[2026-04-26-multi-capture-model]] — type: decision — Multi-capture v1; capture accumulates, ledger writes per call, hold release on first capture only
- [[2026-04-26-tigerbeetle-takes-survey]] — type: research
- [[2026-04-26-tigerstyle-and-tigerbeetle-in-ts-adoption]] — type: research
- [[2026-04-26-tigerbeetle-production-adopters]] — type: research
- [[2026-04-26-tigerstyle-portable-coding-logics]] — type: research

## testing

- [[2026-04-26-test-category-separation]] — type: decision — Perf benchmarks live in a dedicated suite, not the main test runner.
- [[2026-04-26-vitest-migration]] — type: decision — Migrate test runner from bun:test to Vitest.
- [[2026-04-26-tigerbeetle-takes-survey]] — type: research
- [[2026-04-26-tigerstyle-and-tigerbeetle-in-ts-adoption]] — type: research
- [[2026-04-26-tigerstyle-portable-coding-logics]] — type: research

## perf

- [[2026-04-26-test-category-separation]] — type: decision — Perf benchmarks live in a dedicated suite, not the main test runner.

## build

- [[2026-04-26-vitest-migration]] — type: decision — Migrate test runner from bun:test to Vitest.
- [[2026-04-26-deployment-platform-railway]] — type: decision — Railway Hobby ($5/mo, EU region) for compute. Supersedes Fly.io plan in docs/16.

## code-style

- [[2026-04-26-tigerstyle-portable-coding-logics]] — type: research

## demo

- [[2026-04-26-hiring-manager-portfolio-evidence]] — type: research
- [[2026-04-26-surface-architecture-landing-page]] — type: decision — Two-surface stack: Astro+Vercel landing page + polished GitHub README
- [[2026-04-26-loom-walkthrough-content]] — type: decision — Loom B+C: 60s bug-find-and-fix + 60s architecture walkthrough
- [[2026-04-26-readme-cli-and-landing-asset]] — type: decision — Skip CLI; landing hero via asciinema-curl; README as case study

## deployment

- [[2026-04-26-hiring-manager-portfolio-evidence]] — type: research
- [[2026-04-26-deployment-platform-railway]] — type: decision — Railway Hobby ($5/mo, EU region) for compute.

## hiring

- [[2026-04-26-hiring-manager-portfolio-evidence]] — type: research
- [[2026-04-26-surface-architecture-landing-page]] — type: decision — Two-surface stack: Astro+Vercel landing page + polished GitHub README
- [[2026-04-26-loom-walkthrough-content]] — type: decision — Loom B+C: 60s bug-find-and-fix + 60s architecture walkthrough
- [[2026-04-26-readme-cli-and-landing-asset]] — type: decision — Skip CLI; landing hero via asciinema-curl; README as case study
