import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), '.kiro-remote');
const LOG_FILE = path.join(LOG_DIR, 'relay.log');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // Truncate on each start so the log reflects the current session
  fs.writeFileSync(LOG_FILE, `=== Kiro Remote relay log — started ${new Date().toISOString()} ===\n`);
} catch {
  // ignore
}

export function rlog(scope: string, msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  const line = `[${ts}] [${scope}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // ignore
  }
}

export const RELAY_LOG_FILE = LOG_FILE;
