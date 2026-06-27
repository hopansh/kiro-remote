import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { ApprovalRequestMessage } from './types';
import { randomUUID } from 'crypto';
import { agentState } from './agentState';
import { findNewestExecutionFile, readExecutionFile } from './executionFiles';

interface QuestionOption { id: string; label: string }
interface PendingQuestion {
  questionId: string;
  question: string;
  options?: QuestionOption[];
  executionId?: string;
}

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[kiro-remote:approval ${ts}] ${msg}`);
}

/**
 * Detects pending approvals / user questions and forwards them to the phone.
 *
 * Detection is driven primarily from the execution log on disk (an action with
 * actionState === "PendingAction" and unanswered output.questions[]), which is
 * reliable regardless of the kiroAgent command surface. We also consult
 * `kiroAgent.executions.getPendingQuestions()` (which only returns results when
 * the current execution is yielded) as a supplement.
 *
 * To answer, we call `kiroAgent.executions.acceptUserResponse` with
 * { questionId, response: { type: 'answered', answer } } — the exact shape Kiro
 * uses internally.
 */
export class ApprovalWatcher {
  private interval: NodeJS.Timeout | null = null;
  /** questionId -> timestamp first handled (dedup + time-based cleanup). */
  private handledQuestions = new Map<string, number>();
  private readonly pollMs = 800;
  private readonly retentionMs = 10 * 60 * 1000;

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
      const questions = await this.collectPendingQuestions();
      for (const q of questions) {
        if (this.handledQuestions.has(q.questionId)) continue;
        this.handledQuestions.set(q.questionId, Date.now());
        log(`Pending question ${q.questionId}: ${q.question.substring(0, 80)}`);
        void this.handleQuestion(q);
      }
      this.purgeOld();
    } catch (e) {
      log(`poll error: ${e}`);
    }
  }

  /** Union of command-based and file-based detection, deduped by questionId. */
  private async collectPendingQuestions(): Promise<PendingQuestion[]> {
    const byId = new Map<string, PendingQuestion>();

    // 1. Command (authoritative when the current execution is yielded).
    try {
      const cmd = await vscode.commands.executeCommand(
        'kiroAgent.executions.getPendingQuestions'
      ) as Array<{ id?: string; questionId?: string; question?: string; options?: unknown }> | undefined;
      if (Array.isArray(cmd)) {
        for (const q of cmd) {
          const id = q.questionId ?? q.id;
          if (!id) continue;
          byId.set(id, { questionId: id, question: q.question ?? 'Approve this action?', options: normalizeOptions(q.options) });
        }
      }
    } catch { /* command unavailable */ }

    // 2. File-based: scan the newest execution log for PendingAction questions.
    const newest = findNewestExecutionFile();
    if (newest) {
      const data = readExecutionFile(newest.path);
      const execId = data?.executionId;
      for (const action of data?.actions ?? []) {
        if ((action as { actionState?: string }).actionState !== 'PendingAction') continue;
        const out = (action as { output?: { questions?: Array<{ id: string; question?: string; options?: unknown; response?: unknown }> } }).output;
        if (action.actionType === 'userInput' && Array.isArray(out?.questions)) {
          for (const q of out!.questions!) {
            if (q.response) continue;             // already answered
            if (!q.id || byId.has(q.id)) continue;
            byId.set(q.id, {
              questionId: q.id,
              question: q.question ?? 'Approve this action?',
              options: normalizeOptions(q.options),
              executionId: execId,
            });
          }
        }
      }
    }

    return [...byId.values()];
  }

  private purgeOld() {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, ts] of this.handledQuestions) {
      if (ts < cutoff) this.handledQuestions.delete(id);
    }
  }

  private async handleQuestion(q: PendingQuestion) {
    const message: ApprovalRequestMessage = {
      type: 'approval_request',
      id: randomUUID(),
      timestamp: Date.now(),
      command: q.question,
      toolName: 'question',
      timeoutSeconds: this.timeoutSeconds,
      options: q.options,
    };

    agentState.addPendingApproval(q.questionId);
    log(`Sending question to phone: ${message.id}`);
    const result = await this.relay.sendApprovalRequest(message);
    agentState.removePendingApproval(q.questionId);
    log(`Phone responded: approved=${result.approved} answer=${result.answer ?? '(none)'}`);

    // Determine the answer string Kiro expects.
    let answer = result.answer;
    if (!answer) {
      if (q.options && q.options.length > 0) {
        answer = result.approved ? q.options[0].label : q.options[q.options.length - 1].label;
      } else {
        answer = result.approved ? 'Yes' : 'No';
      }
    }

    try {
      await vscode.commands.executeCommand('kiroAgent.executions.acceptUserResponse', {
        questionId: q.questionId,
        response: { type: 'answered', answer },
        executionId: q.executionId,
      });
      log(`acceptUserResponse sent: ${answer}`);
    } catch (e) {
      log(`acceptUserResponse failed: ${e}`);
    }

    // NOTE: keep questionId in handledQuestions so a slow file update doesn't
    // cause us to re-send the same question.
  }
}

/** Normalize Kiro's options (strings or {id,label}) into {id,label}[]. */
function normalizeOptions(raw: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((o, i) => {
    if (typeof o === 'string') return { id: `opt-${i}`, label: o };
    const obj = o as { id?: string; label?: string; title?: string };
    return { id: obj.id ?? `opt-${i}`, label: obj.label ?? obj.title ?? String(obj.id ?? i) };
  });
}
