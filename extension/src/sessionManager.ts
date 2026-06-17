/**
 * SessionManager — reads all Kiro chat sessions from disk and sends
 * a session_list message to the phone, refreshed periodically.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RelayClient } from './relayClient';
import { KiroSession } from './types';
import { decodeWorkspaceKey } from './chatWatcher';
import { randomUUID } from 'crypto';

const KIRO_SESSIONS_BASE = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent', 'workspace-sessions'
);

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[kiro-remote:sessions ${ts}] ${msg}`);
}

export class KiroSessionManager {
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly relay: RelayClient) {}

  start() {
    void this.sendSessionList();
    // Refresh every 10s so newly created sessions appear promptly
    this.interval = setInterval(() => void this.sendSessionList(), 10000);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** Call this immediately when a new phone connects. */
  sendNow() {
    void this.sendSessionList();
  }

  private async sendSessionList() {
    const sessions = this.readAllSessions();
    log(`Sending ${sessions.length} sessions to phone`);
    this.relay.send({
      type: 'session_list',
      id: randomUUID(),
      timestamp: Date.now(),
      sessions,
    } as any);
  }

  private readAllSessions(): KiroSession[] {
    const results: KiroSession[] = [];
    if (!fs.existsSync(KIRO_SESSIONS_BASE)) return results;

    let dirs: string[];
    try { dirs = fs.readdirSync(KIRO_SESSIONS_BASE); }
    catch { return results; }

    for (const dir of dirs) {
      let workspacePath: string;
      try { workspacePath = decodeWorkspaceKey(dir); }
      catch { continue; }

      const workspaceName = path.basename(workspacePath);
      const sessionsFile = path.join(KIRO_SESSIONS_BASE, dir, 'sessions.json');
      if (!fs.existsSync(sessionsFile)) continue;

      let sessionList: Array<{ sessionId: string; title: string; dateCreated?: string }>;
      try { sessionList = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); }
      catch { continue; }

      for (const s of sessionList) {
        const sessionFile = path.join(KIRO_SESSIONS_BASE, dir, `${s.sessionId}.json`);
        let messageCount = 0;
        let lastMessage: string | undefined;

        if (fs.existsSync(sessionFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            const history: unknown[] = data.history ?? [];
            messageCount = history.length;
            // Get the last non-empty assistant message as preview
            for (let i = history.length - 1; i >= 0; i--) {
              const entry = history[i] as Record<string, unknown>;
              const msg = entry['message'] as Record<string, unknown> | undefined;
              if (!msg) continue;
              const text = extractText(msg['content']);
              if (text.trim()) {
                lastMessage = text.substring(0, 100);
                break;
              }
            }
          } catch { /* skip */ }
        }

        results.push({
          sessionId: s.sessionId,
          title: s.title || 'Chat',
          workspacePath,
          workspaceName,
          workspaceKey: dir,
          dateCreated: s.dateCreated ? parseInt(s.dateCreated, 10) : 0,
          messageCount,
          lastMessage,
        });
      }
    }

    // Sort newest first
    results.sort((a, b) => b.dateCreated - a.dateCreated);
    return results;
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const item = c as Record<string, unknown>;
        return item['type'] === 'text' ? String(item['text'] ?? '') : '';
      })
      .join(' ')
      .trim();
  }
  return '';
}
