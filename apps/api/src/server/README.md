# SentinelGate backend

`createSentinelGate()` returns a Hono app whose routes are relative to the mount point. The intended Next App Router mount is:

```ts
// app/api/v1/[[...route]]/route.ts
import { createSentinelNextHandlers } from "@/src/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST, OPTIONS } = createSentinelNextHandlers();
```

The gateway accepts `POST /api/v1/actions/intercept` (and `/intercept`) with `{ action, actorId?, resource?, payload?, metadata? }`. It exposes action lookup/listing, audit listing, explicit `approve`, `block`, `freeze`, `unfreeze`, and compatibility `POST /actions/:id/resolve` transitions. `GET /stream` emits SSE action lifecycle events, and `GET /actions/:id/wait` provides long-poll resolution for pending work.

The explorer routes expose the seeded SQLite warehouse, disk-backed S3 bucket, local git repository, host telemetry, and secret scanner under `/explorer/*`. Action execution supports dry-run plans by default and requires an approved/allowed action for side effects.

Without `JEV_API_KEY`, the deterministic policy is used. With it, decisions are sent to `https://api.jevmodel.org/v1/decide` with the `noul`, `score`, and `choice` signals; service failures fail closed by freezing the action. When both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are present, the dependency-free REST adapter is selected; otherwise the durable local SQLite store is used.
