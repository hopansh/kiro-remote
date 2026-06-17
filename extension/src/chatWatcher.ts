/**
 * ChatWatcher — reads Kiro's on-disk session files and streams
 * chat history + live updates to the phone via the relay.
 *
 * Storage layout:
 *   ~/Library/Application Support/Kiro/User/globalStorage/
 *     kiro.kiroagent/workspace-sessions/<base64(workspacePath)>/
 *       sessions.json          ← list of sessions
 *       <uuid>.json            ← full session data incl. history[]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RelayClient } from './relayClient';
import { randomUUID } from 'crypto';
import { getExecutionResponse, buildExecutionCache } from './executionReader';

const KIRO_SESSIONS_BASE = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent', 'workspace-sessions'
);

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp?: number;
  sessionId: string;
  sessionTitle: string;
}

export class ChatWatcher {
  private watchers: fs.FSWatcher[] = [];
  private sentMessageIds = new Set<string>();
  private workspacePath: string;
  private workspaceKey: string;
  private sessionsDir: string;
  private pollInterval: NodeJS.Timeout | null = null;

  /**
   * @param workspaceKey the ACTUAL on-disk directory name (from getAllWorkspaceDirs).
   *   We never re-encode the path ourselves — Kiro uses a non-standard base64
   *   variant, so re-encoding produces the wrong directory.
   */
  constructor(
    private readonly relay: RelayClient,
    workspacePath: string,
    workspaceKey: string
  ) {
    this.workspacePath = workspacePath;
    this.workspaceKey = workspaceKey;
    this.sessionsDir = path.join(KIRO_SESSIONS_BASE, this.workspaceKey);
    log(`ChatWatcher init: ${workspacePath} (dir=${workspaceKey})`);
  }

  start() {
    if (!fs.existsSync(this.sessionsDir)) {
      log(`Sessions dir not found: ${this.sessionsDir}`);
      log(`Available workspace keys:`);
      try {
        const dirs = fs.readdirSync(KIRO_SESSIONS_BASE);
        dirs.forEach(d => {
          try {
            const decoded = Buffer.from(d, 'base64').toString('utf8');
            log(`  ${d} => ${decoded}`);
          } catch { log(`  ${d} => (decode failed)`); }
        });
      } catch (e) { log(`Cannot list sessions base: ${e}`); }
      return;
    }

    // Load existing history immediately
    this.loadAllHistory();

    // Watch for file changes (new messages streaming in)
    this.watchDirectory();

    // Also poll every 2s as a fallback (fs.watch can miss rapid writes)
    this.pollInterval = setInterval(() => this.loadAllHistory(), 2000);
  }

  stop() {
    this.watchers.forEach(w => w.close());
    this.watchers = [];
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
  }

  /** Re-send all chat history (clears dedupe set). Used when a new phone connects. */
  resendAll() {
    this.sentMessageIds.clear();
    this.loadAllHistory();
  }

  /**
   * Load a SPECIFIC session's full history on demand (any session, not just recent),
   * and stream its messages to the phone. Uses the actual directory key (no re-encode).
   */
  static loadSessionHistory(relay: RelayClient, workspaceKey: string, sessionId: string) {
    const file = path.join(KIRO_SESSIONS_BASE, workspaceKey, `${sessionId}.json`);
    log(`On-demand history for session ${sessionId} (dir=${workspaceKey})`);
    if (!fs.existsSync(file)) { log(`  session file not found: ${file}`); return; }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const title: string = raw.title ?? 'Chat';
      const history: unknown[] = raw.history ?? [];
      const baseTs: number = typeof raw.dateCreated === 'string'
        ? parseInt(raw.dateCreated, 10)
        : (raw.dateCreated as number) ?? 0;
      log(`  streaming ${history.length} messages`);
      buildExecutionCache();
      let idx = 0;
      for (const entry of history) {
        const e = entry as Record<string, unknown>;
        const msg = e['message'] as Record<string, unknown> | undefined;
        if (!msg) continue;
        const role = (msg['role'] as string) ?? 'user';

        let text: string;
        if (role === 'assistant') {
          const execId = e['executionId'] as string | undefined;
          const realResponse = execId ? getExecutionResponse(execId) : undefined;
          text = realResponse ?? extractTextStatic(msg['content']);
        } else {
          text = extractTextStatic(msg['content']);
        }
        if (!text.trim()) continue;

        relay.sendChatMessage({
          id: (msg['id'] as string) ?? `${sessionId}-${idx}`,
          role: role as 'user' | 'assistant',
          text,
          timestamp: baseTs + idx,
          sessionId,
          sessionTitle: title,
        });
        idx++;
      }
    } catch (err) { log(`  error: ${err}`); }
  }

  private watchDirectory() {
    try {
      const watcher = fs.watch(this.sessionsDir, (event, filename) => {
        if (filename && filename.endsWith('.json') && filename !== 'sessions.json') {
          log(`File changed: ${filename} (${event})`);
          setTimeout(() => this.loadSessionFile(path.join(this.sessionsDir, filename)), 200);
        }
      });
      this.watchers.push(watcher);
      log(`Watching: ${this.sessionsDir}`);
    } catch (e) { log(`Watch failed: ${e}`); }
  }

  private loadAllHistory() {
    try {
      // Build execution cache on first use so we can resolve real responses
      buildExecutionCache();

      const sessionListPath = path.join(this.sessionsDir, 'sessions.json');
      if (!fs.existsSync(sessionListPath)) return;

      const sessions: Array<{ sessionId: string; title: string }> =
        JSON.parse(fs.readFileSync(sessionListPath, 'utf8'));

      log(`Found ${sessions.length} sessions for workspace`);

      // Load most recent 3 sessions (avoid flooding phone with old history)
      const recent = sessions.slice(-3);
      for (const s of recent) {
        const filePath = path.join(this.sessionsDir, `${s.sessionId}.json`);
        this.loadSessionFile(filePath);
      }
    } catch (e) { log(`loadAllHistory error: ${e}`); }
  }

  private loadSessionFile(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const sessionId: string = raw.sessionId ?? path.basename(filePath, '.json');
      const sessionTitle: string = raw.title ?? 'Chat';
      const history: unknown[] = raw.history ?? [];

      log(`Session ${sessionId} ("${sessionTitle}"): ${history.length} messages`);

      for (const entry of history) {
        const e = entry as Record<string, unknown>;
        const msg = e['message'] as Record<string, unknown> | undefined;
        if (!msg) continue;

        const role = (msg['role'] as string) ?? 'user';
        // Use the message's own id as the dedup key — it's unique per message.
        const msgId: string = (msg['id'] as string) ?? `${sessionId}-${role}-${JSON.stringify(msg).length}`;

        if (this.sentMessageIds.has(msgId)) continue;
        this.sentMessageIds.add(msgId);

        // For assistant messages: look up the real response from the execution log.
        // The session only stores "On it." as the initial acknowledgment;
        // the actual response is in the execution file.
        let text: string;
        if (role === 'assistant') {
          const execId = e['executionId'] as string | undefined;
          const realResponse = execId ? getExecutionResponse(execId) : undefined;
          text = realResponse ?? extractTextStatic(msg['content']);
        } else {
          text = extractTextStatic(msg['content']);
        }
        if (!text.trim()) continue;

        const chatMsg: ChatMessage = {
          id: msgId,
          role: role as 'user' | 'assistant',
          text,
          timestamp: (typeof raw.dateCreated === 'string'
            ? parseInt(raw.dateCreated, 10)
            : (raw.dateCreated as number) ?? 0) + history.indexOf(entry),
          sessionId,
          sessionTitle,
        };

        this.relay.sendChatMessage(chatMsg);
      }
    } catch (e) { log(`loadSessionFile error for ${filePath}: ${e}`); }
  }

  /** Returns base64 workspace key for all open workspaces */
  static getAllWorkspaceDirs(): Array<{ path: string; key: string }> {
    const result: Array<{ path: string; key: string }> = [];
    try {
      const dirs = fs.readdirSync(KIRO_SESSIONS_BASE);
      for (const d of dirs) {
        try {
          result.push({ path: decodeWorkspaceKey(d), key: d });
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist yet */ }
    return result;
  }
}

/** Kiro encodes workspace dirs as base64 with trailing '=' padding replaced by '_'. */
export function decodeWorkspaceKey(dir: string): string {
  return Buffer.from(dir.replace(/_+$/, ''), 'base64').toString('utf8');
}

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[kiro-remote:chat ${ts}] ${msg}`);
}

export function extractTextStatic(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const item = c as Record<string, unknown>;
        return item['type'] === 'text' ? String(item['text'] ?? '') : '';
      })
      .join('\n')
      .trim();
  }
  return String(content ?? '');
}
