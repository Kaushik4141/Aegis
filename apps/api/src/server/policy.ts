import type { PolicyDecision, PolicyEvaluator, PolicyInput, SentinelEnvironment } from "./types";

const DESTRUCTIVE = /\b(delete|destroy|drop|wipe|purge|revoke|terminate|shutdown|disable)\b/i;
const HIGH_IMPACT = /\b(transfer|payment|payout|refund|send|publish|deploy|modify|update|write|permission|role|admin|production)\b/i;
const SENSITIVE = /\b(password|credential|secret|token|private[ _-]?key|exfiltrat|ransom|malware|backdoor)\b/i;
const READ_ONLY = /\b(read|get|list|search|fetch|view|describe|status|health|inspect)\b/i;

function textOf(input: PolicyInput): string {
  return [input.action, input.resource, input.actorId, JSON.stringify(input.payload ?? {}), JSON.stringify(input.metadata ?? {})]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ");
}

function amountOf(input: PolicyInput): number | undefined {
  const value = (input.payload as Record<string, unknown> | undefined)?.amount;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Stable, explainable fallback policy. It is intentionally conservative for
 * irreversible, financial, privilege, and sensitive-data operations.
 */
export function deterministicPolicy(input: PolicyInput): PolicyDecision {
  const text = textOf(input);
  const labels: string[] = [];
  let riskScore = 12;

  if (SENSITIVE.test(text)) {
    labels.push("sensitive-data");
    riskScore = 96;
    return {
      outcome: "freeze",
      reason: "Sensitive credential or potentially malicious data operation requires security review.",
      riskScore,
      policy: "deterministic-smart-v1",
      labels,
      provider: "deterministic",
    };
  }

  if (DESTRUCTIVE.test(text)) {
    labels.push("destructive");
    riskScore += 58;
  }
  if (HIGH_IMPACT.test(text)) {
    labels.push("high-impact");
    riskScore += 45;
  }

  const amount = amountOf(input);
  if (amount !== undefined && amount > 10_000) {
    labels.push("large-amount");
    riskScore += 28;
  } else if (amount !== undefined && amount > 1_000) {
    labels.push("financial");
    riskScore += 16;
  }

  if (READ_ONLY.test(text) && labels.length === 0) {
    return {
      outcome: "allow",
      reason: "Read-only operation matches the low-risk baseline.",
      riskScore: 5,
      policy: "deterministic-smart-v1",
      provider: "deterministic",
    };
  }

  riskScore = Math.min(100, riskScore);
  if (/\b(block|deny|forbid|malware|ransom)\b/i.test(text) || riskScore >= 95) {
    return {
      outcome: "block",
      reason: "The request matches a prohibited operation pattern.",
      riskScore,
      policy: "deterministic-smart-v1",
      labels,
      provider: "deterministic",
    };
  }
  if (riskScore >= 70) {
    return {
      outcome: "require_approval",
      reason: "High-impact operation requires an explicit approval before execution.",
      riskScore,
      policy: "deterministic-smart-v1",
      labels,
      provider: "deterministic",
    };
  }
  return {
    outcome: "allow",
    reason: "Operation is below the approval threshold.",
    riskScore,
    policy: "deterministic-smart-v1",
    labels,
    provider: "deterministic",
  };
}

export function normalizeOutcome(value: unknown): PolicyDecision["outcome"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[ -]/g, "_");
  if (["allow", "allowed", "approve", "approved", "permit"].includes(normalized)) return "allow";
  if (["require_approval", "pending", "review", "approval_required", "hold"].includes(normalized)) return "require_approval";
  if (["block", "blocked", "deny", "denied", "reject", "rejected"].includes(normalized)) return "block";
  if (["freeze", "frozen", "quarantine"].includes(normalized)) return "freeze";
  return undefined;
}

/**
 * Normalize policy-provider output before it is used by the gateway. Providers
 * commonly return `decision`, `result`, or human-friendly outcome spellings;
 * malformed output fails closed instead of being treated as an allow.
 */
export function normalizePolicyDecision(value: unknown): PolicyDecision {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const outcome = normalizeOutcome(raw.outcome ?? raw.decision ?? raw.result ?? raw.action);
  const riskValue = Number(raw.riskScore ?? raw.risk_score ?? raw.score);
  const normalizedOutcome = outcome || "freeze";
  return {
    outcome: normalizedOutcome,
    reason: typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason
      : outcome ? `Policy provider returned ${normalizedOutcome}.` : "Policy provider returned an invalid decision; action frozen for review.",
    riskScore: Number.isFinite(riskValue) ? Math.max(0, Math.min(100, riskValue)) : normalizedOutcome === "allow" ? 10 : 100,
    policy: typeof raw.policy === "string" && raw.policy.trim() ? raw.policy : "normalized-policy",
    labels: Array.isArray(raw.labels) ? raw.labels.filter((label): label is string => typeof label === "string") : undefined,
    provider: raw.provider === "jev" || raw.provider === "custom" || raw.provider === "deterministic" ? raw.provider : "custom",
    raw: value,
  };
}

export interface JevOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

function signal(input: PolicyInput, key: string): unknown {
  const metadata = input.metadata as Record<string, unknown> | undefined;
  const payload = input.payload as Record<string, unknown> | undefined;
  return metadata?.[key] ?? payload?.[key] ?? null;
}

export async function decideWithJev(input: PolicyInput, options: JevOptions): Promise<PolicyDecision> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await fetchImpl(options.endpoint || "https://api.jevmodel.org/v1/decide", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        action: input.action,
        actorId: input.actorId,
        resource: input.resource,
        payload: input.payload,
        metadata: input.metadata,
        // Jev's current API accepts these model signals alongside the action.
        // Preserve the keys even when a caller has not supplied a signal.
        noul: signal(input, "noul"),
        score: signal(input, "score"),
        choice: signal(input, "choice"),
      }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Jev decision failed with HTTP ${response.status}`);
    const outcome = normalizeOutcome(body.outcome ?? body.decision ?? body.result ?? body.action);
    if (!outcome) throw new Error("Jev response did not include a supported decision outcome");
    const score = Number(body.riskScore ?? body.risk_score ?? body.score);
    return {
      outcome,
      reason: typeof body.reason === "string" ? body.reason : "Decision returned by Jev.",
      riskScore: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : outcome === "allow" ? 10 : 80,
      policy: typeof body.policy === "string" ? body.policy : "jev",
      labels: Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === "string") : undefined,
      provider: "jev",
      raw: body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createPolicyEvaluator(
  env: SentinelEnvironment,
  options: { fetchImpl?: typeof fetch; evaluator?: PolicyEvaluator } = {},
): PolicyEvaluator {
  if (options.evaluator) return options.evaluator;
  if (!env.JEV_API_KEY) return deterministicPolicy;
  return async (input) => {
    try {
      return await decideWithJev(input, { apiKey: env.JEV_API_KEY as string, endpoint: env.JEV_API_URL, fetchImpl: options.fetchImpl });
    } catch (error) {
      // A configured policy service must fail closed rather than silently allow.
      return {
        outcome: "freeze",
        reason: `Jev policy service unavailable; action frozen for review (${error instanceof Error ? error.message : "unknown error"}).`,
        riskScore: 100,
        policy: "jev-fail-closed",
        labels: ["policy-service-unavailable"],
        provider: "jev",
      };
    }
  };
}
