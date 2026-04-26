---
type: research
features: [demo, deployment, hiring]
related: []
created: 2026-04-26
confidence: high
---

# What does 2026 hiring-manager evidence say about backend-only portfolio
projects, and where does the engine's existing plan match or diverge?

## Question

The engine owner asked how to push the project to production and demonstrate
it to hiring managers. Before researching deployment topology and demo
formats from scratch, audit the existing in-repo plan
(`docs/15-demo-and-presentation.md`, `docs/16-deployment.md`) and compare
against current 2026 hiring-manager evidence to identify gaps.

## Sources examined

- [nucamp.co/blog/top-10-backend-portfolio-projects-for-2026](https://www.nucamp.co/blog/top-10-backend-portfolio-projects-for-2026-that-actually-get-you-hired) — 2026 portfolio guidance
- [magic-self.dev/examples/backend-developer](https://www.magic-self.dev/examples/backend-developer) — backend portfolio template, 2026
- [medium @noahblogwriter2025 — 5-Project Backend Portfolio that gets interviews](https://medium.com/@noahblogwriter2025/the-5-project-backend-portfolio-that-actually-gets-you-interviews-45b7203c9a15)
- [techtimes.com — How to build a tech portfolio for 2026](https://www.techtimes.com/articles/314992/20260311/how-build-tech-portfolio-that-impresses-employers-lands-you-job-2026.htm)
- [docs.railway.com/guides/supabase](https://docs.railway.com/guides/supabase)
- [thesoftwarescout.com — Fly.io vs Railway 2026](https://thesoftwarescout.com/fly-io-vs-railway-2026-which-developer-platform-should-you-deploy-on/)
- [techsy.io — Railway vs Fly.io vs Render](https://techsy.io/en/blog/railway-vs-render-vs-fly-io)
- [dev.to/klement_gunndu — 5 portfolio projects that get hired (2026)](https://dev.to/klement_gunndu/5-ai-portfolio-projects-that-actually-get-you-hired-in-2026-5bpl)
- [scalar/scalar — Scalar API documentation tool](https://github.com/scalar/scalar)
- In-repo: `docs/15-demo-and-presentation.md`, `docs/16-deployment.md`, `README.md`
- In-repo stats: 67 TS files, 442 tests, 9 vault entries, 18 spec docs, clean TDD-shaped commit history

## Findings

### What 2026 hiring-manager evidence consistently says

**Quality over quantity.** 3–5 deployed backend systems. Not many shallow
repos.

**Concrete metrics matter.** p95/p99 latency, MTTR, throughput, cost
savings. "Reduced checkout p95 from 600ms to 180ms" beats a long language
list.

**Architecture decisions visible.** Design docs explaining tradeoffs.
Senior backend roles "hinge on judgment under uncertainty, not raw syntax
speed."

**Production-ready signals.** Reliability, observability, deployment to a
public URL. Always-on if possible (cold starts during a recruiter click
kill the impression).

**README as case study.** "The problem you solved, the architecture you
chose, the hardest bugs you fixed, and what you'd do next with more time."
Reads as a story, not as install instructions.

**Live demo + Loom walkthrough.** A 2-minute Loom showing the project
running, terminal output, one interesting failure and how it was fixed.
Reportedly puts you ahead of 90% of applicants.

**GitHub plus active signals.** Maintained code, real commits over time,
not a single push then abandon.

### What the engine's existing plan already addresses

`docs/15-demo-and-presentation.md` — quoted directly:
> "A CTO has decided whether you're serious before you finish your second
> sentence. This document defines the demo — what to show, in what order,
> and what to say. No slides. No Postman screenshots. A live terminal
> hitting a real database."

Plan structure:
- 4-act 5-minute structure (45s setup / 120s break / 60s prove / 60s explore)
- CLI harness referenced (not yet built per file inspection)
- Failure-handling as the demo, not happy path
- Specific terminal-output shapes designed for the visual

`docs/16-deployment.md` — quoted directly:
> "An API running on localhost:3000 is a homework assignment. An API
> running on https://payments.yourdomain.com with TLS, health checks, and
> zero-downtime deploys is a product."

Plan:
- Fly.io for compute, Supabase for DB
- Direct connection (port 5432) decision documented
- Region co-location for <5ms DB round-trips
- Cost: ~$3.50/month
- Platform comparison table with verdicts (Fly wins for always-on +
  Docker-native; Railway burns credit; Render free tier sleeps; Vercel
  wrong model)

The README starts strong — "production-grade," "not a toy," compares to
Stripe/Adyen/Square — and has technical depth.

The repo has tests, architecture docs, vault decision logs, clean commits,
TDD progression visible in commit history.

### Where the existing plan and 2026 evidence converge

The plan in `docs/15` and `docs/16` aligns with most 2026 hiring-manager
evidence:

- ✓ Live demo with terminal output (the "no Postman screenshots" line is
  exactly the bar 2026 sources describe)
- ✓ Always-on platform (Fly.io chosen specifically to avoid cold starts)
- ✓ Public URL with TLS (Fly auto-TLS or custom domain via Let's Encrypt)
- ✓ Architecture decisions visible (18 spec docs + 9 vault entries)
- ✓ Active GitHub signal (TDD commit progression)

### Where the existing plan does NOT cover what 2026 evidence prioritizes

1. **Loom walkthrough.** Not mentioned in `docs/15-demo-and-presentation.md`.
   The doc plans a synchronous 5-minute demo; 2026 evidence says a
   pre-recorded 2-minute Loom is what gets reviewed BEFORE a synchronous
   call. Both formats serve different stages: Loom for screening, live
   for the call.

2. **Concrete metrics surfaced in README.** The README mentions "stack" and
   "what this is" but doesn't lead with measured performance. This session
   produced concrete numbers (442 tests passing; perf measurements:
   single-authorize p50 22ms, 10-concurrent p50 218ms with measured
   distribution; ~3000 expect() calls; god-check passes after every
   integration test). 2026 evidence consistently says "lead with metrics."

3. **README as case study.** The README opens strong but is structured as
   "what" + "stack" + "commands." 2026 case-study format adds: "the
   hardest bug I fixed" (the partial-refund double-refund bug we
   diagnosed and fixed this session is gold for this), "the architecture
   tradeoffs I made" (the just-recorded vault decisions), "what I'd do
   next with more time" (the implementation tail in `state.md`).

4. **CLI harness referenced but not built.** `docs/15` says "the CLI
   harness handles everything" but no `bin/demo` or similar exists in the
   repo (per file inspection). The demo plan depends on a deliverable that
   isn't deliverable yet.

5. **Public deployment status.** `docs/16` describes the deployment plan;
   the actual deploy hasn't happened (no `fly.toml` referenced in
   inspection). Plan exists; execution doesn't.

6. **Architecture diagram in README.** `docs/16` has an architecture
   diagram (ASCII) showing the deploy topology. The README doesn't include
   one. 2026 evidence says hiring managers spending <30 seconds on a repo
   often only read the README; architecture clarity has to be visible
   there.

## Conflicts

The 2026 evidence is consistent across sources on the high-level shape
(live demo + Loom + case-study README + concrete metrics + always-on
deploy). Sources differ on emphasis (Medium piece prioritizes "treat as a
SaaS" with a landing page; nucamp piece emphasizes 3-5 deployed projects;
techtimes emphasizes Loom). No fundamental conflict; weighting differences
based on the writer's framing.

The existing engine plan (`docs/15`, `docs/16`) and the 2026 evidence
agree on substance. The plan was written without explicit reference to
hiring-manager evidence but converges with it independently — credible
that the plan is grounded.

## Conditions

- **All findings condition on "senior backend at a fintech-aware company"
  as the target.** Mid-level generalist, junior, or non-backend roles
  shift the weights. The depth of work in this engine is calibrated for
  senior backend / fintech audiences specifically. For other targets, the
  same engine works but the framing in README and Loom changes.
- **The "ahead of 90% of applicants with a Loom" claim** is from a 2026
  source quoting an aggregated observation; not independently audited.
  Treat as directional guidance, not a measured outcome.
- **Loom is one product; the principle is "pre-recorded video walkthrough
  ~2 minutes."** Any equivalent (asciinema for terminal-only, screen
  recording with voice-over) serves the same purpose. The Loom-specific
  branding in 2026 sources reflects market presence, not technical
  necessity.
- **Plan documents being aspirational vs executed is the load-bearing
  question.** This entry's "gap" findings assume the plan documents are
  aspirational and the deployment / harness / Loom haven't happened yet.
  If they have happened and just weren't surfaced in the file inspection,
  most gaps disappear.

## Open threads

- **Is the CLI harness referenced in `docs/15` actually built?** File
  inspection didn't find one (`bin/`, `scripts/demo*` etc. not surfaced).
  Owner-confirm needed.
- **Is there a `fly.toml` in the repo?** Not surfaced in inspection. If
  not, deployment is plan-only.
- **What's the engine owner's role-target specifically?** "Hiring managers"
  was the audience answer. Role-level (senior, staff, founding eng;
  fintech-specific or generalist) changes which gaps matter most.
- **Is there a custom domain or just `*.fly.dev`?** Plan mentions custom
  domain via Let's Encrypt; not specified which.
- **Does the engine owner have a personal portfolio site to embed the
  Loom + live URL into?** 2026 sources increasingly suggest a single hub
  site with multiple project entries; engine alone is a strong piece but
  hub aggregates.
