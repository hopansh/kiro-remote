/**
 * executionReader.ts
 *
 * Kiro stores the full agent response in execution log files, not in the
 * session history. The session history only has "On it." as the assistant
 * message. The real response is in:
 *
 *   ~/Library/Application Support/Kiro/User/globalStorage/
 *     kiro.kiroagent/<any-hash>/414d1636299d2b9e4ce7e17fb11f63e9/<file>
 *
 * Each file has { executionId, actions: [...] } where the last action
 * with actionType=="say" contains the actual text Kiro showed in the chat.
 *
 * We build an in-memory index: executionId → response text, by scanning
 * all execution log files once and caching the results.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const KIRO_AGENT_BASE = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent'
);
const EXEC_SUBDIR = '414d1636299d2b9e4ce7e17fb11f63e9';

// Cache: executionId -> response text
const cache = new Map<string, string>();
let indexed = false;

function log(msg: string) {
  console.log(`[kiro-remote:exec ${new Date().toISOString().substring(11, 23)}] ${msg}`);
}

/** Scan all execution log directories and build the executionId→response cache. */
export function buildExecutionCache() {
  if (indexed) return;
  indexed = true;

  let dirs: string[];
  try { dirs = fs.readdirSync(KIRO_AGENT_BASE); }
  catch { return; }

  let total = 0;
  for (const hashDir of dirs) {
    const execDir = path.join(KIRO_AGENT_BASE, hashDir, EXEC_SUBDIR);
    if (!fs.existsSync(execDir)) continue;

    let files: string[];
    try { files = fs.readdirSync(execDir); }
    catch { continue; }

    for (const file of files) {
      const fpath = path.join(execDir, file);
      if (!fs.statSync(fpath).isFile()) continue;
      try {
        const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
        const execId: string = data.executionId;
        if (!execId) continue;

        const response = extractSayResponse(data.actions);
        if (response) {
          cache.set(execId, response);
          total++;
        }
      } catch { /* ignore malformed files */ }
    }
  }
  log(`Indexed ${total} execution responses`);
}

/**
 * Get the real response text for a given executionId.
 * Returns undefined if not found (e.g. old session, aborted run).
 */
export function getExecutionResponse(executionId: string): string | undefined {
  if (!indexed) buildExecutionCache();
  return cache.get(executionId);
}

/** Extract the response from the actions array — last 'say' action wins. */
function extractSayResponse(actions: unknown[]): string | undefined {
  if (!Array.isArray(actions)) return undefined;
  let last: string | undefined;
  for (const action of actions) {
    const a = action as Record<string, unknown>;
    if (a['actionType'] === 'say') {
      const output = a['output'] as Record<string, unknown> | undefined;
      const msg = output?.['message'];
      if (typeof msg === 'string' && msg.trim()) {
        last = msg.trim();
      }
    }
  }
  return last;
}
