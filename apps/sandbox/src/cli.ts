import fs from "node:fs";
import path from "node:path";

/**
 * CLI front door for running an agent inside an Aegis sandbox.
 *
 *   npm run sandbox -- run [--mode observe|enforce] [--default allow|deny]
 *                      [--workspace DIR] [--stdin TEXT] [--env KEY=VALUE]...
 *                      [--name NAME] -- <command...>
 *
 * Examples:
 *   npm run sandbox -- run --workspace ./scripts --env GEMINI_API_KEY=... \
 *     --stdin "list unpaid invoices" -- tsx real-agent.ts
 *   npm run sandbox -- run --mode enforce -- bash -lc 'psql postgres://...'
 */
const SERVICE_URL = (process.env.AEGIS_SANDBOX_SERVICE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");

interface CliOptions {
  mode: "observe" | "enforce";
  enforceDefault: "allow" | "deny";
  name?: string;
  env: Record<string, string>;
  command: string[];
  workspace?: string;
  stdin?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "observe", enforceDefault: "deny", env: {}, command: [] };
  const dd = argv.indexOf("--");
  const flagPart = dd >= 0 ? argv.slice(0, dd) : argv.slice();
  options.command = dd >= 0 ? argv.slice(dd + 1) : [];
  for (let i = 0; i < flagPart.length; i++) {
    const flag = flagPart[i];
    if (flag === "--mode" && flagPart[i + 1]) { options.mode = flagPart[++i] === "enforce" ? "enforce" : "observe"; }
    else if (flag === "--default" && flagPart[i + 1]) { options.enforceDefault = flagPart[++i] === "allow" ? "allow" : "deny"; }
    else if (flag === "--name" && flagPart[i + 1]) { options.name = flagPart[++i]; }
    else if (flag === "--workspace" && flagPart[i + 1]) { options.workspace = flagPart[++i]; }
    else if (flag === "--stdin" && flagPart[i + 1]) { options.stdin = flagPart[++i]; }
    else if (flag === "--env" && flagPart[i + 1]) {
      const pair = flagPart[++i];
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`--env expects KEY=VALUE, got "${pair}"`);
      options.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.argv[2] !== "run" || options.command.length === 0) {
    console.error('Usage: npm run sandbox -- run [--mode observe|enforce] [--default allow|deny] [--workspace DIR] [--stdin TEXT] [--env KEY=VALUE]... [--name NAME] -- <command...>');
    process.exit(2);
  }
  if (options.workspace && !fs.existsSync(path.resolve(process.cwd(), options.workspace))) {
    console.error(`workspace path does not exist: ${path.resolve(process.cwd(), options.workspace)}`);
    process.exit(2);
  }

  const createResponse = await fetch(`${SERVICE_URL}/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: options.name || options.command.join(" ").slice(0, 60),
      command: options.command,
      env: options.env,
      mode: options.mode,
      enforceDefault: options.enforceDefault,
      ...(options.workspace ? { workspace: path.resolve(process.cwd(), options.workspace) } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    }),
  });
  if (!createResponse.ok) {
    console.error(`Failed to create sandbox (HTTP ${createResponse.status}): ${await createResponse.text()}`);
    console.error("Is the sandbox service running? Start it with: npm run dev:sandbox");
    process.exit(1);
  }
  const { sandbox } = (await createResponse.json()) as { sandbox: { id: string; mode: string } };
  const id = sandbox.id;
  console.log(`▶ sandbox ${id} (${sandbox.mode}) running: ${options.command.join(" ")}`);

  let printed = 0;
  let record: { status: string; exitCode?: number; report?: { eventCounts?: Record<string, number>; filesystem?: unknown[] } } | undefined;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const logsResponse = await fetch(`${SERVICE_URL}/sandboxes/${id}/logs`);
    if (logsResponse.ok) {
      const { logs } = (await logsResponse.json()) as { logs: string[] };
      for (; printed < logs.length; printed++) console.log(logs[printed]);
    }
    const detailResponse = await fetch(`${SERVICE_URL}/sandboxes/${id}`);
    if (!detailResponse.ok) continue;
    ({ sandbox: record } = (await detailResponse.json()) as { sandbox: typeof record });
    if (record && record.status !== "running") break;
  }

  // Give the service a moment to finalize the stop report (docker diff, counts).
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const finalResponse = await fetch(`${SERVICE_URL}/sandboxes/${id}`);
  if (finalResponse.ok) ({ sandbox: record } = (await finalResponse.json()) as { sandbox: typeof record });
  const alertsResponse = await fetch(`${SERVICE_URL}/sandboxes/${id}/events?type=alert`);
  const alerts = alertsResponse.ok ? ((await alertsResponse.json()) as { events: Array<{ detail: Record<string, unknown> }> }).events : [];
  console.log(`\n■ sandbox ${id} ${record.status}${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}`);
  const counts = record.report?.eventCounts || {};
  console.log(`  events: ${Object.entries(counts).map(([type, count]) => `${type}=${count}`).join(" ") || "none"}`);
  if (alerts.length) {
    console.log(`  ⚠ ${alerts.length} alert(s):`);
    for (const alert of alerts) console.log(`    - ${JSON.stringify(alert.detail)}`);
  }
  process.exit(record.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
