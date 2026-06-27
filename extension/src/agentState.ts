/**
 * Shared, in-process agent-state signal.
 *
 * The ApprovalWatcher and ExecutionWatcher record outstanding approvals here so
 * the StatusPoller can report `waiting_approval` reliably without re-polling
 * Kiro commands. Everything runs in the same extension host, so a simple shared
 * singleton is sufficient.
 */
export class AgentStateStore {
  private pendingApprovals = new Set<string>();

  addPendingApproval(id: string) { this.pendingApprovals.add(id); }
  removePendingApproval(id: string) { this.pendingApprovals.delete(id); }
  hasPendingApproval(): boolean { return this.pendingApprovals.size > 0; }
  clear() { this.pendingApprovals.clear(); }
}

/** Single shared instance for the whole extension host. */
export const agentState = new AgentStateStore();
