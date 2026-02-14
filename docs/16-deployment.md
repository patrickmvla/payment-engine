# Deployment — Putting It on a Real URL

An API running on `localhost:3000` is a homework assignment. An API running on
`https://payments.yourdomain.com` with TLS, health checks, and zero-downtime
deploys is a product. This document covers how we get from one to the other.

The payment engine runs on **Fly.io** with **Supabase** as the managed
PostgreSQL backend. One provider hosts compute, the other hosts data. Neither
touches the other's job.

---

## 1. Why Fly.io

We evaluated four hosting options. The decision comes down to three
requirements: always-on (no cold starts during a CTO demo), Docker-native (Bun
needs a container), and minimal configuration.

| Platform | Always-On | Docker | Bun Support | Deploy CLI | Cost/mo | Verdict |
|---|---|---|---|---|---|---|
| **Fly.io** | Yes | Native | Via container | `fly deploy` | ~$3-5 | **Winner** |
| Railway | Yes | Native | Auto-detect | `git push` | ~$5+ | Good, but burns credit |
| Render | Free tier sleeps | Yes | Via container | `git push` | $0-7 | Cold starts kill demos |
| Vercel/Cloudflare | Serverless | No | Workers adapter | Framework-specific | $0-20 | Wrong model for stateful API |

**Fly.io wins because:**
- Machines run continuously — no 15-second cold start when the CTO clicks the
  link
- Docker-native — we write a Dockerfile, `fly deploy` builds and ships it
- Region selection — we co-locate compute with our Supabase instance (same AWS
  region), keeping database round-trips under 5ms
- `fly secrets set` — database credentials never touch config files or git
- Health checks built into the platform — Fly monitors `/health` and restarts
  unhealthy machines
- TLS out of the box — `*.fly.dev` gets HTTPS automatically, custom domains
  get Let's Encrypt certificates
- Cost — a single shared-cpu-1x machine with 512MB RAM runs ~$3.50/month

**What Fly.io does NOT handle:**
- Database — Supabase owns this entirely
- File storage — not needed (no uploads in a payment engine)
- Background jobs — v1 doesn't have any (expiry is on-access)

---

## 2. Production Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Internet                              │
│                                                              │
│   CTO's browser ──→ https://pay.yourdomain.com/docs         │
│   Demo harness  ──→ https://pay.yourdomain.com/api/v1/...   │
│   curl / httpie ──→ https://pay.yourdomain.com/health        │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS (TLS terminated by Fly)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     Fly.io Edge                              │
│                                                              │
│   Anycast IP ──→ Fly Proxy ──→ Health Check ──→ Machine      │
│                  (TLS, routing)   (GET /health)   (Bun + Hono)│
└────────────────────────────┬────────────────────────────────┘
                             │ PostgreSQL (SSL, port 5432)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supabase                                   │
│                                                              │
│   Direct connection (not pooled)                             │
│   SELECT ... FOR UPDATE works                                │
│   Prepared statements work                                   │
│   Same region as Fly machine                                 │
└─────────────────────────────────────────────────────────────┘
```

**Key decisions:**
- **Direct connection to Supabase (port 5432), not pooled (port 6543).** The
  payment engine uses pessimistic locking (`SELECT ... FOR UPDATE`) and
  multi-statement transactions. PgBouncer in transaction mode breaks both.
  See [13 — Database Connection Strategy](./13-database-connection-strategy.md).
- **Single machine.** This is a demo/portfolio deployment, not a
  high-availability production cluster. One machine in one region. If you need
  redundancy, Fly scales to multiple machines with zero config changes.
- **TLS terminated at the Fly proxy.** The Bun process listens on HTTP
  internally. Fly handles HTTPS at the edge. No certificate management in
  application code.

---

## 3. The Dockerfile

Multi-stage build. Four stages: base, install dependencies, build, release.
The final image contains only production dependencies and source code.

```dockerfile
# ──────────────────────────────────────────────
# Stage 1: Base image
# ──────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

# ──────────────────────────────────────────────
# Stage 2: Install dependencies
# ──────────────────────────────────────────────
FROM base AS deps

# Copy only package files first — Docker caches this layer
# so dependency installation is skipped when only source changes
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ──────────────────────────────────────────────
# Stage 3: Build (if applicable)
# ──────────────────────────────────────────────
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# No build step needed — Bun runs TypeScript directly.
# This stage exists so we can copy source without
# including dev dependencies in the final image.

# ──────────────────────────────────────────────
# Stage 4: Production image
# ──────────────────────────────────────────────
FROM base AS release

# Production dependencies only
COPY --from=deps /app/node_modules ./node_modules

# Application source
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./

# Non-root user (security)
USER bun

# Fly.io sets PORT via environment variable
EXPOSE 3000

# Health check for Docker (Fly uses its own, but this helps local testing)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1) })" || exit 1

ENTRYPOINT ["bun", "run", "src/server.ts"]
```

### What each stage does

| Stage | Purpose | What's copied |
|---|---|---|
| `base` | Shared Bun image + workdir | Nothing yet |
| `deps` | Install production `node_modules` | `package.json`, `bun.lock` |
| `build` | Full install + source for potential build steps | Everything |
| `release` | Final image — production only | `node_modules` (prod), `src/`, `drizzle/`, `package.json` |

### Why multi-stage matters

The `deps` stage is cached by Docker. When you change source code but not
dependencies, Docker skips the `bun install` step entirely. Deploys go from
~60 seconds to ~15 seconds.

The final image excludes:
- Dev dependencies (`bun:test`, linters, type checkers)
- Test files (`tests/`)
- Documentation (`docs/`)
- Docker and CI configuration
- `.env` files (secrets come from Fly, not the image)

---

## 4. fly.toml

Every field is justified. No defaults accepted blindly.

```toml
app = "payment-engine"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[deploy]
  strategy = "rolling"
  release_command = "bun run db:migrate"

[env]
  NODE_ENV = "production"
  APP_ENV = "production"
  LOG_LEVEL = "info"
  DATABASE_SSL = "true"
  DB_POOL_SIZE = "15"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

[[http_service.checks]]
  grace_period = "15s"
  interval = "30s"
  method = "GET"
  path = "/health"
  timeout = "5s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

### Field-by-field justification

| Field | Value | Why |
|---|---|---|
| `primary_region` | `iad` | US East — matches Supabase's default AWS region. Sub-5ms DB round-trips. |
| `strategy` | `rolling` | Updates one machine at a time. Zero downtime. |
| `release_command` | `bun run db:migrate` | Runs migrations automatically before each deploy. If migration fails, deploy is aborted. |
| `NODE_ENV` | `production` | Standard. Libraries optimize behavior. |
| `APP_ENV` | `production` | Our guardrail. Blocks `db:reset` and other destructive dev commands. |
| `DATABASE_SSL` | `true` | Supabase requires SSL. |
| `DB_POOL_SIZE` | `15` | Supabase free tier allows ~20 direct connections. 15 leaves headroom. |
| `force_https` | `true` | Redirects HTTP to HTTPS. Non-negotiable for a payment API. |
| `auto_stop_machines` | `stop` | Stops the machine after idle period. Saves money. Machine restarts in ~3s on next request. |
| `auto_start_machines` | `true` | Automatically starts stopped machines on incoming request. |
| `min_machines_running` | `1` | Keep at least one machine warm. Set to `0` for cost savings when not demoing, `1` before a demo to avoid any cold start. |
| `grace_period` | `15s` | Wait 15 seconds after boot before health checking. Gives Bun time to start + DB connection to establish. |
| `interval` | `30s` | Check every 30 seconds. Frequent enough to catch issues, not so frequent it's noise. |
| `memory` | `512mb` | Bun is memory-efficient. 512MB is generous for a single-tenant API with no file processing. |

### Before a demo

Change `min_machines_running` to ensure zero cold starts:

```bash
# Keep the machine warm (no cold start)
fly scale count 1 --max-per-region 1

# Or set min_machines_running = 1 in fly.toml and redeploy
```

### After the demo

Let it sleep to save money:

```bash
# Machine will auto-stop when idle, auto-start on request
# ~3 second cold start is fine for non-demo usage
```

---

## 5. .dockerignore

```
node_modules
.git
.gitignore
.env
.env.*
tests/
docs/
coverage/
*.md
docker-compose.yml
Dockerfile
.dockerignore
.vscode/
.idea/
scripts/demo.ts
biome.json
tsconfig.json
```

**Rule:** If it's not needed at runtime, it doesn't go in the image. Smaller
images build faster, deploy faster, and have a smaller attack surface.

Notable exclusions:
- `tests/` — not needed in production, and including test dependencies would
  bloat the image
- `docs/` — these are for humans reading the repo, not for the running server
- `.env` — secrets come from `fly secrets set`, never baked into images
- `scripts/demo.ts` — the demo harness runs locally against the deployed API,
  it doesn't run ON the server

---

## 6. Health Check Endpoint

The health check is the first endpoint the CTO sees (Act 4 of the demo) and
the endpoint Fly.io hits every 30 seconds to verify the machine is alive.

### Design

```
GET /health

Response 200:
{
  "status": "ok",
  "version": "1.0.0",
  "uptime_seconds": 3847,
  "database": "connected",
  "timestamp": "2026-01-15T14:30:00.000Z"
}

Response 503:
{
  "status": "degraded",
  "version": "1.0.0",
  "uptime_seconds": 3847,
  "database": "disconnected",
  "timestamp": "2026-01-15T14:30:00.000Z"
}
```

### What it checks

| Check | Method | Failure behavior |
|---|---|---|
| Process alive | Implicit (responds to HTTP) | Fly restarts machine |
| Database connected | `SELECT 1` against Postgres | Returns 503 with `"database": "disconnected"` |
| Version correct | Reads `APP_VERSION` from env | Always succeeds (or env is misconfigured) |

### What it does NOT check

- Individual table existence (migration status) — that's `release_command`'s
  job
- Supabase API availability — we use direct Postgres, not the REST API
- External services — there are none in v1
- Business logic health — the test suite covers that

### Implementation notes

- No authentication required — Fly needs to hit it without credentials
- Lightweight — `SELECT 1` adds <1ms, not a full query
- Cached — response is computed fresh each time (no stale health reports)
- No sensitive data in response — no connection strings, no internal IPs

---

## 7. Environment Variables & Secrets

Two categories of configuration. The line between them is simple: would you
paste it in a public Slack channel?

### Non-sensitive → `[env]` in fly.toml (committed to git)

```toml
[env]
  NODE_ENV = "production"
  APP_ENV = "production"
  LOG_LEVEL = "info"
  DATABASE_SSL = "true"
  DB_POOL_SIZE = "15"
```

These are configuration, not secrets. They describe behavior, not credentials.

### Sensitive → `fly secrets set` (encrypted, never in git)

```bash
fly secrets set \
  DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  APP_VERSION="1.0.0"
```

| Secret | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase dashboard → Settings → Database → Connection string (direct, port 5432) | Never the pooled connection (port 6543) |

### What `fly secrets set` does

1. Encrypts the value in Fly's vault
2. Restarts all machines so they pick up the new secret
3. The secret is available as an environment variable inside the machine
4. The value can never be read back — only the running process can access it

### Verifying secrets are set

```bash
# Shows names, never values
fly secrets list

# Expected output:
# NAME           DIGEST                  CREATED AT
# DATABASE_URL   xxxxxxxxxxxxxxxx        2026-01-15T10:00:00Z
```

---

## 8. First Deployment (Zero to Live)

From nothing to a running API in 10 commands.

### Prerequisites

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login
```

### Step-by-step

```bash
# 1. Create the app (don't deploy yet)
fly launch --no-deploy

# This creates fly.toml. Replace its contents with the config from section 4.

# 2. Set the database secret
fly secrets set DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"

# 3. Deploy
fly deploy

# This will:
#   a. Build the Docker image (multi-stage, ~30-60s first time)
#   b. Run the release_command (bun run db:migrate)
#   c. Start the machine
#   d. Wait for health check to pass
#   e. Route traffic to the machine

# 4. Verify it's alive
fly status

# 5. Check the health endpoint
curl https://payment-engine.fly.dev/health

# 6. Seed system accounts (one-time, after first migration)
fly ssh console -C "bun run src/shared/seed.ts"

# 7. Verify the API
curl https://payment-engine.fly.dev/api/v1/payments

# 8. Open the docs
open https://payment-engine.fly.dev/docs
```

### What just happened

```
Local machine                         Fly.io                          Supabase
─────────────                         ──────                          ────────
fly deploy ──────────────────────→ Build Docker image
                                  Push to registry
                                  Create machine (iad)
                                  Run: bun run db:migrate ──────→ CREATE TABLE ...
                                  Start: bun run src/server.ts
                                  Health check: GET /health ─────→ SELECT 1
                                  ✓ Healthy — route traffic

curl .../health ─────────────────→ Fly proxy (TLS) ──→ Bun ─────→ SELECT 1
                                                        │
                                  ←────────── 200 OK ───┘
```

---

## 9. Subsequent Deploys

After the first deployment, shipping updates is one command.

```bash
# Make code changes, then:
fly deploy
```

That's it. Fly will:
1. Build a new image (cached layers make this fast)
2. Run `release_command` (migrations, if any)
3. Rolling-update the machine (zero downtime)
4. Health check the new version
5. Route traffic when healthy

### Deploying specific changes

```bash
# Just pushed a fix — deploy immediately
fly deploy

# Want to see what will change before deploying
fly deploy --build-only  # Builds image but doesn't deploy

# Need to run migrations manually (already done by release_command, but just in case)
fly ssh console -C "bun run db:migrate"
```

### Monitoring a deploy

```bash
# Watch deployment progress
fly status

# Tail logs during deploy
fly logs

# Check machine health
fly checks list
```

---

## 10. Region Co-location

**The single most impactful infrastructure decision for latency.**

Every database query from Fly to Supabase crosses a network. If the Fly
machine is in `iad` (Virginia) and Supabase is in `us-east-1` (also Virginia),
that round-trip is <5ms. If the Fly machine is in `lhr` (London) and Supabase
is in `us-east-1`, that round-trip is ~80ms.

A payment authorization involves ~4 database queries (insert payment, insert
transaction, insert entries, update payment). At 80ms per query, that's 320ms
just in network latency — before any computation.

### How to find your Supabase region

1. Supabase dashboard → Project Settings → General
2. Look for "Region" — it will say something like `us-east-1`

### Fly region mapping

| Supabase Region | AWS Region | Fly Region | Fly Region Name |
|---|---|---|---|
| US East (N. Virginia) | `us-east-1` | `iad` | Ashburn, Virginia |
| US West (Oregon) | `us-west-2` | `sea` | Seattle, Washington |
| EU West (Ireland) | `eu-west-1` | `lhr` | London, United Kingdom |
| EU Central (Frankfurt) | `eu-central-1` | `fra` | Frankfurt, Germany |
| AP Southeast (Singapore) | `ap-southeast-1` | `sin` | Singapore |
| AP Northeast (Tokyo) | `ap-northeast-1` | `nrt` | Tokyo, Japan |
| AP South (Mumbai) | `ap-south-1` | `bom` | Mumbai, India |
| South America (Sao Paulo) | `sa-east-1` | `gru` | Sao Paulo, Brazil |

Set your `primary_region` in `fly.toml` to match.

---

## 11. Custom Domain & TLS

The `*.fly.dev` subdomain works immediately, but
`https://pay.yourdomain.com` is more professional.

### Setup

```bash
# 1. Add the certificate
fly certs add pay.yourdomain.com

# 2. Get your app's IP addresses
fly ips list

# 3. Configure DNS at your registrar
#    For a subdomain (recommended):
#    CNAME  pay  →  payment-engine.fly.dev
#
#    For an apex domain:
#    A      @    →  [IPv4 from fly ips list]
#    AAAA   @    →  [IPv6 from fly ips list]

# 4. Verify certificate issuance (may take a few minutes)
fly certs check pay.yourdomain.com
```

Fly handles Let's Encrypt certificate issuance and renewal automatically. No
cron jobs, no certbot, no manual renewal.

### Cost

- First 10 single-hostname certificates per organization: **free**
- Additional certificates: $0.10/month each
- Wildcard certificates: $1.00/month

### Is a custom domain necessary?

For a CTO demo: **no.** `payment-engine.fly.dev` with HTTPS is credible. The
custom domain is a nice touch, not a requirement. Spend the time on the
engine, not on DNS configuration.

---

## 12. Cost

Honest breakdown. No hidden fees.

### Monthly cost for the demo deployment

| Resource | Provider | Cost |
|---|---|---|
| Compute (shared-cpu-1x, 512MB) | Fly.io | ~$3.50 |
| Database (free tier) | Supabase | $0 |
| TLS certificate (fly.dev subdomain) | Fly.io | $0 |
| Bandwidth (<1GB for demos) | Fly.io | ~$0 |
| **Total** | | **~$3.50/month** |

### Cost optimization

- **`auto_stop_machines = "stop"`** — machine stops when idle, restarts on
  request (~3 second cold start). If you're only demoing occasionally, the
  machine runs for minutes per month, not hours.
- **`min_machines_running = 0`** — full cost savings mode. The machine only
  runs when it receives a request. Set to `1` before a demo.
- **Supabase free tier pauses after 7 days of inactivity.** Visit the
  dashboard or make a request to unpause. ~1 minute cold start on first
  request after pause.

### What it would cost at scale

Not relevant for this project, but for context:

| Scale | Compute | Database | Monthly |
|---|---|---|---|
| Demo (current) | 1x shared, 512MB | Supabase free | ~$3.50 |
| Startup | 2x shared, 1GB | Supabase Pro ($25) | ~$37 |
| Production | 2x dedicated-cpu-2x, 4GB | Supabase Pro + read replicas | ~$250+ |

---

## 13. CI/CD

Push to `main`, tests run, deploy happens automatically. The god check gates
every deployment — if `SUM(debits) !== SUM(credits)`, the deploy is blocked.

For the complete pipeline — workflow files, test execution order, branch
protection rules, secrets management, failure debugging, and the god check
as a hard deployment gate — see [17 — CI/CD](./17-ci-cd.md).

Quick setup:

```bash
# Generate a Fly deploy token
fly tokens create deploy -x 999999h

# Add to GitHub: Settings → Secrets → Actions → FLY_API_TOKEN
```

The pipeline runs ~2 minutes: lint → unit tests → integration tests (with
Postgres) → E2E + advanced tests → deploy to Fly.io.

---

## 14. Pre-Flight Checklist

Run this before the first deploy. Run it again before a demo.

### First deploy

```
□ Supabase project created and active
□ Supabase region noted (for Fly co-location)
□ Fly CLI installed: fly version
□ Fly account created: fly auth login
□ Dockerfile in project root
□ fly.toml configured with correct region
□ .dockerignore in project root
□ fly launch --no-deploy (app created)
□ fly secrets set DATABASE_URL="..." (direct connection, port 5432)
□ fly deploy (first deploy)
□ fly ssh console -C "bun run src/shared/seed.ts" (seed accounts)
□ curl https://[app].fly.dev/health → 200
□ curl https://[app].fly.dev/api/v1/payments → 200
□ https://[app].fly.dev/docs loads (Scalar UI)
```

### Before a demo

```
□ Supabase project active (not paused — visit dashboard)
□ fly status → machine is running
□ min_machines_running = 1 (or machine manually started)
□ curl https://[app].fly.dev/health → 200, database: "connected"
□ Database clean: no leftover data from previous runs
□ Demo harness tested: DEMO_URL=https://[app].fly.dev bun run demo
□ Browser tab open to https://[app].fly.dev/docs
□ Terminal sized correctly for demo output
```

---

## 15. What NOT to Do

| Mistake | Why it fails | Do this instead |
|---|---|---|
| Use the Supabase pooled connection (port 6543) | `SELECT ... FOR UPDATE` breaks through PgBouncer transaction mode | Use direct connection (port 5432) |
| Bake `DATABASE_URL` into Dockerfile or fly.toml `[env]` | Credentials in git history forever | `fly secrets set DATABASE_URL="..."` |
| Skip the health check endpoint | Fly can't verify your app is alive; routes traffic to dead machines | Implement `GET /health` with DB connectivity check |
| Set `min_machines_running = 0` before a demo | First request has ~3s cold start. CTO notices. | Set to `1` or manually warm the machine |
| Deploy without running migrations | App starts, tries to query non-existent tables, crashes | `release_command` in fly.toml runs migrations automatically |
| Use Fly Postgres instead of Supabase | Two things to manage instead of one. Fly Postgres is unmanaged — you handle backups, upgrades, failover | Supabase is already configured and working |
| Run `bun run db:seed` in `release_command` | Seeds run on every deploy, potentially duplicating system accounts | Seed once manually via `fly ssh console`, or make seed idempotent |
| Choose a Fly region far from Supabase | 80ms per query × 4 queries per operation = 320ms latency added | Match Fly region to Supabase's AWS region |
| Deploy without testing locally first | "Works on my machine" → doesn't work in Docker → broken deploy | `docker build . && docker run` locally before `fly deploy` |

---

## 16. File Checklist

After following this document, your project root should contain:

```
payment-engine/
├── Dockerfile              ← Multi-stage Bun build (section 3)
├── fly.toml                ← Fly.io configuration (section 4)
├── .dockerignore           ← Image exclusions (section 5)
├── .github/
│   └── workflows/
│       └── deploy.yml      ← CI/CD pipeline (section 13, optional)
└── src/
    └── ... (existing application code)
```

The health check endpoint (`GET /health`) lives in the application code, not
in a separate file. It's a route like any other — defined with `createRoute()`,
validated with Zod, documented in the OpenAPI spec.

---

## 17. Deployment in the Development Flow

Per [14 — Development Flow](./14-development-flow.md), deployment
infrastructure is built in **Phase 4** (API Layer), after all routes exist.

```
Phase 1: Foundation       ← schema, config, shared utilities
Phase 2: Ledger Layer     ← core financial logic
Phase 3: Payment Layer    ← business operations
Phase 4: API Layer        ← routes, middleware, health check, Dockerfile, fly.toml
Phase 5: Advanced Testing ← load, property, fuzz, reconciliation
```

The Dockerfile and fly.toml are committed to git. The `DATABASE_URL` secret is
set via `fly secrets set` and never touches the repository. The CI/CD pipeline
gates deployment on the full test suite — including the god check.

Deploy is not an afterthought. It's part of the build.

---

Previous: [15 — Demo & Presentation](./15-demo-and-presentation.md) | Next: [17 — CI/CD](./17-ci-cd.md)
