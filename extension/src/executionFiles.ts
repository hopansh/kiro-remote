/**
 * Shared helpers for locating Kiro's on-disk execution log files.
 *
 * Kiro writes each agent run to:
 *   ~/Library/Application Support/Kiro/User/globalStorage/
 *     kiro.kiroagent/<hash>/414d1636299d2b9e4ce7e17fb11f63e9/<uuid>
 *
 * The file Kiro is actively writing is the one with the newest mtime. Detecting
 * activity from mtime (rather than from the kiroAgent.* commands, which aren't
 * always available) is what makes streaming + status detection reliable.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const KIRO_AGENT_BASE = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent'
);
export const EXEC_SUBDIR = '414d1636299d2b9e4ce7e17fb11f63e9';

export interface NewestExecution {
  path: string;
  mtimeMs: number;
}

/** Find the execution file with the newest mtime across all execution dirs. */
export function findNewestExecutionFile(): NewestExecution | null {
  let dirs: string[];
  try { dirs = fs.readdirSync(KIRO_AGENT_BASE); }
  catch { return null; }

  let newestFile: string | null = null;
  let newestMtime = 0;

  for (const hashDir of dirs) {
    const execDir = path.join(KIRO_AGENT_BASE, hashDir, EXEC_SUBDIR);
    let files: string[];
    try { files = fs.readdirSync(execDir); }
    catch { continue; }

    for (const file of files) {
      // Kiro writes atomically as ".<name>.tmp" then renames. Skip temp/hidden
      // files — locking onto a half-written temp file breaks streaming.
      if (file.startsWith('.')) continue;
      const fpath = path.join(execDir, file);
      try {
        const stat = fs.statSync(fpath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fpath;
        }
      } catch { /* skip */ }
    }
  }

  if (!newestFile) return null;
  return { path: newestFile, mtimeMs: newestMtime };
}

/** Find all execution files modified within `maxAgeMs` (newest first). */
export function findRecentExecutionFiles(maxAgeMs: number): NewestExecution[] {
  let dirs: string[];
  try { dirs = fs.readdirSync(KIRO_AGENT_BASE); }
  catch { return []; }

  const cutoff = Date.now() - maxAgeMs;
  const out: NewestExecution[] = [];

  for (const hashDir of dirs) {
    const execDir = path.join(KIRO_AGENT_BASE, hashDir, EXEC_SUBDIR);
    let files: string[];
    try { files = fs.readdirSync(execDir); }
    catch { continue; }

    for (const file of files) {
      if (file.startsWith('.')) continue; // skip ".<name>.tmp" atomic writes
      const fpath = path.join(execDir, file);
      try {
        const stat = fs.statSync(fpath);
        if (stat.isFile() && stat.mtimeMs >= cutoff) {
          out.push({ path: fpath, mtimeMs: stat.mtimeMs });
        }
      } catch { /* skip */ }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export interface ParsedExecution {
  executionId?: string;
  chatSessionId?: string;
  actions?: Array<{ actionType?: string; actionState?: string; emittedAt?: number; output?: { message?: string }; [k: string]: unknown }>;
}

export function readExecutionFile(file: string): ParsedExecution | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ParsedExecution;
  } catch {
    return null;
  }
}
