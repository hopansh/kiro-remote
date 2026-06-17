import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { ApprovalRequestMessage } from './types';
import { randomUUID } from 'crypto';

interface KiroExecution {
  id: string;
  executionId?: string;
  status?: string;
  state?: string;
  pendingQuestions?: Array<{ questionId: string; question: string; toolName?: string }>;
}

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[kiro-remote:approval ${ts}] ${msg}`);
}

export class ApprovalWatcher {
  private interval: NodeJS.Timeout | null = null;
  private pendingQuestionIds = new Set<string>();
  private readonly pollMs = 800;

  constructor(
    private readonly relay: RelayClient,
    private readonly timeoutSeconds: number
  ) {}

  start() {
    this.interval = setInterval(() => void this.poll(), this.pollMs);
    log('ApprovalWatcher started');
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    log('ApprovalWatcher stopped');
  }

  private async poll() {
    try {
      // Primary: get all executions
      const executions = await vscode.commands.executeCommand(
        'kiroAgent.executions.getExecutions'
      ) as KiroExecution[] | undefined;

      if (!executions || !Array.isArray(executions)) return;

      log(`Executions: ${executions.length}, states: ${executions.map(e => e.status ?? e.state ?? '?').join(',')}`);

      for (const exec of executions) {
        const execId = exec.executionId ?? exec.id;

        // Try getPendingQuestions for this execution
        try {
          const questions = await vscode.commands.executeCommand(
            'kiroAgent.executions.getPendingQuestions', execId
          ) as Array<{ questionId: string; question?: string; toolName?: string; command?: string }> | undefined;

          if (questions && questions.length > 0) {
            for (const q of questions) {
              if (this.pendingQuestionIds.has(q.questionId)) continue;
              this.pendingQuestionIds.add(q.questionId);
              log(`Pending question: ${q.questionId} tool=${q.toolName} q=${q.question}`);
              void this.handleQuestion(execId, q.questionId, q.toolName ?? 'tool', q.question ?? q.command ?? '');
            }
          }
        } catch (e) {
          log(`getPendingQuestions failed for ${execId}: ${e}`);
        }
      }

      // Clean up resolved question IDs
      // (simple: clear all after 5 minutes to avoid memory leak)
      if (this.pendingQuestionIds.size > 100) {
        this.pendingQuestionIds.clear();
      }

    } catch (e) {
      // API not available — silent
      log(`poll error (probably no executions yet): ${e}`);
    }
  }

  private async handleQuestion(executionId: string, questionId: string, toolName: string, question: string) {
    const requestId = randomUUID();
    const message: ApprovalRequestMessage = {
      type: 'approval_request',
      id: requestId,
      timestamp: Date.now(),
      command: question,
      toolName,
      timeoutSeconds: this.timeoutSeconds,
    };

    log(`Sending approval request to phone: ${requestId}`);
    const approved = await this.relay.sendApprovalRequest(message);
    log(`Phone responded: ${approved ? 'APPROVED' : 'DENIED'}`);

    try {
      await vscode.commands.executeCommand(
        'kiroAgent.executions.acceptUserResponse',
        { questionId, response: approved ? 'yes' : 'no', executionId }
      );
      log(`acceptUserResponse sent: ${approved}`);
    } catch (e) {
      log(`acceptUserResponse failed: ${e}`);
      // Fallback: try the old command names
      try {
        if (approved) {
          await vscode.commands.executeCommand('kiroAgent.execution.runOrAcceptAll', executionId);
        } else {
          await vscode.commands.executeCommand('kiroAgent.execution.rejectAll', executionId);
        }
      } catch (e2) {
        log(`Fallback approval command also failed: ${e2}`);
      }
    }

    this.pendingQuestionIds.delete(questionId);
  }
}
