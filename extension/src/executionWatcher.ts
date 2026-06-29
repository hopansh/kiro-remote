/**
 * ExecutionWatcher — streams Kiro's live agent output to the phone in real time.
 *
 * Kiro persists each run to a JSON execution file and rewrites it (atomically,
 * via a ".<name>.tmp" + rename) as the agent works. While the model streams,
 * the `reasoning` (thinking) and `say` (response) actions are written with
 * `actionState: "Running"` and their `output.message` GROWS token by token.
 *
 * We poll the recently-modified execution files frequently and forward:
 *   - reasoning → a live "thinking" bubble  (id: reason-<executionId>)
 *   - say       → the assistant response    (id: exec-<executionId>)
 * Both are re-sent as their text grows; the phone updates the bubble in place.
 *
 * Detection is driven purely by file mtime (NOT kiroAgent.* commands, which
 * aren't always available). fs.watch is intentionally not used — it misses the
 * atomic-rename writes — fast polling is the reliable path.
 *
 * Also detects supervised-mode diff reviews and forwards them as approvals.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { KiroMessage } from './types';
import { randomUUID } from 'crypto';
import { agentState } from './agentState';
import { findRecentExecutionFiles, readExecutionFile } from './executionFiles';

function log(msg: string) {
  console.log(`[kiro-remote:execwatcher ${new Date().toISOString().substring(11, 23)}] ${msg}`);
}

export class ExecutionWatcher {
  private pollInterval: NodeJS.Timeout | null = null;
  /** message id -> last text streamed, so we re-send only on change. */
  private sentText = new Map<string, string>();
  /** file path -> last mtime we processed, to skip unchanged files. */
  private fileMtimes = new Map<string, number>();
  /** How recently a file must have been written to be considered "live". */
  private readonly liveWindowMs = 8000;
  private readonly pollMs = 300;

  private pendingDiffIds = new Set<string>();
  private resolvedDiffAt = new Map<string, number>();
  private readonly diffCooldownMs = 8000;

  private pendingActionIds = new Set<string>();
  private resolvedActionAt = new Map<string, number>();
  private readonly actionCooldownMs = 8000;

  constructor(private readonly relay: RelayClient) {}

  start() {
    this.pollInterval = setInterval(() => this.tick(), this.pollMs);
    this.tick();
    log('ExecutionWatcher started');
  }

  stop() {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    log('ExecutionWatcher stopped');
    this.cleanupCaches();
  }

  private tick() {
    const recent = findRecentExecutionFiles(this.liveWindowMs);
    for (const { path: file, mtimeMs } of recent) {
      // Skip files we've already processed at this mtime.
      if (this.fileMtimes.get(file) === mtimeMs) continue;
      this.fileMtimes.set(file, mtimeMs);
      this.streamFromFile(file);
    }
    // Bound the caches so they don't grow unbounded over a long session.
    if (this.fileMtimes.size > 200 || this.sentText.size > 400) this.cleanupCaches();
  }

  private cleanupCaches() {
    // Keep only files still within (a generous multiple of) the live window.
    const cutoff = Date.now() - this.liveWindowMs * 10;
    for (const [f, m] of this.fileMtimes) {
      if (m < cutoff) this.fileMtimes.delete(f);
    }
    if (this.sentText.size > 400) this.sentText.clear();
  }

  private streamFromFile(file: string) {
    const data = readExecutionFile(file);
    if (!data || !data.executionId) return;
    const actions = data.actions ?? [];
    const sessionId = data.chatSessionId ?? '';

    // ── Thinking: the most recent reasoning block, streamed as it grows ──
    let thinking: string | undefined;
    let thinkingAt = 0;
    // ── Response: concatenation of all `say` messages, in order ──
    const sayParts: string[] = [];
    let lastSayAt = 0;

    for (const a of actions) {
      const msg = a.output?.message?.trim();
      if (!msg) continue;
      if (a.actionType === 'reasoning') {
        thinking = msg;                         // last reasoning wins
        thinkingAt = a.emittedAt ?? thinkingAt;
      } else if (a.actionType === 'say') {
        sayParts.push(msg);
        lastSayAt = a.emittedAt ?? lastSayAt;
      }
    }

    const response = sayParts.join('\n\n').trim();

    // Send the response bubble (id matches ChatWatcher's `exec-<id>` so live +
    // history converge on one bubble).
    if (response) {
      const id = `exec-${data.executionId}`;
      if (this.sentText.get(id) !== response) {
        this.sentText.set(id, response);
        this.relay.send({
          type: 'chat_message',
          id,
          timestamp: lastSayAt || Date.now(),
          role: 'assistant',
          text: response,
          sessionId,
          sessionTitle: 'Kiro',
        } as KiroMessage);
      }
    }

    // Send the live "thinking" bubble. Only while there's no final response yet
    // OR while it keeps changing — it appears, streams, then the response shows.
    if (thinking) {
      const id = `reason-${data.executionId}`;
      if (this.sentText.get(id) !== thinking) {
        this.sentText.set(id, thinking);
        this.relay.send({
          type: 'chat_message',
          id,
          timestamp: thinkingAt || Date.now(),
          role: 'assistant',
          text: thinking,
          sessionId,
          sessionTitle: 'Kiro',
          thinking: true,
        } as KiroMessage);
      }
    }

    // Check for any pending tool actions (other than userInput, which is handled by ApprovalWatcher)
    const pendingActions = actions.filter(
      (a: any) => a.actionState === 'PendingAction' && a.actionType !== 'userInput'
    );
    for (const action of pendingActions) {
      if (action.actionId) {
        void this.handlePendingAction(data.executionId, action);
      }
    }

    void this.checkForDiffReview(data.executionId);
  }

  private async handlePendingAction(executionId: string, action: any) {
    const actionId = action.actionId;
    if (this.pendingActionIds.has(actionId)) return;

    const resolvedAt = this.resolvedActionAt.get(actionId);
    if (resolvedAt && Date.now() - resolvedAt < this.actionCooldownMs) return;

    this.pendingActionIds.add(actionId);
    agentState.addPendingApproval(`action:${actionId}`);
    log(`Pending action ${actionId} (${action.actionType}) in execution ${executionId}`);

    const desc = getActionDescription(action);

    const approvalMsg: KiroMessage = {
      type: 'approval_request',
      id: actionId, // Use actionId so the response can be matched
      timestamp: Date.now(),
      command: desc,
      toolName: action.actionType,
      context: `Kiro wants to run ${action.actionType}.`,
      timeoutSeconds: 60,
    } as KiroMessage;

    try {
      const approved = (await this.relay.sendApprovalRequest(approvalMsg as any)).approved;
      agentState.removePendingApproval(`action:${actionId}`);

      if (approved) {
        await vscode.commands.executeCommand('kiroAgent.execution.runOrAcceptAll', executionId);
        log(`Approved action ${actionId}`);
      } else {
        await vscode.commands.executeCommand('kiroAgent.execution.rejectAll', executionId);
        log(`Rejected action ${actionId}`);
      }
    } catch (e) {
      log(`Failed to handle pending action ${actionId}: ${e}`);
    } finally {
      this.resolvedActionAt.set(actionId, Date.now());
      this.pendingActionIds.delete(actionId);
    }
  }

  private async checkForDiffReview(executionId: string) {
    if (this.pendingDiffIds.has(executionId)) return;

    // Cooldown: after we resolve a diff review, Kiro may still report the
    // (now accepted/rejected) changes for a short window. Don't re-fire during
    // that window or the phone gets a duplicate diff approval.
    const resolvedAt = this.resolvedDiffAt.get(executionId);
    if (resolvedAt && Date.now() - resolvedAt < this.diffCooldownMs) return;

    try {
      const changes = await vscode.commands.executeCommand(
        'kiroAgent.execution.getExecutionChanges', executionId
      ) as Array<{ filePath?: string; changeType?: string }> | undefined;

      if (!changes || changes.length === 0) return;

      this.pendingDiffIds.add(executionId);
      agentState.addPendingApproval(`diff:${executionId}`);
      log(`Supervised mode: ${changes.length} pending file changes for execution ${executionId}`);

      const fileList = changes
        .slice(0, 10)
        .map(c => c.filePath ? path.basename(c.filePath) : 'file')
        .join(', ');

      const approvalMsg: KiroMessage = {
        type: 'approval_request',
        id: randomUUID(),
        timestamp: Date.now(),
        command: `Accept ${changes.length} file change${changes.length > 1 ? 's' : ''}: ${fileList}`,
        toolName: 'file_changes',
        context: `Supervised mode: Kiro wants to write ${changes.length} file${changes.length > 1 ? 's' : ''}. Review in Kiro IDE or approve here.`,
        timeoutSeconds: 120,
      } as KiroMessage;

      const approved = (await this.relay.sendApprovalRequest(approvalMsg as any)).approved;
      agentState.removePendingApproval(`diff:${executionId}`);

      if (approved) {
        await vscode.commands.executeCommand('kiroAgent.execution.runOrAcceptAll', executionId);
        log(`Approved ${changes.length} file changes`);
      } else {
        await vscode.commands.executeCommand('kiroAgent.execution.rejectAll', executionId);
        log(`Rejected ${changes.length} file changes`);
      }

      this.resolvedDiffAt.set(executionId, Date.now());
      this.pendingDiffIds.delete(executionId);
    } catch { /* command not available — supervised mode may not be active */ }
  }
}

function getActionDescription(action: any): string {
  if (action.actionType === 'shell') {
    return action.input?.command || JSON.stringify(action.input);
  }
  if (action.actionType === 'write' || action.actionType === 'replace' || action.actionType === 'create') {
    const file = action.input?.file || action.input?.path || '';
    return `Write/modify ${path.basename(file)}`;
  }
  return JSON.stringify(action.input || {});
}
