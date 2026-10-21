import path from "node:path";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type AppDatabase = DrizzleD1Database<typeof schema>;

let cachedD1: D1Database | undefined;
let cachedDb: AppDatabase | undefined;
let platformProxyDispose: (() => Promise<void>) | undefined;

export interface DatabaseContext {
  d1: D1Database;
  db: AppDatabase;
}

/**
 * Resolves the Cloudflare D1 database and Drizzle instance.
 * - In Cloudflare Workers, passes through c.env.DB.
 * - In Node.js, uses Wrangler's getPlatformProxy to access local or remote D1.
 */
export async function getDatabase(envDb?: D1Database): Promise<DatabaseContext> {
  if (envDb) {
    return {
      d1: envDb,
      db: drizzle(envDb, { schema }),
    };
  }

  if (cachedD1 && cachedDb) {
    return { d1: cachedD1, db: cachedDb };
  }

  const { getPlatformProxy } = await import("wrangler");
  const apiDir = path.resolve(__dirname, "../..");
  const configPath = path.join(apiDir, "wrangler.jsonc");
  const persistPath = path.join(apiDir, ".wrangler/state/v3");

  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: { path: persistPath },
  });

  cachedD1 = proxy.env.DB;
  cachedDb = drizzle(cachedD1, { schema });
  platformProxyDispose = proxy.dispose;

  return { d1: cachedD1, db: cachedDb };
}

export async function closeDatabase(): Promise<void> {
  if (platformProxyDispose) {
    await platformProxyDispose().catch(() => undefined);
    platformProxyDispose = undefined;
    cachedD1 = undefined;
    cachedDb = undefined;
  }
}

export { schema };
