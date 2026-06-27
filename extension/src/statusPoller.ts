import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { StatusUpdateMessage } from './types';
import { randomUUID } from 'crypto';
import { agentState } from './agentState';
import { findNewestExecutionFile, readExecutionFile } from './executionFiles';

type AgentState = 'idle' | 'running' | 'waiting_approval';

/**
 * Broadcasts the agent's state to the phone.
 *
 * State is derived primarily from disk + the shared pending-approval signal,
 * which is far more reliable than guessing via kiroAgent.* commands that may
 * not exist:
 *   - waiting_approval: an approval is outstanding (set by the watchers)
 *   - running:          the active execution file was written very recently
 *   - idle:             otherwise
 */
export class StatusPoller {
  private interval: NodeJS.Timeout | null = null;
  private lastState: AgentState = 'idle';
  private lastTask: string | undefined;
  private readonly pollMs = 1200;
  /** If the newest execution file was touched within this window, Kiro is running. */
  private readonly runningWindowMs = 4000;

  constructor(private readonly relay: RelayClient) {}

  start() {
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll() {
    const { state, currentTask } = this.detectAgentState();
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;

    // Only broadcast on change (reduces noise)
    if (state !== this.lastState || currentTask !== this.lastTask) {
      this.lastState = state;
      this.lastTask = currentTask;
      this.broadcast(state, currentTask, workspaceName);
    }
  }

  private broadcast(state: AgentState, currentTask?: string, workspaceName?: string) {
    const msg: StatusUpdateMessage = {
      type: 'status_update',
      id: randomUUID(),
      timestamp: Date.now(),
      agentState: state,
      currentTask,
      workspaceName,
    };
    this.relay.send(msg);
  }

  private detectAgentState(): { state: AgentState; currentTask?: string } {
    // 1. Outstanding approval always wins.
    if (agentState.hasPendingApproval()) {
      return { state: 'waiting_approval', currentTask: 'Waiting for approval' };
    }

    // 2. Active execution file written recently → running.
    const newest = findNewestExecutionFile();
    if (newest && Date.now() - newest.mtimeMs <= this.runningWindowMs) {
      return { state: 'running', currentTask: this.describeActiveExecution(newest.path) };
    }

    return { state: 'idle' };
  }

  /** Best-effort short description of what the agent is currently doing. */
  private describeActiveExecution(file: string): string {
    const data = readExecutionFile(file);
    const actions = data?.actions ?? [];
    // Walk backwards for the most recent meaningful action.
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (!a) continue;
      if (a.actionType === 'say') {
        const msg = a.output?.message?.trim();
        if (msg) return msg.length > 80 ? msg.substring(0, 80) + '…' : msg;
      }
      const toolName = (a as { toolName?: string; name?: string }).toolName
        ?? (a as { toolName?: string; name?: string }).name;
      if (a.actionType && a.actionType !== 'say') {
        return toolName ? `${a.actionType}: ${toolName}` : a.actionType;
      }
    }
    return 'Agent running…';
  }
}
