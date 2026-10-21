import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createSentinelGate } from "./server/gateway";
import { seedD1Database } from "./db/seed";

const app = new Hono();
const gateway = createSentinelGate();

// Mount gateway both at /api/v1 and root for maximum client compatibility
app.route("/api/v1", gateway);
app.route("/", gateway);

const port = Number(process.env.PORT || 8787);

async function start() {
  try {
    const seed = await seedD1Database();
    console.log(`☁️  Cloudflare D1 database ready (${seed.customers} customers, ${seed.billing} billing records).`);
  } catch (err) {
    console.warn("⚠️  D1 database auto-seed notice:", err instanceof Error ? err.message : err);
  }

  serve({
    fetch: app.fetch,
    port,
  }, (info) => {
    console.log(`🛡️  SentinelGate Hono API server running on http://localhost:${info.port}`);
    console.log(`📡 Endpoints mounted at http://localhost:${info.port}/api/v1 and http://localhost:${info.port}/health`);
  });
}

// Support Cloudflare Workers export
export default app;

// Start server in Node.js runtime
if (!process.env.CLOUDFLARE_WORKER) {
  void start();
}
