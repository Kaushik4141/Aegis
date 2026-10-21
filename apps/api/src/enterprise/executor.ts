import { dryRunMutation, executeEnterpriseSql } from "./data";
import { deleteObjects, getObject, listObjects, putObject } from "./storage";
import { ensureRepo, gitAddCommit, gitDiff, gitLog, gitStatus, githubRequest, writeRepoFile } from "./git";
import { hostTelemetry, scanSecrets } from "./telemetry";
import type { ActionAnalysis, ExecutionResult, EnterpriseTarget } from "./types";

function text(input: { action: string; resource?: string; payload?: unknown }): string {
  return `${input.action} ${input.resource || ""} ${JSON.stringify(input.payload || {})}`.toLowerCase();
}

function targetFor(input: { action: string; resource?: string; payload?: unknown }): EnterpriseTarget {
  const value = `${input.action} ${input.resource || ""} ${JSON.stringify(input.payload || {})}`.toLowerCase();
  if (/s3|bucket|object/.test(value)) return "s3";
  if (/sql|snowflake|select|insert|update|delete|customer|billing/.test(value)) return "sql";
  if (/github|git|branch|commit|repo/.test(value)) return value.includes("github") ? "github" : "git";
  if (/datadog|metric|event|monitor|log/.test(value)) return "datadog";
  return "host";
}

export async function analyzeAction(input: { action: string; resource?: string; payload?: unknown }): Promise<ActionAnalysis> {
  const target = targetFor(input);
  const value = text(input);
  const payload = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Record<string, unknown>;
  const operation = typeof payload.operation === "string" ? payload.operation : input.action;
  const warnings: string[] = [];
  const plan: string[] = [];
  let risk: ActionAnalysis["risk"] = "low";
  let summary = "No side effects will be performed.";
  if (target === "sql") {
    const sql = typeof payload.sql === "string" ? payload.sql : typeof payload.query === "string" ? payload.query : "";
    const write = /\b(insert|update|delete|drop|alter|truncate|replace)\b/i.test(sql || value);
    risk = write ? "high" : "low";
    summary = sql ? `SQL ${write ? "write" : "read"} query against the enterprise warehouse.` : "Enterprise warehouse query.";
    plan.push(sql ? `Prepare ${sql.slice(0, 180)}` : "Inspect the requested warehouse operation");
    if (write) warnings.push("SQL writes require explicit approval and are never run during dry-run analysis.");
    if (sql && /\b(update|delete)\b/i.test(sql)) {
      try {
        const dryRun = await dryRunMutation(sql, Array.isArray(payload.params) ? payload.params : []);
        return { target, operation, dryRun: true, risk, summary, affected: dryRun.affected, preview: dryRun.preview, warnings, plan: [...plan, `Dry-run blast radius: ${dryRun.affected} row(s)`] };
      } catch (error) {
        warnings.push(`Dry-run unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (target === "s3") {
    const destructive = /\b(delete|remove|purge|wipe)\b/.test(value);
    risk = destructive ? "high" : /put|upload|write|copy/.test(value) ? "medium" : "low";
    summary = `${operation} on the disk-backed S3-compatible bucket.`;
    plan.push("Resolve bucket and normalized object keys", "Verify operation policy", destructive ? "Delete only explicitly listed objects" : "Read or write selected objects");
    if (destructive) warnings.push("Object deletion is irreversible and requires approval.");
  } else if (target === "git" || target === "github") {
    const write = /push|commit|merge|delete|reset|force/.test(value);
    risk = write ? "high" : "low";
    summary = `${target === "github" ? "GitHub API" : "Local repository"} operation.`;
    plan.push("Inspect repository state", "Apply branch and path policy", write ? "Perform write only after approval" : "Return repository metadata");
    if (write) warnings.push("Repository writes and pushes require explicit approval.");
  } else if (target === "datadog") {
    risk = /delete|mute|update|create|write/.test(value) ? "high" : "low";
    summary = "Datadog telemetry operation.";
    plan.push("Validate Datadog credentials", "Request only the selected telemetry resource");
    if (!process.env.DD_API_KEY) warnings.push("DD_API_KEY is not configured; returning a dry-run plan.");
  } else {
    summary = "Host telemetry inspection.";
    plan.push("Read process and host metrics");
  }
  return { target, operation, dryRun: true, risk, summary, warnings, plan };
}

function payloadOf(input: { payload?: unknown }): Record<string, unknown> {
  return input.payload && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {};
}

export async function executeAction(input: { action: string; resource?: string; payload?: unknown }, options: { dryRun?: boolean; fetchImpl?: typeof fetch } = {}): Promise<ExecutionResult> {
  const analysis = await analyzeAction(input);
  const dryRun = options.dryRun !== false;
  if (dryRun) return { executed: false, target: analysis.target, operation: analysis.operation, dryRun: true, summary: analysis.summary, data: { plan: analysis.plan }, warnings: analysis.warnings };
  const payload = payloadOf(input);
  try {
    if (analysis.target === "sql") {
      const sql = typeof payload.sql === "string" ? payload.sql : typeof payload.query === "string" ? payload.query : "SELECT 1 AS ok";
      const result = await executeEnterpriseSql(sql, Array.isArray(payload.params) ? payload.params : []);
      const summary = result.changes === undefined ? `Returned ${result.rows.length} row(s).` : `Changed ${result.changes} row(s).`;
      return { executed: true, target: "sql", operation: analysis.operation, dryRun: false, summary, data: result, warnings: analysis.warnings };
    }
    if (analysis.target === "s3") {
      const bucket = typeof payload.bucket === "string" ? payload.bucket : "customer-pii";
      const keys = Array.isArray(payload.keys) ? payload.keys.filter((key): key is string => typeof key === "string") : typeof payload.key === "string" ? [payload.key] : [];
       if (/export_all/.test(analysis.operation.toLowerCase())) {
         const objects = await listObjects(bucket, typeof payload.prefix === "string" ? payload.prefix : "");
         const contents = await Promise.all(objects.map(async (object) => ({ ...object, body: (await getObject(bucket, object.key)).toString("utf8") })));
         return { executed: true, target: "s3", operation: analysis.operation, dryRun: false, summary: `Exported ${contents.length} object(s) from ${bucket}.`, data: contents, warnings: analysis.warnings };
       }
       if (/list|ls|read/.test(analysis.operation.toLowerCase()) || !keys.length) return { executed: true, target: "s3", operation: analysis.operation, dryRun: false, summary: `Listed objects in ${bucket}.`, data: await listObjects(bucket, typeof payload.prefix === "string" ? payload.prefix : "") };
      if (/delete|remove|purge|wipe/.test(analysis.operation.toLowerCase())) return { executed: true, target: "s3", operation: analysis.operation, dryRun: false, summary: `Deleted selected object(s) from ${bucket}.`, data: await deleteObjects(bucket, keys), warnings: analysis.warnings };
      if (typeof payload.body === "string" || Buffer.isBuffer(payload.body)) return { executed: true, target: "s3", operation: analysis.operation, dryRun: false, summary: `Wrote ${keys[0]} to ${bucket}.`, data: await putObject(bucket, keys[0], payload.body as string | Buffer), warnings: analysis.warnings };
      return { executed: true, target: "s3", operation: analysis.operation, dryRun: false, summary: `Read ${keys[0]} from ${bucket}.`, data: (await getObject(bucket, keys[0])).toString("utf8") };
    }
    if (analysis.target === "git") {
      await ensureRepo();
      if (/diff/.test(analysis.operation)) return { executed: true, target: "git", operation: analysis.operation, dryRun: false, summary: "Returned local repository diff.", data: await gitDiff() };
      if (/log/.test(analysis.operation)) return { executed: true, target: "git", operation: analysis.operation, dryRun: false, summary: "Returned local repository history.", data: await gitLog(Number(payload.limit) || 20) };
      if (/commit/.test(analysis.operation)) {
        if (typeof payload.file === "string" && (typeof payload.content === "string" || Buffer.isBuffer(payload.content))) {
          await writeRepoFile(payload.file, payload.content as string | Buffer);
        }
        const files = Array.isArray(payload.files) ? payload.files.filter((file): file is string => typeof file === "string") : ["."];
        return { executed: true, target: "git", operation: analysis.operation, dryRun: false, summary: "Created local repository commit.", data: await gitAddCommit(typeof payload.message === "string" ? payload.message : "SentinelGate commit", files) };
      }
      return { executed: true, target: "git", operation: analysis.operation, dryRun: false, summary: "Returned local repository status.", data: await gitStatus() };
    }
    if (analysis.target === "github") {
      const endpoint = typeof payload.endpoint === "string" ? payload.endpoint : "/user/repos";
      return { executed: true, target: "github", operation: analysis.operation, dryRun: false, summary: "GitHub API request completed.", data: await githubRequest(endpoint, { method: typeof payload.method === "string" ? payload.method : "GET", body: payload.body ? JSON.stringify(payload.body) : undefined }, options.fetchImpl) };
    }
    if (analysis.target === "datadog") {
      const endpoint = typeof payload.endpoint === "string" ? payload.endpoint : "https://api.datadoghq.com/api/v1/validate";
      if (!process.env.DD_API_KEY) return { executed: false, target: "datadog", operation: analysis.operation, dryRun: true, summary: "Datadog credentials are unavailable; no request was sent.", warnings: analysis.warnings };
       const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "GET";
       const requestBody = payload.body === undefined ? undefined : typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body);
       const response = await (options.fetchImpl || fetch)(endpoint, {
         method,
         headers: {
           "DD-API-KEY": process.env.DD_API_KEY,
           ...(process.env.DD_APP_KEY ? { "DD-APPLICATION-KEY": process.env.DD_APP_KEY } : {}),
           ...(requestBody ? { "content-type": "application/json" } : {}),
         },
         body: requestBody,
       });
      return { executed: response.ok, target: "datadog", operation: analysis.operation, dryRun: false, summary: `Datadog returned HTTP ${response.status}.`, data: await response.json().catch(() => ({})), warnings: analysis.warnings };
    }
    if (/secret|credential|scan/.test(`${input.action} ${analysis.operation}`.toLowerCase())) {
      return { executed: true, target: "host", operation: analysis.operation, dryRun: false, summary: "Secret scan completed.", data: { findings: await scanSecrets(typeof payload.root === "string" ? payload.root : process.cwd()) } };
    }
    return { executed: true, target: "host", operation: analysis.operation, dryRun: false, summary: "Host telemetry is read-only.", data: hostTelemetry() };
  } catch (error) {
    return { executed: false, target: analysis.target, operation: analysis.operation, dryRun: false, summary: "Action execution failed.", error: error instanceof Error ? error.message : String(error), warnings: analysis.warnings };
  }
}
