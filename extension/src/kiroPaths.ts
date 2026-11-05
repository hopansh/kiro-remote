import * as os from 'os';
import * as path from 'path';

/** Return Kiro's VS Code-compatible user data directory for this platform. */
export function getKiroUserDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Kiro');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro');
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'Kiro');
}

export const KIRO_AGENT_BASE = path.join(
  getKiroUserDataDir(),
  'User', 'globalStorage', 'kiro.kiroagent'
);

export const KIRO_SESSIONS_BASE = path.join(KIRO_AGENT_BASE, 'workspace-sessions');
