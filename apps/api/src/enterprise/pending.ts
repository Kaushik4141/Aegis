import { EventEmitter } from "node:events";
import type { ActionRecord, ActionStatus, SentinelStore } from "../server/types";
import type { PendingActionEvent } from "./types";

export interface PendingResolution { status: Extract<ActionStatus, "approved" | "blocked" | "frozen" | "pending_approval">; actorId?: string; note?: string; }

/** Shared process-level coordination for operator approval and long polling. */
export class PendingActionsManager {
  private readonly events = new EventEmitter();
  private readonly previousStatus = new Map<string, ActionStatus>();
  private readonly unsubscribe: () => void;
  constructor(private readonly store: SentinelStore) {
    this.unsubscribe = store.on?.("action.updated", (value) => {
      const action = value as ActionRecord;
      const previous = this.previousStatus.get(action.id);
      const eventType: PendingActionEvent["type"] = !previous
        ? "action.created"
        : previous !== action.status
          ? "action.resolved"
          : "action.updated";
      this.previousStatus.set(action.id, action.status);
      this.events.emit(action.id, action);
      this.events.emit("all", action, eventType);
    }) || (() => undefined);
  }
  dispose(): void { this.unsubscribe(); this.previousStatus.clear(); this.events.removeAllListeners(); }
  subscribe(listener: (action: ActionRecord, type?: PendingActionEvent["type"]) => void): () => void { this.events.on("all", listener); return () => this.events.off("all", listener); }
  waitForResolution(id: string, timeoutMs = 30_000): Promise<ActionRecord | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: ActionRecord | null) => { if (timer) clearTimeout(timer); this.events.off(id, onUpdate); resolve(action); };
       const onUpdate = (action: ActionRecord) => { if (action.status !== "pending_approval" && action.status !== "frozen") finish(action); };
      this.events.on(id, onUpdate);
      timer = setTimeout(() => finish(null), Math.min(120_000, Math.max(1, timeoutMs)));
       void this.store.getAction(id).then((action) => { if (action && action.status !== "pending_approval" && action.status !== "frozen") finish(action); });
    });
  }
}

const managers = new WeakMap<SentinelStore, PendingActionsManager>();
export function pendingActionsFor(store: SentinelStore): PendingActionsManager {
  let manager = managers.get(store);
  if (!manager) { manager = new PendingActionsManager(store); managers.set(store, manager); }
  return manager;
}
