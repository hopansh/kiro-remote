/**
 * ExecutionWatcher — watches the active Kiro execution file in real-time
 * and streams `say` actions to the phone as they're emitted.
 *
 * This is how we get "streaming" responses: Kiro appends `say` actions to
 * the execution JSON file as the agent runs, each with an `emittedAt`
 * timestamp. We watch the file with fs.watch + polling, and forward any
 * new `say` actions we haven't sent yet.
 *
 * Additionally, this watcher detects supervised-mode diff reviews
 * (executions with pending file changes) and sends them to the phone
 * as a special `diff_review` approval request.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { KiroMessage } from './types';
import { randomUUID } from 'crypto';

const KIRO_AGENT_BASE = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent'
);
const EXEC_SUBDIR = '414d1636299d2b9e4ce7e17fb11f63e9';

function log(msg: string) {
  console.log(`[kiro-remote:execwatcher ${new Date().toISOString().substring(11, 23)}] ${msg}`);
}

interface SayAction {
  actionType: 'say';
  actionId: string;
  executionId: string;
  chatSessionId?: string;
  emittedAt: number;
  output: { message: string };
}

interface ExecutionFile {
  executionId: string;
  chatSessionId?: string;
  actions: Array<{ actionType: string; actionId?: string; emittedAt?: number; [k: string]: unknown }>;
}

export class ExecutionWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  /** emittedAt of the last say action we've already streamed */
  private lastStreamedAt = 0;
  private currentFile: string | null = null;
  private pendingDiffIds = new Set<string>();

  constructor(private readonly relay: RelayClient) {}

  start() {
    // Poll for the currently active execution file every 1.5s
    this.pollInterval = setInterval(() => this.checkActiveExecution(), 1500);
    log('ExecutionWatcher started');
  }

  stop() {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    log('ExecutionWatcher stopped');
  }

  private async checkActiveExecution() {
    try {
      // Get the currently running executions from Kiro
      const executions = await vscode.commands.executeCommand(
        'kiroAgent.executions.getExecutions'
      ) as Array<{ id?: string; executionId?: string; chatSessionId?: string; status?: string; state?: string }> | undefined;

      if (!executions || !Array.isArray(executions) || executions.length === 0) return;

      // Find active (running) execution
      const active = executions.find(e => {
        const s = (e.status ?? e.state ?? '').toLowerCase();
        return s.includes('run') || s.includes('active') || s.includes('progress');
      }) ?? executions[executions.length - 1];

      if (!active) return;

      const execId = active.executionId ?? active.id;
      if (!execId) return;

      // Find the execution file on disk
      const file = this.findExecutionFile(execId);
      if (!file) return;

      if (file !== this.currentFile) {
        log(`Watching new execution file: ${path.basename(file)} (${execId})`);
        this.currentFile = file;
        this.lastStreamedAt = 0;
        if (this.watcher) { this.watcher.close(); this.watcher = null; }
        try {
          this.watcher = fs.watch(file, () => this.streamNewSayActions(file));
        } catch { /* fs.watch not available for this file */ }
      }

      this.streamNewSayActions(file);
      this.checkForDiffReview(execId);
    } catch { /* kiroAgent API not available */ }
  }

  private findExecutionFile(executionId: string): string | null {
    let dirs: string[];
    try { dirs = fs.readdirSync(KIRO_AGENT_BASE); }
    catch { return null; }

    for (const hashDir of dirs) {
      const execDir = path.join(KIRO_AGENT_BASE, hashDir, EXEC_SUBDIR);
      if (!fs.existsSync(execDir)) continue;

      // Look for a file containing this executionId
      // Files are UUIDs — we scan them; they're small enough
      let files: string[];
      try { files = fs.readdirSync(execDir); }
      catch { continue; }

      for (const file of files) {
        const fpath = path.join(execDir, file);
        try {
          const raw = fs.readFileSync(fpath, 'utf8');
          if (raw.includes(executionId)) {
            const data = JSON.parse(raw) as ExecutionFile;
            if (data.executionId === executionId) return fpath;
          }
        } catch { /* skip */ }
      }
    }
    return null;
  }

  private streamNewSayActions(file: string) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionFile;
      const actions = data.actions ?? [];

      for (const action of actions) {
        if (action.actionType !== 'say') continue;
        const say = action as unknown as SayAction;
        const emittedAt = say.emittedAt ?? 0;
        if (emittedAt <= this.lastStreamedAt) continue;

        const text = say.output?.message?.trim();
        if (!text) continue;

        log(`Streaming say action emittedAt=${emittedAt}: "${text.substring(0, 60)}..."`);

        const msg: KiroMessage = {
          type: 'chat_message' as any,
          id: say.actionId ?? randomUUID(),
          timestamp: emittedAt,
          role: 'assistant',
          text,
          sessionId: data.chatSessionId ?? say.chatSessionId ?? '',
          sessionTitle: 'Kiro',
        } as any;

        this.relay.send(msg);
        this.lastStreamedAt = emittedAt;
      }
    } catch { /* file being written, retry on next tick */ }
  }

  private async checkForDiffReview(executionId: string) {
    if (this.pendingDiffIds.has(executionId)) return;

    try {
      // Check if this execution has pending changes awaiting approval (supervised mode)
      const changes = await vscode.commands.executeCommand(
        'kiroAgent.execution.getExecutionChanges', executionId
      ) as Array<{ filePath?: string; changeType?: string }> | undefined;

      if (!changes || changes.length === 0) return;

      // There are pending file changes — send a special approval request to phone
      this.pendingDiffIds.add(executionId);
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
      } as any;

      const approved = await this.relay.sendApprovalRequest(approvalMsg as any);

      if (approved) {
        await vscode.commands.executeCommand('kiroAgent.execution.runOrAcceptAll', executionId);
        log(`Approved ${changes.length} file changes`);
      } else {
        await vscode.commands.executeCommand('kiroAgent.execution.rejectAll', executionId);
        log(`Rejected ${changes.length} file changes`);
      }

      this.pendingDiffIds.delete(executionId);
    } catch { /* command not available — supervised mode may not be active */ }
  }
}
