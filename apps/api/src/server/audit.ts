import crypto from "node:crypto";
import type { ActionRecord, ActionStatus, AuditEvent, AuditEventType, SentinelStore } from "./types";

export function makeId(prefix: string): string {
  const randomUUID = crypto?.randomUUID;
  const id = typeof randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${id}`;
}

export async function writeAudit(
  store: SentinelStore,
  input: {
    type: AuditEventType;
    action: ActionRecord;
    fromStatus?: ActionStatus;
    toStatus: ActionStatus;
    actorId?: string;
    reason?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  },
): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: makeId("audit"),
    type: input.type,
    actionId: input.action.id,
    timestamp: input.timestamp || new Date().toISOString(),
    actorId: input.actorId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    requestId: input.requestId,
    metadata: input.metadata,
  };
  await store.appendAudit(event);
  return event;
}
