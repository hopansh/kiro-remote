import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { ApprovalWatcher } from './approvalWatcher';
import { StatusPoller } from './statusPoller';
import { ChatWatcher } from './chatWatcher';
import { KiroSessionManager } from './sessionManager';
import { StatusBarController } from './statusBar';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { randomUUID } from 'crypto';

let relayClient: RelayClient | null = null;
let approvalWatcher: ApprovalWatcher | null = null;
let statusPoller: StatusPoller | null = null;
let chatWatchers: ChatWatcher[] = [];
let kiroSessionManager: KiroSessionManager | null = null;
let statusBar: StatusBarController | null = null;
let relayProcess: cp.ChildProcess | null = null;
let output: vscode.OutputChannel | null = null;
let currentToken: string | null = null;

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  const line = `[${ts}] ${msg}`;
  output?.appendLine(line);
  console.log('[kiro-remote]', msg);
}

function genToken(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Returns a STABLE token persisted to a FILE in ~/.kiro-remote/token.
 * A file (not globalState) is used deliberately: globalState is wiped when the
 * extension is uninstalled/reinstalled, which happens on every dev build and
 * would invalidate the QR code on your phone. A file survives reinstalls, so
 * the same QR / installed PWA keeps working forever.
 */
function getPersistentToken(_context: vscode.ExtensionContext): string {
  const dir = path.join(os.homedir(), '.kiro-remote');
  const tokenFile = path.join(dir, 'token');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(tokenFile)) {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t) { log(`Reusing persistent token from file: ${t}`); return t; }
    }
  } catch (e) {
    log(`Could not read token file: ${e}`);
  }
  const token = genToken();
  try { fs.writeFileSync(tokenFile, token); } catch (e) { log(`Could not write token file: ${e}`); }
  log(`Generated new persistent token: ${token}`);
  return token;
}

function getLocalIP(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Kiro Remote');
  context.subscriptions.push(output);
  log('Extension activated');

  statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroRemote.start', () => void startSession(context)),
    vscode.commands.registerCommand('kiroRemote.stop', () => void stopSession()),
    vscode.commands.registerCommand('kiroRemote.showQR', () => void showQR(context)),
    vscode.commands.registerCommand('kiroRemote.installHooks', () => void installHooks(context)),
    vscode.commands.registerCommand('kiroRemote.showLogs', () => output?.show()),
    vscode.commands.registerCommand('kiroRemote.resetToken', async () => {
      await context.globalState.update('kiroRemote.sessionToken', undefined);
      try { fs.unlinkSync(path.join(os.homedir(), '.kiro-remote', 'token')); } catch { /* ignore */ }
      log('Session token reset — a new one will be generated on next start');
      const restart = await vscode.window.showInformationMessage(
        'Session token reset. Old QR codes will stop working. Restart the session to generate a new token.',
        'Restart Now'
      );
      if (restart === 'Restart Now') void startSession(context);
    }),
  );

  const config = vscode.workspace.getConfiguration('kiroRemote');
  if (config.get('autoStart')) {
    void startSession(context);
  }
}

async function startSession(context: vscode.ExtensionContext) {
  if (relayProcess) {
    log('Session already running; restarting…');
    await stopSession();
  }

  const config = vscode.workspace.getConfiguration('kiroRemote');
  const port = config.get<number>('relayPort', 3737);

  const serverPath = context.asAbsolutePath(path.join('server', 'dist', 'index.js'));
  if (!fs.existsSync(serverPath)) {
    vscode.window.showErrorMessage(
      `Relay server not found at ${serverPath}. Please reinstall the extension.`
    );
    log(`ERROR: server not found at ${serverPath}`);
    return;
  }

  // The EXTENSION owns the token (persisted to a file so it survives reinstalls).
  currentToken = getPersistentToken(context);
  const localIp = getLocalIP();

  // Check if a relay is ALREADY running on this port.
  // With multiple Kiro windows open, we must NOT kill each other's relay.
  // If a healthy relay with OUR token is already up, just reuse it.
  const existing = await probeServer(port);
  if (existing.alive && existing.token === currentToken) {
    log(`A relay with our token is already running on ${port} — reusing it (not spawning)`);
    // Don't own the process (another window started it); leave relayProcess null.
  } else {
    if (existing.alive) {
      log(`A relay with a DIFFERENT token (${existing.token}) is on ${port} — replacing it`);
      try { await killStaleServer(port); }
      catch (e) {
        log(`ERROR: ${e}`);
        vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e));
        return;
      }
    }

    log(`Starting relay on port ${port} with token ${currentToken}`);
    output?.show(true);

    relayProcess = cp.spawn(
      process.execPath,
      [serverPath],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PORT: String(port),
          KIRO_REMOTE_TOKEN: currentToken,
          KIRO_REMOTE_LOCAL_IP: localIp,
        },
        detached: false,
      }
    );

    relayProcess.stdout?.on('data', (d: Buffer) => log(`[relay] ${d.toString().trimEnd()}`));
    relayProcess.stderr?.on('data', (d: Buffer) => log(`[relay:err] ${d.toString().trimEnd()}`));
    relayProcess.on('error', (err) => {
      log(`[relay] spawn error: ${err.message}`);
      vscode.window.showErrorMessage(`Failed to start relay server: ${err.message}`);
    });
    relayProcess.on('exit', (code, signal) => {
      log(`[relay] exited code=${code} signal=${signal}`);
    });
  }

  // Wait for server to be ready AND verify the token matches (proves it's OUR server).
  try {
    await waitForServer(port, currentToken);
  } catch (e) {
    log(`ERROR: server did not become ready: ${e}`);
    vscode.window.showErrorMessage(
      `Relay server did not start on port ${port}. See "Kiro Remote" output for details.`
    );
    return;
  }
  log('Relay server is ready and token verified');

  // Connect extension WS client to relay
  const timeoutSeconds = config.get<number>('approvalTimeoutSeconds', 60);
  relayClient = new RelayClient(`ws://127.0.0.1:${port}/extension`);

  try {
    await relayClient.connect();
    log('Extension WebSocket connected to relay');
  } catch (e) {
    log(`ERROR: extension WS connect failed: ${e}`);
    vscode.window.showErrorMessage(`Failed to connect to relay server`);
    return;
  }

  // Send workspace info to the relay so it can forward to phone on connect
  const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
  relayClient.send({
    type: 'session_info',
    id: randomUUID(),
    timestamp: Date.now(),
    sessionId: randomUUID(),
    machineName: os.hostname(),
    workspaceName,
    connectedAt: Date.now(),
  });

  // Start polling for pending approvals
  approvalWatcher = new ApprovalWatcher(relayClient, timeoutSeconds);
  approvalWatcher.start();

  // Start broadcasting agent status to the phone
  statusPoller = new StatusPoller(relayClient);
  statusPoller.start();

  // Start session manager — sends full session list to phone on connect + every 10s
  kiroSessionManager = new KiroSessionManager(relayClient);
  kiroSessionManager.start();

  // When a phone connects, the relay asks us to refresh — resend sessions + history.
  relayClient.onRefreshRequest = () => {
    log('Relay requested refresh (phone connected) — resending session list + chat history');
    kiroSessionManager?.sendNow();
    chatWatchers.forEach(w => w.resendAll());
  };

  // When the phone opens a specific session, stream that session's full history.
  relayClient.onRequestSessionHistory = (sessionId: string, workspaceKey: string) => {
    log(`Phone opened session ${sessionId} — loading its history on demand`);
    if (relayClient) ChatWatcher.loadSessionHistory(relayClient, workspaceKey, sessionId);
  };

  // Start watching chat history for ALL known workspaces (using the ACTUAL
  // on-disk directory key — never re-encode the path).
  chatWatchers.forEach(w => w.stop());
  chatWatchers = [];

  const workspaceDirs = ChatWatcher.getAllWorkspaceDirs();
  log(`Found ${workspaceDirs.length} workspace(s) with chat history`);
  for (const { path: wsPath, key } of workspaceDirs) {
    const watcher = new ChatWatcher(relayClient, wsPath, key);
    watcher.start();
    chatWatchers.push(watcher);
  }

  statusBar?.setConnected(port);

  const localUrl = `http://${localIp}:${port}/?token=${currentToken}`;
  log(`Local URL: ${localUrl}`);

  const action = await vscode.window.showInformationMessage(
    `Kiro Remote started on ${localUrl}`,
    'Show QR',
    'Show Logs'
  );
  if (action === 'Show QR') {
    void showQR(context);
  } else if (action === 'Show Logs') {
    output?.show();
  }
}

/** Kill any process bound to the port and WAIT until the port is actually free. */
async function killStaleServer(port: number): Promise<void> {
  const isAlive = () => fetch(`http://127.0.0.1:${port}/health`).then(() => true).catch(() => false);

  if (!(await isAlive())) {
    log(`Port ${port} is free`);
    return;
  }

  log(`Port ${port} in use by a stale server — terminating`);

  // Kill everything on the port (may be several attempts).
  const killOnce = () => new Promise<void>((resolve) => {
    cp.exec(`lsof -ti tcp:${port}`, (_err, stdout) => {
      const pids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (pids.length === 0) { resolve(); return; }
      for (const pid of pids) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); log(`Killed stale pid ${pid}`); }
        catch (e) { log(`Could not kill pid ${pid}: ${e}`); }
      }
      resolve();
    });
  });

  // Retry kill + wait until the port stops responding (max ~6s).
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await killOnce();
    await new Promise(r => setTimeout(r, 400));
    if (!(await isAlive())) {
      log(`Port ${port} is now free`);
      return;
    }
  }

  log(`WARNING: could not free port ${port} after 6s — the old server may be owned by another process`);
  throw new Error(
    `Port ${port} is occupied by a server we cannot stop. ` +
    `Run "lsof -ti tcp:${port} | xargs kill -9" in a terminal, or change kiroRemote.relayPort in settings.`
  );
}

async function stopSession() {
  log('Stopping session…');
  statusPoller?.stop();
  statusPoller = null;
  kiroSessionManager?.stop();
  kiroSessionManager = null;
  approvalWatcher?.stop();
  approvalWatcher = null;
  chatWatchers.forEach(w => w.stop());
  chatWatchers = [];
  relayClient?.disconnect();
  relayClient = null;

  if (relayProcess) {
    const proc = relayProcess;
    relayProcess = null;
    proc.kill('SIGTERM');
    // Force-kill if it doesn't exit promptly (open WS connections block graceful close).
    const pid = proc.pid;
    setTimeout(() => {
      if (pid) {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); log(`Force-killed relay pid ${pid}`); }
        catch { /* already dead */ }
      }
    }, 1500);
  }

  currentToken = null;
  statusBar?.setDisconnected();
  vscode.window.showInformationMessage('Kiro Remote Control stopped.');
}

async function showQR(context: vscode.ExtensionContext) {
  const qrPath = path.join(
    process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~',
    '.kiro-remote',
    'qr.png'
  );

  if (!fs.existsSync(qrPath)) {
    vscode.window.showWarningMessage('No active session. Start one first.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'kiroRemoteQR',
    'Kiro Remote — Scan to Connect',
    vscode.ViewColumn.Beside,
    {
      enableScripts: false,
      localResourceRoots: [vscode.Uri.file(path.dirname(qrPath))],
    }
  );

  const qrUri = panel.webview.asWebviewUri(vscode.Uri.file(qrPath));
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kiro Remote</title>
</head>
<body style="background:#1a1a2e;display:flex;flex-direction:column;
             align-items:center;justify-content:center;height:100vh;
             font-family:monospace;color:#e0e0e0;margin:0;padding:20px;box-sizing:border-box;">
  <h2 style="margin-bottom:24px;text-align:center;">📱 Scan to connect your phone</h2>
  <img src="${qrUri}" alt="QR Code" style="width:300px;height:300px;border-radius:12px;" />
  <p style="margin-top:16px;opacity:0.6;text-align:center;">Opens in Android Chrome • Works as a PWA</p>
</body>
</html>`;
}

async function installHooks(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showWarningMessage('No workspace open.');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const hooksDir = path.join(workspaceRoot, '.kiro', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookSrcDir = context.asAbsolutePath('hooks');
  const hookFiles = [
    'pre-tool-use.sh',
    'post-tool-use.sh',
    'task-start.sh',
    'task-complete.sh',
  ];

  for (const file of hookFiles) {
    const src = path.join(hookSrcDir, file);
    const dest = path.join(hooksDir, file);
    if (!fs.existsSync(src)) {
      console.warn(`[kiro-remote] Hook script not found: ${src}`);
      continue;
    }
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, '755');
  }

  // Write the hooks.json config
  const hooksConfigPath = path.join(hooksDir, 'hooks.json');
  const hooksConfig = {
    hooks: [
      {
        name: 'remote-pre-tool',
        trigger: { type: 'preToolUse' },
        action: { type: 'shell', command: 'bash .kiro/hooks/pre-tool-use.sh' },
      },
      {
        name: 'remote-post-tool',
        trigger: { type: 'postToolUse' },
        action: { type: 'shell', command: 'bash .kiro/hooks/post-tool-use.sh' },
      },
      {
        name: 'remote-task-start',
        trigger: { type: 'specTaskStart' },
        action: { type: 'shell', command: 'bash .kiro/hooks/task-start.sh' },
      },
      {
        name: 'remote-task-complete',
        trigger: { type: 'specTaskComplete' },
        action: { type: 'shell', command: 'bash .kiro/hooks/task-complete.sh' },
      },
    ],
  };
  fs.writeFileSync(hooksConfigPath, JSON.stringify(hooksConfig, null, 2));

  vscode.window.showInformationMessage(
    `Kiro Remote hooks installed into ${hooksDir}`
  );
}

/** Probe the relay /health endpoint to learn if it's alive and what token it has. */
async function probeServer(port: number): Promise<{ alive: boolean; token: string | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return { alive: true, token: null };
    const data = await res.json() as { token?: string | null };
    return { alive: true, token: data.token ?? null };
  } catch {
    return { alive: false, token: null };
  }
}

/**
 * Wait until the relay server responds AND confirms it's running OUR token.
 * This guarantees we're talking to the server we just spawned, not a stale one.
 */
async function waitForServer(port: number, token: string, maxWaitMs = 12000): Promise<void> {
  const start = Date.now();
  let lastErr = 'timeout';
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/session/${token}`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status} (token not yet valid)`;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Relay not ready on port ${port}: ${lastErr}`);
}

export function deactivate() {
  void stopSession();
}
