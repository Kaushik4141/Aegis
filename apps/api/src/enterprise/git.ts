import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const repoRoot = process.env.SENTINEL_REPO_ROOT || path.join(process.cwd(), "data", "acme-repo");

function safeRepoPath(file: string): string {
  const normalized = file.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized === ".") return normalized;
  if (!normalized || normalized.split("/").some((part) => part === "." || part === "..")) throw new Error("Unsafe repository path.");
  return normalized;
}

async function git(args: string[]): Promise<string> {
  await fs.mkdir(repoRoot, { recursive: true });
  try { return (await exec("git", ["-C", repoRoot, ...args], { maxBuffer: 2_000_000 })).stdout.trim(); }
  catch (error) { throw new Error(`git ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function ensureRepo(): Promise<string> {
  try { await git(["rev-parse", "--is-inside-work-tree"]); }
  catch { await git(["init", "-b", "main"]); }
  return repoRoot;
}

export async function gitStatus(): Promise<{ branch: string; status: string }> {
  await ensureRepo();
  return { branch: await git(["branch", "--show-current"]), status: await git(["status", "--short"]) };
}

export async function gitDiff(): Promise<string> { await ensureRepo(); return git(["diff", "--no-ext-diff"]); }
export async function gitLog(limit = 20): Promise<string> { await ensureRepo(); return git(["log", `-${Math.min(100, Math.max(1, limit))}`, "--oneline"]); }
export async function gitAddCommit(message: string, files: string[] = ["."]): Promise<string> {
  await ensureRepo();
  await git(["add", "--", ...(files.length ? files : ["."]).map(safeRepoPath)]);
  return git(["commit", "-m", message]);
}

/** Write a tracked workspace file before an approved local git commit. */
export async function writeRepoFile(file: string, body: string | Buffer): Promise<string> {
  const destination = path.join(repoRoot, safeRepoPath(file));
  await ensureRepo();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, body);
  return safeRepoPath(file);
}

export async function githubRequest(pathname: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured.");
  const response = await fetchImpl(`https://api.github.com${pathname}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return body;
}
