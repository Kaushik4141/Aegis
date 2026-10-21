import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface HostTelemetry { hostname: string; platform: string; arch: string; uptime: number; memory: { total: number; free: number }; load: number[]; pid: number; node: string; username: string; gitEmail: string | null; cwd: string; }

export function hostTelemetry(): HostTelemetry {
  let username = process.env.USER || process.env.USERNAME || "unknown";
  try { username = os.userInfo().username; } catch { /* fallback above */ }
  let gitEmail: string | null = null;
  try { gitEmail = execFileSync("git", ["config", "--get", "user.email"], { encoding: "utf8" }).trim() || null; } catch { /* git may not be configured */ }
  return { hostname: os.hostname(), platform: process.platform, arch: process.arch, uptime: os.uptime(), memory: { total: os.totalmem(), free: os.freemem() }, load: os.loadavg(), pid: process.pid, node: process.version, username, gitEmail, cwd: process.cwd() };
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["aws-access-key", /AKIA[0-9A-Z]{16}/g], ["github-token", /gh[pousr]_[A-Za-z0-9_]{20,}/g], ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["generic-secret", /(?:api[_-]?key|secret|token|password)\s*[=:]\s*["']?[A-Za-z0-9_\-/.+=]{16,}/gi],
];

export interface SecretFinding { file: string; type: string; line: number; preview: string; }

export async function scanSecrets(root = process.cwd(), maxFiles = 2_000): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  let visited = 0;
  async function walk(directory: string): Promise<void> {
    if (visited >= maxFiles) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name.startsWith("enterprise_") || entry.name.startsWith("sentinel_audit")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!/\.(env|json|ya?ml|toml|ini|cfg|conf|ts|tsx|js|mjs|py|go|md|txt)$/i.test(entry.name)) continue;
      visited += 1;
      const content = await fs.readFile(absolute, "utf8").catch(() => "");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => SECRET_PATTERNS.forEach(([type, pattern]) => {
        pattern.lastIndex = 0;
        if (pattern.test(line)) findings.push({ file: path.relative(root, absolute), type, line: index + 1, preview: line.slice(0, 180).replace(/(["']?)([A-Za-z0-9_\-]{8})[A-Za-z0-9_\-]{4,}/g, "$1$2…") });
      }));
    }
  }
  await walk(root);
  return findings;
}
