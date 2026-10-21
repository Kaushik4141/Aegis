import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const bucketRoot = process.env.SENTINEL_BUCKET_ROOT || path.join(process.cwd(), "data", "s3-buckets");

function safeKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) throw new Error("Unsafe object key.");
  return normalized;
}

function objectPath(bucket: string, key: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new Error("Invalid bucket name.");
  return path.join(bucketRoot, bucket, safeKey(key));
}

export async function ensureBucket(bucket = "customer-pii"): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new Error("Invalid bucket name.");
  const root = path.join(bucketRoot, bucket);
  await fs.mkdir(root, { recursive: true });
  if (bucket === "customer-pii") {
    const entries = await fs.readdir(root);
    const realEntries = entries.filter((entry) => entry !== ".gitkeep");
    if (realEntries.length === 0) {
      await fs.writeFile(path.join(root, "customers_export.json"), JSON.stringify([
        { customer_id: "cus_001", name: "Avery Customer 001", email: "customer001@acme.example", ssn_masked: "***-**-1001" },
        { customer_id: "cus_002", name: "Jordan Customer 002", email: "customer002@acme.example", ssn_masked: "***-**-1002" },
      ], null, 2));
      await fs.writeFile(path.join(root, "billing_export.csv"), "invoice_id,customer_id,amount_usd,status\ninv_00001,cus_001,132.31,paid\ninv_00002,cus_002,187.42,pending\n");
      await fs.writeFile(path.join(root, "README.txt"), "SentinelGate local customer-pii bucket. All access is policy-gated.\n");
    }
  }
  return root;
}

export async function listObjects(bucket = "customer-pii", prefix = ""): Promise<Array<{ key: string; size: number; etag: string; modifiedAt: string }>> {
  const root = await ensureBucket(bucket);
  const output: Array<{ key: string; size: number; etag: string; modifiedAt: string }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else {
        const stat = await fs.stat(absolute);
        const key = path.relative(root, absolute).split(path.sep).join("/");
        if (key.startsWith(prefix)) output.push({ key, size: stat.size, etag: createHash("md5").update(await fs.readFile(absolute)).digest("hex"), modifiedAt: stat.mtime.toISOString() });
      }
    }
  }
  await walk(root);
  return output.sort((a, b) => a.key.localeCompare(b.key));
}

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  return fs.readFile(objectPath(bucket, key));
}

export async function putObject(bucket: string, key: string, body: string | Buffer | Uint8Array): Promise<{ key: string; size: number; etag: string }> {
  const destination = objectPath(bucket, key);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const content = Buffer.from(body);
  await fs.writeFile(destination, content);
  return { key: safeKey(key), size: content.length, etag: createHash("md5").update(content).digest("hex") };
}

export async function deleteObjects(bucket: string, keys: string[]): Promise<{ deleted: string[]; missing: string[] }> {
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    try { await fs.unlink(objectPath(bucket, key)); deleted.push(safeKey(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(safeKey(key)); else throw error; }
  }
  return { deleted, missing };
}

export const s3Disk = { ensureBucket, listObjects, getObject, putObject, deleteObjects };
