import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { StatusUpdateMessage } from './types';
import { randomUUID } from 'crypto';

type AgentState = 'idle' | 'running' | 'waiting_approval';

export class StatusPoller {
  private interval: NodeJS.Timeout | null = null;
  private lastState: AgentState = 'idle';
  private lastTask: string | undefined;
  private readonly pollMs = 1500;

  constructor(private readonly relay: RelayClient) {}

  start() {
    // Send an immediate update so the phone shows something right away
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // Called externally when approval state changes
  setWaitingApproval(toolName: string) {
    this.broadcast('waiting_approval', `Waiting approval: ${toolName}`);
  }

  setApprovalResolved() {
    void this.poll(); // re-poll immediately to get actual state
  }

  private async poll() {
    const { state, currentTask } = await this.detectAgentState();
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;

    // Only broadcast if something changed (reduces noise)
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

  private async detectAgentState(): Promise<{ state: AgentState; currentTask?: string }> {
    try {
      // Try kiroAgent.getAgentStatus (may exist in newer Kiro builds)
      const status = await vscode.commands.executeCommand('kiroAgent.getAgentStatus') as
        | { state?: string; currentTask?: string; taskName?: string }
        | undefined;

      if (status) {
        const s = (status.state ?? '').toLowerCase();
        const taskName = status.currentTask ?? status.taskName;
        if (s.includes('run') || s.includes('execut') || s.includes('work')) {
          return { state: 'running', currentTask: taskName };
        }
        if (s.includes('wait') || s.includes('approv') || s.includes('pending')) {
          return { state: 'waiting_approval', currentTask: taskName };
        }
        return { state: 'idle', currentTask: taskName };
      }
    } catch { /* not available */ }

    try {
      // Fall back to kiroAgent.executions.getExecutions
      const executions = await vscode.commands.executeCommand(
        'kiroAgent.executions.getExecutions'
      ) as Array<{ id: string; status: string; toolName?: string; command?: string }> | undefined ?? [];

      if (executions.some(e => e.status === 'pending')) {
        const pending = executions.find(e => e.status === 'pending');
        return {
          state: 'waiting_approval',
          currentTask: `Pending: ${pending?.toolName ?? pending?.command ?? 'tool'}`,
        };
      }
      if (executions.some(e => e.status === 'running' || e.status === 'in_progress')) {
        return { state: 'running', currentTask: 'Agent running…' };
      }
    } catch { /* not available */ }

    try {
      // Try kiroAgent.chat.getState or similar
      const chatState = await vscode.commands.executeCommand('kiroAgent.chat.getState') as
        | { isRunning?: boolean; currentMessage?: string }
        | undefined;

      if (chatState?.isRunning) {
        return { state: 'running', currentTask: chatState.currentMessage };
      }
    } catch { /* not available */ }

    return { state: 'idle' };
  }
}
