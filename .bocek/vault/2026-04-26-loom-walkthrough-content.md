---
type: decision
features: [demo, hiring]
related: ["[[2026-04-26-surface-architecture-landing-page]]", "[[2026-04-26-hiring-manager-portfolio-evidence]]"]
created: 2026-04-26
confidence: high
---

# Loom walkthrough: B+C — bug-find-and-fix story (60s) + architecture walkthrough (60s)

## Decision

Record a ~2-minute Loom walkthrough with two halves:

**Half 1 (~60s) — Bug-find-and-fix story.** Walk through the partial-refund
double-refund bug caught and fixed during the design/debugging session.
Show the 4 RED test failures, name the failure mode in plain language
("retrying a partial refund could double-charge — money out twice with no
error to the client"), show the one-line cause in `paymentService.refund`,
show the fix, show the 4 tests turn GREEN, end with "and 442 total tests
still pass."

**Half 2 (~60s) — Architecture walkthrough.** Whiteboard or diagram view
of the engine's core mental model: double-entry ledger, two-phase capture
(authorize → capture/void), idempotency claim mechanism, witness
reconciliation. Verbal narration linking each piece to where it lives in
the codebase.

Linked from both surfaces (landing page and README) per
[[2026-04-26-surface-architecture-landing-page]].

## Reasoning

The audience is plural. The two-half structure serves both:

- **Senior engineers / staff / CTO-track hiring managers** read the
  architecture half (C) for depth signal. They evaluate "does this
  candidate think in systems" via the abstraction quality.
- **Non-technical hiring managers** can't evaluate the technical
  substance but CAN evaluate "this video looks technical" as a proxy
  for technical depth. Both halves carry that proxy: the bug story
  shows terminal output and code; the architecture shows diagrams and
  systems.
- **All hiring managers** absorb the bug story (B) at the narrative
  level — "found a serious money-loss bug, caught it before shipping,
  fixed it, tests confirm it." That arc is universally legible whether
  the viewer follows the technical details or not.

The 2026 hiring-manager evidence specifically calls out "explain one
interesting failure encountered and how it was fixed" as the move that
"puts you ahead of 90% of applicants." The bug story half implements
that exactly. The architecture half adds the depth signal that B alone
omits, capturing the senior/staff audience that B+C-rejected
alternatives (B-alone) would miss.

## Strongest rejected alternative

**A+B (engine-running demo + bug story, 45s/75s).**

Counter-argument considered:
- A (live terminal demo per `docs/15`'s plan) shows the engine working
  in normal operation. Sets the baseline so the bug story has context.
- 75s for the bug story is more honest pacing than 60s.
- Avoids the architecture-walkthrough recording challenge (whiteboard
  drawing is harder to record well than a terminal session).

Why it lost:
- A is implicit within B: when the bug-finding test runs, the engine
  runs. The viewer sees authorize / capture / refund operations through
  the test execution. Explicit baseline is duplicate signal.
- The architecture half (C) carries depth signal that 75s of bug story
  doesn't. Senior eng / staff audiences specifically want abstraction
  quality, which C delivers and A doesn't.
- The recording-difficulty concern for C is real but bounded:
  pre-render the architecture as an SVG / image, narrate over it.
  Doesn't need live whiteboarding.

**B-alone (120s on bug story).**

Why it lost: senior audience expects depth signal that 120s of bug
narrative doesn't provide. Owner explicitly cited senior engineers on
hiring teams as a target audience.

**C-alone (architecture-only).**

Why it lost: misses the "interesting failure" pattern that 2026 evidence
calls out as the highest-leverage signal. Architecture-only feels
academic without grounded execution evidence.

## Failure mode

1. **Pacing too tight.** 60s for a bug story is hard to tell well; 60s
   for architecture is hard to walk through meaningfully. Risk: both
   halves feel rushed; viewer absorbs neither.
   Mitigation: dry-run record. If both halves feel thin, pick one of
   two outs:
   - Extend to 90s/90s (3 min total). Violates the "~2 min" 2026
     guidance but the content earns it for senior audiences. Most 2026
     sources cite 2 min as a target, not a hard cap.
   - Trim B to 45s by skipping the diagnostic walk: just show "RED →
     fix in service.ts → GREEN" with terse narration. Spend remaining
     75s on architecture.

2. **Architecture half feels academic.** Risk: C without grounding
   examples becomes "here's a diagram, here are some words" which is
   the worst kind of portfolio video. Mitigation: narrate over a
   pre-rendered SVG with concrete code-line callouts. "Here's the
   double-entry primitive — that's `postTransaction()` at
   `src/ledger/service.ts:8`, which validates `SUM(debits) ===
   SUM(credits)` before insert."

3. **Bug story narration falls flat.** Risk: "I found a bug, fixed it"
   is forgettable. The narration has to land the stakes — money out
   twice, no error to the client, financial-grade severity.
   Mitigation: write the narration script before recording. Land the
   "money out twice" line in the first 10 seconds.

4. **Loom (or chosen tool) free tier limits.** Loom free has a 5-min
   cap and 25 video limit on personal plan. 2-3 min walkthrough fits
   comfortably. If multiple takes accumulate to >25 videos, delete old
   ones. asciinema is an alternative for the terminal-only B half;
   architecture half needs voice + visual which is Loom's territory.

## Revisit when

- The video records and the dry-run reveals one half is consistently
  rushing. Then re-decide pacing.
- A specific hiring manager response indicates one half is the
  signal that landed (or didn't). Adjust per signal.
- The portfolio expands to multiple projects; per-project Looms might
  shorten and a hub site might carry the architecture-walkthrough as a
  separate longer-form video.

## Implementation tasks

1. Write a 2-minute script (B+C) before recording. Time it spoken aloud.
2. Pre-render the architecture SVG/image for the C half. Source: the
   ASCII diagram in `docs/16-deployment.md` upgraded to SVG, or
   `docs/03-architecture.md` content. Or hand-draw and digitize.
3. Set up the bug-story replay environment:
   - Reset to a commit where the partial-refund double-refund bug is
     present (before the fix from this session)
   - Run `bun test tests/integration/payments/idempotency.test.ts -t "refund retries"`
     to capture the RED output
   - Apply the fix; capture GREEN output
   - Capture full-suite GREEN (442 tests passing)
4. Record the Loom: B half (terminal capture + voice) + C half
   (screen capture of architecture diagram + voice).
5. Trim and timestamp. Target 2:00. Acceptable up to 2:30.
6. Upload; embed link in landing page hero and README near top.
7. Verify Loom embed works on the Astro landing page and renders in
   GitHub README preview.
