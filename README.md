# SentinelGate

SentinelGate is an edge-native action firewall and human-in-the-loop control plane for autonomous business agents. It is structured as a **Turborepo monorepo**:
- **`apps/web`**: Next.js 15 frontend control plane dashboard (running on port `3000`). All `/api/v1/*` requests are transparently proxied to the Hono API server.
- **`apps/api`**: Standalone Hono server (running on port `8787`) hosting the gateway, policy engine, and MCP proxy, backed by **Cloudflare D1** managed with **Drizzle ORM**.

## Monorepo Architecture

```text
DEVHOST/
├── apps/
│   ├── web/                     # Next.js 15 UI Dashboard (Port 3000)
│   │   ├── app/                 # React control plane & topology views
│   │   └── next.config.mjs      # Transparent reverse proxy to Hono (Port 8787)
│   └── api/                     # Standalone Hono Server (Port 8787)
│       ├── src/
│       │   ├── db/              # Cloudflare D1 schema, Drizzle client & seeders
│       │   ├── server/          # Gateway routing, SSE, policy engine & store
│       │   └── enterprise/      # Enterprise data adapters (D1, S3, Git, Host)
│       ├── wrangler.jsonc       # Cloudflare D1 binding configuration
│       └── drizzle.config.ts    # Drizzle Kit configuration for D1
├── mcp-server/                  # Standalone MCP server
├── scripts/                     # Autonomous agent runners
├── turbo.json                   # Turborepo task pipeline configuration
└── package.json                 # Monorepo workspaces definition
```

## Run Locally

From the root directory:

```bash
npm install
npm run dev
```

`npm run dev` starts both `apps/web` (Next.js on `http://localhost:3000`) and `apps/api` (Hono on `http://localhost:8787`) concurrently via Turborepo.

You can also run them individually:
```bash
npm run dev:web   # Start Next.js dashboard only
npm run dev:api   # Start Hono API server only
```

Open `http://localhost:3000`. The dashboard communicates through Next.js rewrites to the standalone Hono server, reading from the local Cloudflare D1 database, enterprise fixtures, and SSE action stream.

## Cloudflare D1 & Drizzle ORM

The database is migrated to **Cloudflare D1** with schema and queries powered by **Drizzle ORM**.

- **Production / Cloud D1 Database**:
  - **Database Name**: `sentinelgate-d1`
  - **Database UUID**: `20ce154c-d0b5-4937-b530-80a8e806d21e`
  - **Account ID**: `4ae205d7c0bad1ac1f6d62b80e475556`
  - **Region**: `APAC (Singapore)`
  - **Status**: Migrated and seeded via `mcp.cloudflare.com` (100 customers, 250 billing rows, 1 MCP connection, 112 audit logs, 219 actions).
- **Local Development**:
  - Uses Wrangler's local state (`apps/api/.wrangler/state/v3`) bound to the same database UUID `20ce154c-d0b5-4937-b530-80a8e806d21e`.

### Database Commands (Run from root)

```bash
# Generate Drizzle migrations
npm run db:generate

# Apply migrations to local Cloudflare D1
npm run db:migrate

# Seed fixtures into local Cloudflare D1
npm run db:seed

# Re-run cloud migration via MCP
npx tsx scripts/migrate-to-cloud-d1.ts
```

## Gateway API

The gateway runs as a standalone Hono service:

```text
GET  /api/v1/health
POST /api/v1/actions/intercept
GET  /api/v1/actions
GET  /api/v1/actions/:id
GET  /api/v1/audit
POST /api/v1/actions/:id/approve
POST /api/v1/actions/:id/block
POST /api/v1/actions/:id/freeze
POST /api/v1/actions/:id/unfreeze
POST /api/v1/actions/:id/resolve
POST /api/v1/actions/:id/execute
GET  /api/v1/actions/:id/wait
GET  /api/v1/stream
GET  /api/v1/explorer/customers
GET  /api/v1/explorer/billing
GET  /api/v1/explorer/sql?sql=...
GET  /api/v1/explorer/s3
GET  /api/v1/explorer/git
GET  /api/v1/explorer/host
GET  /api/v1/explorer/secrets
GET  /api/v1/explorer/summary
GET  /api/v1/connections
POST /api/v1/connections
GET  /api/v1/connections/:id
PUT/PATCH/DELETE /api/v1/connections/:id
POST /api/v1/connections/:id/test
POST /api/v1/connections/:id/discover
GET  /api/v1/connections/:id/client-config
POST /api/v1/connections/:id/oauth/start
GET  /api/v1/connections/:id/oauth/status
GET  /api/v1/connections/:id/oauth/callback
POST /api/v1/mcp/:connectionId (MCP JSON-RPC streamable HTTP proxy)
```

MCP connections are persisted in `data/sentinel_audit.sqlite` (the same local
SQLite store used for audit state). `stdio`, streamable HTTP, and legacy SSE
upstreams are supported. Credentials supplied as `secrets`, `env`, or
`headers` are encrypted with a local AES-256-GCM key in
`data/.mcp-secret-key` (set `SENTINEL_MCP_SECRET_KEY` to provide a stable key
in a deployment) and are never returned by connection list/get/config
endpoints. Each connection also gets a random `sg_mcp_...` bearer token. The
token is returned exactly once by `POST /api/v1/connections`; save it like a
password. `tools/call` requests are evaluated by SentinelGate; pending
high-impact calls wait for the existing HITL resolve flow before forwarding
upstream. Proxy authentication failures are MCP JSON-RPC errors.

### OAuth 2.1 / PKCE for remote MCP servers

For HTTP and SSE connections, `POST /api/v1/connections/:id/oauth/start` performs
RFC 9728 protected-resource and RFC 8414/OIDC well-known discovery, registers a
public client when the provider advertises RFC 7591 dynamic registration, and
returns only an authorization URL plus safe status. The browser is sent back to
the exact callback URL
`{SENTINEL_PUBLIC_URL}/api/v1/connections/{id}/oauth/callback`; set
`SENTINEL_PUBLIC_URL` to the public origin used by the gateway. If dynamic
registration is unavailable, set `OAUTH_CLIENT_ID` and optionally
`OAUTH_CLIENT_SECRET`. State, PKCE verifiers, client records, and access/refresh
tokens are stored encrypted in the MCP registry. The callback validates state,
issuer, redirect URI, and OAuth errors, and never returns tokens. Stored refresh
tokens are used to refresh upstream access automatically when the gateway
reconnects. Existing manually configured bearer headers and stdio connections
remain supported.

### Gateway authentication and browser origins

Local development is intentionally frictionless when `SENTINEL_ADMIN_TOKEN`
is unset. Set it for a shared workstation or any non-loopback deployment; all
control-plane routes then require `Authorization: Bearer $SENTINEL_ADMIN_TOKEN`
(or `X-Sentinel-Admin-Token`). Every `/api/v1/mcp/:connectionId` request also
accepts the connection token as `X-MCP-Connection-Token` or a bearer token.
Admin tokens may be used for the proxy, but connection tokens are preferred for
client isolation. `SENTINEL_CORS_ORIGIN` is a comma-separated exact origin
allowlist. Wildcard `*` is ignored, and with no configured origin only
localhost/127.0.0.1 origins are accepted.

Create a streamable HTTP connection and capture its one-time token:

```bash
export SG_ADMIN_TOKEN='replace-with-a-long-random-value' # only if configured
curl -sS -X POST http://localhost:3000/api/v1/connections \
  -H "Authorization: Bearer $SG_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"My upstream","transport":"streamable-http","url":"https://mcp.example.test/mcp"}'
# Omit the Authorization line when SENTINEL_ADMIN_TOKEN is unset.
# Save .token from this response as SENTINEL_MCP_TOKEN.
export SENTINEL_MCP_TOKEN='sg_mcp_...'
```

The gateway validates JSON object bodies. Connection names are limited to 160
characters; string action fields are limited to 500 characters; action IDs are
limited to 160 characters; list endpoints accept 1-500 items (default 100);
HITL waits are capped at 300000 ms. Upstream credentials and token hashes are
never included in browser-facing list/get/config responses.

Example interception (a pending high-risk request holds the HTTP response until an operator resolves it):

```bash
curl -X POST http://localhost:3000/api/v1/actions/intercept \
  -H 'content-type: application/json' \
  -d '{"action":"delete unpaid invoices","actorId":"claude-code","resource":"BILLING","payload":{"sql":"DELETE FROM BILLING WHERE status = '\''pending'\''"}}'
```

For a direct read, send `{"action":"query_customer_dw","payload":{"sql":"SELECT * FROM CUSTOMERS LIMIT 5"}}`. For a risky action, approve or block it in the dashboard; a waiting client receives the final result or HTTP 403.

## Connect Claude Code, Codex, Cursor, or another MCP client

Start the gateway in one terminal:

```bash
npm run dev
```

The checked-in `.mcp.json` starts the local stdio bridge. If
`SENTINEL_ADMIN_TOKEN` is configured, export it before launching the client;
the bridge forwards it without printing it:

```bash
export SENTINEL_ADMIN_TOKEN="$SG_ADMIN_TOKEN"
claude --mcp-config .mcp.json
```

For a registered upstream, use its one-time token with the streamable HTTP URL
`http://localhost:3000/api/v1/mcp/<connectionId>`.

Claude Code (direct HTTP):

```bash
claude mcp add --transport http sentinelgate \
  http://localhost:3000/api/v1/mcp/CONNECTION_ID \
  --header "Authorization: Bearer $SENTINEL_MCP_TOKEN"
```

Codex CLI:

```bash
codex mcp add sentinelgate \
  --url http://localhost:3000/api/v1/mcp/CONNECTION_ID \
  --header "Authorization: Bearer $SENTINEL_MCP_TOKEN"
```

Cursor can import this project-local `.cursor/mcp.json` (or paste the same
object into Cursor's MCP settings):

```json
{
  "mcpServers": {
    "sentinelgate": {
      "url": "http://localhost:3000/api/v1/mcp/CONNECTION_ID",
      "headers": { "Authorization": "Bearer ${SENTINEL_MCP_TOKEN}" }
    }
  }
}
```

Generic Streamable HTTP MCP clients use the same URL and header:

```bash
curl -sS -X POST \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SENTINEL_MCP_TOKEN" \
  http://localhost:3000/api/v1/mcp/CONNECTION_ID \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"local-client","version":"1.0"}}}'
```

The stdio bridge exposes `query_customer_dw`, `s3_bucket_operation`,
`github_repo_action`, and `datadog_log_trace`. Every call sends host identity,
working directory, git email, prompt context, and tool arguments to
`/api/v1/intercept`. Pending requests remain waiting until the dashboard
operator clicks Approve, Execute Modified Action, or Block. Client
configurations intentionally contain endpoint and auth-header instructions,
never upstream credentials.

## Run the autonomous terminal agent

With the gateway still running, configure one provider key and launch:

```bash
GEMINI_API_KEY=... npm run agent
```

OpenAI and Anthropic are also supported:

```bash
OPENAI_API_KEY=... AGENT_PROVIDER=openai npm run agent
ANTHROPIC_API_KEY=... AGENT_PROVIDER=anthropic npm run agent
```

The prompt is `Ask Autonomous Enterprise Agent >`. The model only receives SentinelGate tools; it never gets direct database, S3, Git, or Datadog access.

## Run any agent inside an Aegis sandbox

MCP gating only covers traffic that flows through the gateway. The sandbox
(`apps/sandbox`, port `8788`) closes that gap for everything else: it runs any
agent command inside an instrumented Docker container and records every
outbound connection, DNS lookup, spawned process, file write, and output line.
A netwatch sidecar shares the container's network and PID namespaces, so even
sub-second connections and hard-coded IP access are visible with the owning
process name.

```bash
npm run dev:sandbox          # sandbox service on :8788 (builds the base image on first run)
npm run sandbox -- run -- bash -lc 'psql postgres://... -c "DELETE FROM users"'
npm run sandbox -- run --mode enforce -- node /workspace/scripts/real-agent.ts
```

Modes:

- **observe** — record everything, alert on shadow access. Any DNS lookup or
  outbound connection to a registered connection's host (or an extra
  `SENTINEL_SHADOW_WATCHLIST=host1,host2` list) raises a
  `sandbox.shadow_access` alert event plus an audit entry, in real time.
- **enforce** — additionally installs iptables rules (IPv4 and IPv6) so agent
  processes (uid 1000) can only reach the Aegis gateway and allow-listed
  endpoints (LLM providers, package registries; extend with
  `AEGIS_SANDBOX_ALLOW_DOMAINS`). Direct access to registered business
  systems is refused at the network layer and logged — raw credentials become
  unusable even if an agent holds them. `--default allow` flips the posture to
  "block only registered hosts".

Agents never run as root, never share the host filesystem, and get their
workspace from a per-sandbox volume. On stop, a `docker diff` report of every
file the agent touched is stored with the sandbox record.

Gateway API: `POST/GET /api/v1/sandboxes`, `GET /api/v1/sandboxes/:id/events`,
and `POST /api/v1/sandboxes/:id/events` (service-side ingest). The dashboard
gains a **Sandboxes** view with live output, the full observed timeline, and
shadow-access alerts.

## Optional production integrations

Set these environment variables when deploying:

```env
JEV_API_KEY=...
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
SENTINEL_REDIS_NAMESPACE=production
SENTINEL_CORS_ORIGIN=https://console.example.com
SENTINEL_HITL_TIMEOUT_MS=120000
GITHUB_TOKEN=...
DD_API_KEY=...
DD_APP_KEY=...
GEMINI_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

With `JEV_API_KEY`, policy decisions are sent to `https://api.jevmodel.org/v1/decide` with `noul`, `score`, and `choice` signals. A Jev outage fails closed by freezing the action. With both Upstash variables, the gateway uses the Upstash REST protocol; otherwise it uses the durable local SQLite store. Approved actions can execute against the seeded warehouse, disk-backed `customer-pii` bucket, local `data/acme-repo`, GitHub (when `GITHUB_TOKEN` exists), and Datadog (when `DD_API_KEY` exists).

## Checks

```bash
npm run typecheck
npm run build
```
