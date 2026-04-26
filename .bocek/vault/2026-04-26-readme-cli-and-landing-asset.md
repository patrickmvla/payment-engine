---
type: decision
features: [demo, hiring]
related: ["[[2026-04-26-surface-architecture-landing-page]]", "[[2026-04-26-loom-walkthrough-content]]", "[[2026-04-26-deployment-platform-railway]]"]
created: 2026-04-26
confidence: high
---

# Skip CLI harness; produce landing page hero via asciinema-curl; rewrite README as case study

## Decision

Two coupled choices recorded together:

**1. CLI harness — SKIPPED.** The CLI harness specced in
`docs/15-demo-and-presentation.md` is not built. `docs/15` is marked
superseded by [[2026-04-26-loom-walkthrough-content]] and this entry.

**2. Landing page hero asset — produced via asciinema-curl.** Record an
asciinema cast of curl-against-the-live-Railway-API, demonstrating an
authorize → capture → ledger flow. Pretty-print JSON via `jq`. Embed the
asciinema cast in the Astro landing page hero per
[[2026-04-26-surface-architecture-landing-page]].

**3. README — case-study format.** Rewrite the existing 8.3KB README into
case-study shape: opening value prop (already strong), concrete metrics
in the first 30 seconds, embedded architecture diagram (lift the ASCII
from `docs/03-architecture.md` or `docs/16-deployment.md`, render as
SVG), the partial-refund-bug-found-and-fixed mini case study, link to
landing page, link to live API `/docs`, link to Loom. README is the
GitHub-landing technical-deep-dive surface; landing page is the first
impression for non-technical audiences.

## Reasoning

CLI's role narrowed across this design session:

- Originally specced (`docs/15`) as the live-demo-prop centerpiece.
- After [[2026-04-26-loom-walkthrough-content]] adopted B+C (bug story
  + architecture), the CLI lost its Loom-asset role — the bug story
  uses test execution as its substrate, not the CLI.
- The remaining CLI consumer was the landing-page hero asset. That
  was the load-bearing question.

Two viable asset-production paths considered:
- **B (build CLI; capture as asciinema):** highest polish, designed
  visual.
- **C (skip CLI; record curl-against-live-API as asciinema):** middle
  ground; uses the already-deployed Railway API per
  [[2026-04-26-deployment-platform-railway]]; saves 200–400 LOC of CLI
  harness work that would also need to be maintained.

Owner picked C. Defense:
1. Middle-ground polish: real engine output via curl + jq is
   authentic-looking even without bespoke visual design.
2. LOC savings: 200–400 LOC of CLI harness code (plus ledger-formatter,
   table-printer, color-coding utilities) avoided. Less surface to
   maintain. Less code to debug if a refactor (multi-capture, etc.)
   changes the API shape.
3. The implementation tail across the vault is already long; cutting
   the CLI shortens time-to-shipped-portfolio.

README is settled by universal 2026 evidence (case-study format with
metrics, architecture diagram, bug story, cross-links). No real fork
on that piece; bundled here for completeness.

## Strongest rejected alternative

**B — build CLI harness, use designed terminal output as the landing
page hero.**

Counter-argument considered:
- More polished visual (formatted tables, color-coded debits/credits,
  balance-passes checkmarks).
- The work was already specced in `docs/15`; not net-new design work.
- Distinctive look — most portfolios don't have a designed CLI
  harness.

Why it lost:
- 200–400 LOC of code that exists to produce ONE asset (the landing
  hero). Cost-to-value ratio is poor.
- Future engine refactors (multi-capture per
  [[2026-04-26-multi-capture-model]]) would force CLI harness
  updates. Maintenance overhead.
- The Astro landing page can compensate for asciinema-curl's lower
  designed-polish via surrounding visual treatment (CSS framing,
  hover states, captions). Polish moves from terminal-output design to
  page-layout design.
- "Most portfolios don't have a CLI harness" cuts both ways: most
  portfolios also don't have a 442-test payment engine with
  decision-vault evidence. The differentiation comes from the depth
  of the work, not from a polished CLI surface.

**A — skip CLI, use Loom embed as landing page hero.**

Why it lost:
- Loom hero is click-to-play; landing pages want
  silent/immediate/looping hero content. Wrong content shape for the
  hero slot.
- Loom is already pinned for the deep-dive section, not the hero.

## Failure mode

1. **Asciinema-curl visual quality below threshold.** Risk: raw JSON
   even pretty-printed by jq looks bare next to a designed CLI's
   formatted tables. Mitigation:
   - Pick endpoints that show interesting structure:
     `GET /api/v1/payments/:id/ledger` returns the full ledger entries
     with debits / credits / amounts — visually rich JSON
   - Use `curl ... | jq` consistently for color-highlighted output
   - Frame the cast in the Astro hero with a caption like "Real
     authorize → capture → settle, hitting the live engine"
   - If dry-run reveals the cast looks unimpressive, re-decide as B
     (build CLI) — failure mode triggers a revisit, not a permanent
     accept-of-bad-asset

2. **Engine API drift breaks the cast.** Risk: future refactor changes
   API response shape; the recorded cast no longer matches the live
   engine. Mitigation: re-record on each significant API change, OR
   embed the cast date in the page so viewers know it's a snapshot.

3. **Live API URL exposure.** Recording a real curl session leaks the
   Railway API URL. Not a security issue (public-by-design portfolio
   API) but worth confirming before recording. Mitigation: ensure the
   live API has rate limiting (`src/shared/middleware/rate-limit.ts`
   exists) and no production secrets exposed via response bodies.

4. **README diverges from landing page** (carried from
   [[2026-04-26-surface-architecture-landing-page]]). Same mitigation:
   landing page summarizes; README is the source of technical truth.

## Revisit when

- Asciinema-curl cast dry-run reveals visual quality is below the
  landing-page bar. Revisit to B (build CLI).
- A specific synchronous-interview demo scenario emerges that needs a
  polished CLI live-demo prop. Revisit C → B then.
- README and landing page drift in content and need re-syncing. Not
  a decision revisit; a maintenance task.

## Implementation tasks

1. **Update `docs/15-demo-and-presentation.md`** — mark superseded by
   this entry and [[2026-04-26-loom-walkthrough-content]]. Note that
   the CLI-harness plan is not adopted.
2. **Deploy live API to Railway** (already an implementation task from
   [[2026-04-26-deployment-platform-railway]]). Required upstream of
   this entry.
3. **Write a short shell script** that runs the asciinema-rec session:
   - `curl -X POST .../authorize ... | jq`
   - `curl -X POST .../capture ... | jq`
   - `curl .../ledger | jq`
   - End with the god-check curl or a balance query
4. **Record the cast** — `asciinema rec` for ~30–60 seconds.
5. **Upload to asciinema.org** (free hosting) or self-host.
6. **Embed in Astro landing page hero** via `<asciinema-player>` web
   component or `<iframe>` from asciinema.org.
7. **README rewrite** — case-study format:
   - Keep the existing strong opening ("production-grade payment
     processing engine," Stripe/Adyen/Square comparison)
   - Add a metrics block in the first ~10 lines: 442 tests passing,
     p50 22ms, ~3000 expect calls, god-check after every integration
     test
   - Embed architecture diagram (SVG or `<pre>` ASCII)
   - Add a "Bug found and fixed" subsection on the partial-refund
     double-refund case study
   - Add cross-links: landing page URL, live API URL, Loom URL
   - Move install / commands / contribution sections lower; lead with
     the case study
