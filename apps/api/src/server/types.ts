/** Public types used by the SentinelGate gateway. */

export type ActionStatus =
  | "allowed"
  | "pending_approval"
  | "approved"
  | "blocked"
  | "frozen";

export type PolicyOutcome = "allow" | "require_approval" | "block" | "freeze";

export interface ActionRequest {
  /** A caller supplied id is accepted for idempotency; one is generated when omitted. */
  id?: string;
  action: string;
  actorId?: string;
  resource?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  riskScore: number;
  policy: string;
  labels?: string[];
  provider?: "deterministic" | "jev" | "custom";
  raw?: unknown;
}

export interface ActionRecord extends Required<Pick<ActionRequest, "id" | "action">> {
  actorId?: string;
  resource?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  status: ActionStatus;
  decision: PolicyDecision;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  resolutionNote?: string;
  /** Enterprise execution plan and result are populated by the local runtime. */
  analysis?: unknown;
  execution?: unknown;
}

export type PendingApproval = ActionRecord & { status: "pending_approval" };

export type AuditEventType =
  | "action.intercepted"
  | "action.approved"
  | "action.blocked"
  | "action.frozen"
  | "action.unfrozen"
  | "sandbox.alert";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  actionId: string;
  timestamp: string;
  actorId?: string;
  fromStatus?: ActionStatus;
  toStatus: ActionStatus;
  reason?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface SentinelStore {
  getAction(id: string): Promise<ActionRecord | null>;
  putAction(action: ActionRecord): Promise<void>;
  listActions(limit?: number): Promise<ActionRecord[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(limit?: number, actionId?: string): Promise<AuditEvent[]>;
  /** Local stores can notify subscribers. Remote stores may return a no-op unsubscribe. */
  on?(event: "action.updated" | "audit", listener: (value: ActionRecord | AuditEvent) => void): () => void;
}

export interface SentinelEnvironment {
  JEV_API_KEY?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  SENTINEL_REDIS_NAMESPACE?: string;
  SENTINEL_STORE?: "memory" | "sqlite" | "upstash";
  SENTINEL_DATA_DIR?: string;
  SENTINEL_BUCKET_ROOT?: string;
  SENTINEL_REPO_ROOT?: string;
  ENTERPRISE_DB_PATH?: string;
  SENTINEL_AUDIT_DB_PATH?: string;
  SENTINEL_HITL_TIMEOUT_MS?: string;
  GITHUB_TOKEN?: string;
  DD_API_KEY?: string;
  DD_APP_KEY?: string;
  JEV_API_URL?: string;
  /** Optional bearer token for administrative/control-plane API calls. */
  SENTINEL_ADMIN_TOKEN?: string;
  /** Public origin used to construct exact OAuth callback URLs. */
  SENTINEL_PUBLIC_URL?: string;
  /** Optional pre-registered OAuth client credentials used when DCR is unavailable. */
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_CLIENT_NAME?: string;
  SENTINEL_OAUTH_STATE_TTL_MS?: string;
  /** Comma-separated allowlist of browser origins. Wildcard origins are ignored. */
  SENTINEL_CORS_ORIGIN?: string;
  /** Extra hosts (beyond registered connections) treated as shadow-access targets. */
  SENTINEL_SHADOW_WATCHLIST?: string;
}

export interface PolicyInput extends ActionRequest {
  id: string;
}

export type PolicyEvaluator = (input: PolicyInput) => Promise<PolicyDecision> | PolicyDecision;

export interface SentinelGatewayOptions {
  env?: SentinelEnvironment;
  store?: SentinelStore;
  policyEvaluator?: PolicyEvaluator;
  fetchImpl?: typeof fetch;
  idFactory?: () => string;
  now?: () => Date;
  redisNamespace?: string;
  /** Set to false to omit the default permissive CORS middleware. */
  cors?: false | { origin?: string | string[]; allowHeaders?: string[]; allowMethods?: string[] };
}
