import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { ApprovalRequestMessage } from './types';
import { randomUUID } from 'crypto';

interface KiroExecution {
  id: string;
  command: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied';
  context?: string;
}

export class ApprovalWatcher {
  private interval: NodeJS.Timeout | null = null;
  private pendingIds = new Set<string>();
  private readonly pollMs = 500;

  constructor(
    private readonly relay: RelayClient,
    private readonly timeoutSeconds: number
  ) {}

  start() {
    this.interval = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll() {
    try {
      // Access Kiro's internal execution API
      const executions: KiroExecution[] = (await vscode.commands.executeCommand(
        'kiroAgent.executions.getExecutions'
      ) as KiroExecution[] | undefined) ?? [];

      const pending = executions.filter(
        (e) => e.status === 'pending' && !this.pendingIds.has(e.id)
      );

      for (const exec of pending) {
        this.pendingIds.add(exec.id);
        void this.handlePendingExecution(exec);
      }

      // Clean up resolved executions from our tracking set
      const activeIds = new Set(executions.map((e) => e.id));
      for (const id of this.pendingIds) {
        if (!activeIds.has(id)) {
          this.pendingIds.delete(id);
        }
      }
    } catch {
      // kiroAgent API not available — Kiro may not be running an agent
      // Silently ignore; extension degrades to hook-only mode
    }
  }

  private async handlePendingExecution(exec: KiroExecution) {
    const requestId = randomUUID();
    const message: ApprovalRequestMessage = {
      type: 'approval_request',
      id: requestId,
      timestamp: Date.now(),
      command: exec.command,
      toolName: exec.toolName,
      context: exec.context,
      timeoutSeconds: this.timeoutSeconds,
    };

    // Send to phone and wait for response
    const approved = await this.relay.sendApprovalRequest(message);

    // Tell Kiro the result
    try {
      if (approved) {
        await vscode.commands.executeCommand(
          'kiroAgent.execution.runOrAcceptAll', exec.id
        );
      } else {
        await vscode.commands.executeCommand(
          'kiroAgent.execution.deny', exec.id
        );
      }
    } catch {
      // Command may not be available
    }

    this.pendingIds.delete(exec.id);
  }
}
