---
type: decision
features: [deployment, build]
related: ["[[2026-04-26-hiring-manager-portfolio-evidence]]"]
created: 2026-04-26
confidence: high
---

# Compute platform: Railway Hobby ($5/mo), supersedes Fly.io plan in docs/16

## Decision

Deploy the Bun + Hono engine to **Railway Hobby plan** ($5/month, EU region
matched to Supabase EU-West-1). Supabase remains the database backend
unchanged. Same Dockerfile artifact; different runtime host.

This **supersedes** the Fly.io choice in `docs/16-deployment.md`. The
Dockerfile, environment-variable setup, and connection strategy from
`docs/13` and `docs/16` carry over without code change.

## Reasoning

1. **Existing paid plan.** Owner is already on Railway Hobby ($5/mo).
   Sunk-cost-as-current-cost beats Fly.io's ~$3.50/mo on a NET-NEW spend.
   No marginal cost.
2. **Region match resolved.** Railway EU region co-locates with Supabase
   EU-West-1 (`.env` DATABASE_URL points at `aws-0-eu-west-1.pooler.supabase.com`).
   Per-query RTT comparable to Fly.io's region-co-located deployment.
3. **Persistent container model fits the engine.** Railway runs persistent
   Docker containers, not serverless functions. Pessimistic locking via
   `SELECT ... FOR UPDATE` (`src/payments/service.ts:48`), multi-statement
   transactions, and direct (non-pooled) Postgres connections all work
   identically to the Fly.io plan.
4. **Bun runtime first-class.** Railway auto-detects Bun apps via
   `package.json` and runs `bun run start`. No adapter, no edge-runtime
   workaround.
5. **Always-on.** Hobby plan does not sleep. Cold-start concern that
   eliminated Render in `docs/16` does not apply.
6. **Custom domain + TLS included.** Same as Fly.io.
7. **Docker artifact unchanged.** The Dockerfile from the Fly.io plan
   builds and runs on Railway without modification.

## Strongest rejected alternative

**Stay with Fly.io as planned in `docs/16`.**

Counter-argument considered:

- `docs/16` chose Fly.io for explicit reasons: always-on, Docker-native,
  region co-location, ~$3.50/mo, `fly secrets` for credential management.
  Most of those properties Railway also has.
- Fly.io has marginally tighter region selection (specific cities like
  Frankfurt vs Railway's broader EU region grouping). For demo traffic
  this is not load-bearing.
- Railway's "burns credit" comment in `docs/16` — at the engine's actual
  demo traffic profile (recruiter-click traffic, ~10-50 req/day), $5
  credit is far more than the engine consumes. The concern matters under
  sustained production load, not under portfolio-demo load.

Why it lost:

- Owner has an existing paid Railway plan. Switching to Fly.io creates a
  second paid relationship with no benefit.
- The Fly.io advantages over Railway (slightly better region precision,
  arguably better CLI ergonomics) are not load-bearing for a portfolio
  demo at the planned traffic level.

## Other rejected alternatives (carried over from prior research)

- **Vercel free** — wrong runtime model for this engine (serverless
  functions break pessimistic locking + connection pool exhaustion). Per
  `docs/13` and `docs/16`. Confirmed in
  [[2026-04-26-hiring-manager-portfolio-evidence]] research.
- **Render free** — cold start after 15min idle. Demo UX failure.
- **Oracle Cloud Free Tier** — genuinely free, always-on, EU region
  available; rejected because owner is already paying Railway and the
  ops-setup burden (TLS via Caddy, OS updates, secret management) is
  higher.
- **Hetzner / DigitalOcean / Vultr VPS** — cheaper or comparable, but you
  become the platform (TLS, OS, secrets). Owner is paying Railway already;
  paying twice for ops simplicity makes no sense.

## Failure mode

1. **$5 credit exhaustion.** Under sustained load — say a viral GitHub
   star spike sending hundreds of requests/sec — Railway Hobby could burn
   the $5 credit before month-end. For portfolio-demo traffic this is
   far below threshold. Mitigation: monitor Railway usage dashboard;
   alert at 80% credit consumption.
2. **Region drift.** If Railway changes EU region offerings or Supabase
   migrates regions, latency penalty re-emerges. Mitigation: pin both
   regions explicitly in deployment config.
3. **Bun version drift.** Railway auto-detects Bun via `package.json`;
   minor version drift could affect behavior. Mitigation: pin Bun version
   via `engines` field in `package.json` (already standard practice).
4. **Build cache invalidation.** Railway build times typically faster
   than Fly.io for the same Docker context, but cache misses are
   possible. Not a correctness concern.

## Revisit when

- Demo traffic exceeds Railway Hobby budget (would need to upgrade to Pro
  plan ~$20/mo or migrate)
- Railway changes pricing or region offerings unfavorably
- Engine moves from portfolio-demo to actual fintech production handling
  real money — at that point compliance / SLA / multi-region requirements
  may force a different platform anyway

## Implementation tasks

1. **`docs/16-deployment.md`** — update to reflect Railway as the chosen
   platform. Replace the Fly.io-specific sections (architecture diagram,
   `fly deploy` commands, `fly secrets set` credential management) with
   Railway equivalents. Note in the doc that this decision was made on
   2026-04-26 and supersedes the prior Fly.io choice.
2. **Deploy** — connect the GitHub repo to Railway (or use Railway CLI
   `railway up`). Auto-detect should pick up Bun.
3. **Environment variables** — set `DATABASE_URL` in Railway env to the
   Supabase prod URL (port 5432 direct, per `docs/13-database-connection-strategy.md`),
   plus `DATABASE_SSL=true`, `APP_ENV=production`, etc.
4. **Region pinning** — explicitly select Railway's EU region at deploy
   time to match Supabase EU-West-1.
5. **Custom domain** — optional; `*.up.railway.app` works for portfolio
   purposes. Custom domain adds polish but is not load-bearing.
6. **Health check** — `GET /health` already exists at `src/server.ts:23`;
   configure Railway's health-check endpoint to hit it.
7. **Verify deploy** — hit `/health`, `/docs`, and a sample
   `POST /api/v1/payments/authorize` from curl. Confirm Supabase
   connection works in production.
8. **Remove or archive any Fly.io-specific config** if present in the
   repo (e.g., `fly.toml` if it was added to docs as a sample). Inspection
   has not found one yet, but worth confirming.
