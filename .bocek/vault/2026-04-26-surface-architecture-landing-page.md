---
type: decision
features: [demo, hiring]
related: ["[[2026-04-26-hiring-manager-portfolio-evidence]]", "[[2026-04-26-deployment-platform-railway]]"]
created: 2026-04-26
confidence: high
---

# Surface architecture: separate landing page on Astro + Vercel, alongside polished GitHub README

## Decision

The portfolio surface stack has TWO entry points, not one:

1. **Public landing page** — 1-page static site built with **Astro**, hosted
   on **Vercel** (free Hobby tier, static deployment, instant CDN, no cold
   start). First-impression surface for any audience including
   non-technical hiring managers, recruiters, and screeners who won't dig
   into a GitHub repo.
2. **GitHub README** — case-study format, polished for technical readers
   landing on the repo directly. Contains architecture diagram, concrete
   metrics, link to live API, link to Loom, link to landing page.

Both surfaces link to: live API URL (Railway, per
[[2026-04-26-deployment-platform-railway]]), Loom walkthrough (decision
pending), GitHub repo, and to each other.

## Reasoning

The audience for "hiring managers" is plural and varies in technical
depth:

- **Senior backend engineers / CTOs / staff engineers**: GitHub README is
  the right entry. They'll read it.
- **Engineering managers without recent hands-on coding**: a landing page
  with screenshots + Loom + value prop converts better than a wall of
  Markdown.
- **Recruiters / non-technical screeners**: GitHub looks like a code dump.
  A landing page is the only entry that retains them past the click.

A single GitHub-only surface serves only the first group. A landing page
+ polished README serves all three. Path A (GitHub-only) was rejected
specifically because it loses the second and third audiences.

**Astro + Vercel chosen because:**

- Astro produces pure static HTML/CSS/JS by default (zero JS unless
  needed). Fast load, no runtime cost.
- Vercel free Hobby covers a static site indefinitely. No usage cap risk
  for a single landing page.
- Static deploys have no cold start. Recruiter clicks resolve in <500ms.
- The Vercel-runtime concern that ruled out Vercel for the engine itself
  (serverless + pessimistic locking + connection pool exhaustion, per
  [[2026-04-26-deployment-platform-railway]]) does NOT apply here. The
  landing page has no backend; it's static files served from CDN.
- Astro DX is solid: Markdown content collections, component imports,
  good Tailwind / CSS-modules support if visual polish is needed.

GitHub Pages and Cloudflare Pages are equivalent free options for a
static site. Vercel is chosen for DX (preview deploys per PR, simple CLI)
not because the others fail. If the owner has a different preferred
static host, the decision is portable — Astro builds the same artifact
for any of them.

## Strongest rejected alternative

**Path A — GitHub repo as the only surface, README polished into
case-study format.**

Counter-argument considered:

- Existing 8.3KB README is already 80% of case-study format
- Adding a landing page is duplicate content
- For senior backend / fintech audiences specifically, GitHub IS the
  read surface
- Lower work; faster to ship
- Single source of truth (no drift between landing page and README)

Why it lost:

- Engine owner explicitly stated audience is "hiring managers" plural,
  not "senior backend at fintech" exclusively. Some hiring managers in
  the pipeline are non-technical or screening-stage. GitHub-only fails
  for them.
- The duplication concern is real but bounded: landing page contains a
  subset of README content packaged for non-technical reading. Drift
  managed by linking — landing page is shorter and points to README for
  depth.
- The "faster to ship" argument doesn't beat "doesn't serve the audience."

## Failure mode

1. **Drift between landing page and README.** Different content in two
   places gets out of sync. Mitigation: keep landing page text minimal
   (value prop + 3 metrics + Loom + buttons); push detail to README.
   Source of truth for technical content is the README; landing page
   summarizes.
2. **Astro version churn.** Astro evolves quickly; major versions break
   builds. Mitigation: pin Astro version in `package.json`; rebuild on
   demand only when content changes.
3. **Vercel free Hobby tier policy changes.** Could become time-limited
   or feature-restricted. Mitigation: Astro builds are portable to GitHub
   Pages / Cloudflare Pages with no rebuild — switch hosts in <30 minutes
   if needed.
4. **Custom domain ambiguity.** If the live API is `api.payments.your-domain.com`
   and the landing page is `payments.your-domain.com`, the user mental
   model is clean. If they're on different sub-domains or different root
   domains, landing-page-to-API navigation is jarring. Mitigation:
   pick a domain strategy at deploy time. `*.vercel.app` and
   `*.up.railway.app` work for portfolio-grade if a custom domain isn't
   in scope yet.

## Revisit when

- The portfolio expands to multiple projects. Then the landing page
  becomes a per-project page within a hub site, and the architecture
  shifts to "hub + per-project pages + per-project READMEs."
- Conversion data (if measurable) shows the landing page isn't pulling
  weight relative to the README. Unlikely measurable for an individual
  portfolio piece, but if visible via Vercel Analytics free tier, worth
  watching.

## Implementation tasks

1. Create a new repo or subfolder (e.g., `landing/` in this repo, or a
   sibling repo `payment-engine-landing`) for the Astro project.
2. `bun create astro@latest landing` (or pnpm/npm equivalent) — Astro
   auto-detects static SSG mode for a content-only site.
3. Build the page content:
   - Hero: engine name, 1-line value prop ("A production-grade payment
     engine with double-entry ledger, multi-capture authorization, and
     full reconciliation"), embedded Loom (decision pending), primary
     CTA button to the live API `/docs`.
   - Three metrics blocks: 442 tests passing, p50 22ms single-authorize
     latency, ~3000 expect calls / god-check verifies after every
     integration test (or final numbers from the latest run).
   - Architecture diagram (the ASCII from `docs/16` rendered as an SVG
     or kept as `<pre>` for honesty).
   - Bug-find story: the partial-refund double-refund found and fixed
     this session (treat as a "case study" mini-section).
   - Footer: link to GitHub repo, link to Loom, link to live API.
4. Deploy to Vercel: `vercel --prod` or GitHub-integration auto-deploy.
5. Verify the deploy at the assigned `*.vercel.app` URL. Custom domain
   optional.
6. Cross-link: README links to landing page; landing page links to
   README via "Read the deep dive on GitHub →" button.
