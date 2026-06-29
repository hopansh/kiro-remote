import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { ApprovalWatcher } from './approvalWatcher';
import { StatusPoller } from './statusPoller';
import { ChatWatcher } from './chatWatcher';
import { KiroSessionManager } from './sessionManager';
import { ExecutionWatcher } from './executionWatcher';
import { StatusBarController } from './statusBar';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { randomUUID } from 'crypto';

let relayClient: RelayClient | null = null;
let approvalWatcher: ApprovalWatcher | null = null;
let statusPoller: StatusPoller | null = null;
let executionWatcher: ExecutionWatcher | null = null;
let chatWatchers: ChatWatcher[] = [];
let kiroSessionManager: KiroSessionManager | null = null;
let statusBar: StatusBarController | null = null;
let relayProcess: cp.ChildProcess | null = null;
let caffeinateProcess: cp.ChildProcess | null = null;
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
  const approvalTimeout = config.get<number>('approvalTimeoutSeconds', 60);
  const sessionTimeoutMin = config.get<number>('sessionTimeoutMinutes', 60);

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
  const buildId = getBuildId(context);

  // Check if a relay is ALREADY running on this port.
  // With multiple Kiro windows open, we must NOT kill each other's relay.
  // Reuse only if it has OUR token AND is the SAME build — otherwise it's a
  // stale relay (e.g. left over after an extension update) serving an old UI
  // and old server code, so we must replace it.
  const existing = await probeServer(port);
  if (existing.alive && existing.token === currentToken && existing.build === buildId) {
    log(`A relay with our token+build is already running on ${port} — reusing it (not spawning)`);
    // Don't own the process (another window started it); leave relayProcess null.
  } else {
    if (existing.alive) {
      const why = existing.token !== currentToken
        ? `different token (${existing.token})`
        : `different build (${existing.build} → ${buildId})`;
      log(`A relay with a ${why} is on ${port} — replacing it`);
      try { await killStaleServer(port); }
      catch (e) {
        log(`ERROR: ${e}`);
        vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e));
        return;
      }
    }

    log(`Starting relay on port ${port} with token ${currentToken} (build ${buildId})`);
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
          KIRO_REMOTE_APPROVAL_TIMEOUT: String(approvalTimeout),
          KIRO_REMOTE_SESSION_TIMEOUT: String(sessionTimeoutMin * 60),
          KIRO_REMOTE_BUILD: buildId,
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

  // Watch active execution file for real-time say actions (streaming responses)
  // and supervised-mode diff approvals
  executionWatcher = new ExecutionWatcher(relayClient);
  executionWatcher.start();

  // Start session manager — sends full session list to phone on connect + every 10s
  kiroSessionManager = new KiroSessionManager(relayClient);
  kiroSessionManager.start();

  // Automatically install/update hooks in the workspace on session start
  try {
    await installHooks(context);
    log('Hooks automatically installed/updated in workspace');
  } catch (e) {
    log(`Failed to automatically install hooks: ${e}`);
  }

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

  // Keep the Mac awake while the session is active so the relay stays reachable.
  startCaffeinate();

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

/** Keep macOS awake while the session runs (system + idle sleep). */
function startCaffeinate() {
  const config = vscode.workspace.getConfiguration('kiroRemote');
  if (!config.get<boolean>('preventSleep', true)) return;
  if (process.platform !== 'darwin') return; // caffeinate is macOS-only
  if (caffeinateProcess) return;             // already running
  try {
    // -i: prevent idle system sleep, -s: prevent system sleep (on AC),
    // -m: prevent disk idle sleep. The process lives for the whole session.
    caffeinateProcess = cp.spawn('caffeinate', ['-i', '-s', '-m'], { detached: false });
    caffeinateProcess.on('error', (err) => log(`caffeinate error: ${err.message}`));
    caffeinateProcess.on('exit', () => { caffeinateProcess = null; });
    log(`Sleep prevention ON (caffeinate pid ${caffeinateProcess.pid})`);
  } catch (e) {
    log(`Could not start caffeinate: ${e}`);
  }
}

/** Allow macOS to sleep again. */
function stopCaffeinate() {
  if (!caffeinateProcess) return;
  try { caffeinateProcess.kill(); log('Sleep prevention OFF'); }
  catch { /* already gone */ }
  caffeinateProcess = null;
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
  stopCaffeinate();
  statusPoller?.stop();
  statusPoller = null;
  executionWatcher?.stop();
  executionWatcher = null;
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

/** Build a webview URI for a QR PNG with a cache-busting query so the webview
 *  never shows a stale cached image when the file content changes per session. */
function withCacheBust(panel: vscode.WebviewPanel, filePath: string): vscode.Uri {
  let v = Date.now();
  try { v = Math.floor(fs.statSync(filePath).mtimeMs); } catch { /* use now */ }
  return panel.webview.asWebviewUri(vscode.Uri.file(filePath)).with({ query: `v=${v}` });
}

async function showQR(context: vscode.ExtensionContext) {
  const dir = path.join(os.homedir(), '.kiro-remote');

  if (!currentToken) {
    vscode.window.showWarningMessage('No active session. Start one first.');
    return;
  }

  const config = vscode.workspace.getConfiguration('kiroRemote');
  const port = config.get<number>('relayPort', 3737);

  // Read the LIVE state from the relay so the QR always matches what's actually
  // serving right now (token + current tunnel URL), independent of any PNG that
  // may be on disk from an earlier run.
  let tunnelUrl: string | null = null;
  let token = currentToken;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) {
      const data = await res.json() as { tunnelUrl?: string | null; token?: string | null };
      tunnelUrl = data.tunnelUrl ?? null;
      if (data.token) token = data.token;
    }
  } catch { /* relay not running */ }

  const localUrl = `http://${getLocalIP()}:${port}/?token=${token}`;

  // Generate the QR PNGs FRESH from the live URLs, into per-invocation unique
  // files. This is the only way to guarantee the displayed QR matches the live
  // URL — it removes any dependence on a stale PNG or the webview image cache.
  let qrcodeLib: { toFile: (p: string, text: string, opts: object) => Promise<void> };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    qrcodeLib = require(context.asAbsolutePath(path.join('server', 'node_modules', 'qrcode')));
  } catch (e) {
    log(`Could not load qrcode lib: ${e}`);
    vscode.window.showErrorMessage('Could not generate QR code (qrcode module missing).');
    return;
  }

  // Clean up QR files from previous invocations to avoid clutter.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^qr-(local|tunnel)-\d+\.png$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  const stamp = Date.now();
  const qrOpts = { type: 'png', width: 400, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } };
  const localQrPath = path.join(dir, `qr-local-${stamp}.png`);
  const tunnelQrPath = path.join(dir, `qr-tunnel-${stamp}.png`);

  try { await qrcodeLib.toFile(localQrPath, localUrl, qrOpts); }
  catch (e) { log(`local QR gen failed: ${e}`); }

  if (tunnelUrl) {
    try { await qrcodeLib.toFile(tunnelQrPath, tunnelUrl, qrOpts); }
    catch (e) { log(`tunnel QR gen failed: ${e}`); }
  }

  const panel = vscode.window.createWebviewPanel(
    'kiroRemoteQR',
    'Kiro Remote — Scan to Connect',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(dir)],
    }
  );

  const localQrUri = fs.existsSync(localQrPath) ? withCacheBust(panel, localQrPath) : null;
  const tunnelQrUri = (tunnelUrl && fs.existsSync(tunnelQrPath))
    ? withCacheBust(panel, tunnelQrPath)
    : null;

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kiro Remote</title>
  <style>
    body { background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:24px; display:flex; flex-direction:column; align-items:center; min-height:100vh; box-sizing:border-box; }
    h2 { margin-bottom:8px; font-size:18px; }
    p { color:#8b949e; font-size:13px; margin-bottom:20px; text-align:center; }
    .qr-section { background:#161b22; border:1px solid #30363d; border-radius:14px; padding:20px; margin:10px 0; width:100%; max-width:340px; display:flex; flex-direction:column; align-items:center; gap:12px; }
    .qr-label { font-size:11px; font-weight:700; letter-spacing:.7px; text-transform:uppercase; color:#8b949e; align-self:flex-start; }
    .qr-label.local { color:#3fb950; }
    .qr-label.tunnel { color:#58a6ff; }
    img { width:260px; height:260px; border-radius:8px; }
    .url { font-family:monospace; font-size:11px; color:#8b949e; word-break:break-all; text-align:center; background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:6px 10px; width:100%; }
    .spinner { color:#8b949e; font-size:13px; padding:20px; }
  </style>
</head>
<body>
  <h2>📱 Scan to connect your phone</h2>
  <p>Use the local QR on the same WiFi, or the tunnel QR from anywhere.</p>

  <div class="qr-section">
    <div class="qr-label local">📶 Local WiFi</div>
    ${localQrUri ? `<img src="${localQrUri}" alt="Local QR Code" />` : `<div class="spinner">Could not render QR</div>`}
    <div class="url">${localUrl}</div>
  </div>

  ${tunnelQrUri ? `
  <div class="qr-section">
    <div class="qr-label tunnel">🌐 Cloudflare Tunnel (any network)</div>
    <img src="${tunnelQrUri}" alt="Tunnel QR Code" />
    <div class="url">${tunnelUrl ?? 'Tunnel URL active — see QR'}</div>
  </div>` : `
  <div class="qr-section">
    <div class="qr-label tunnel">🌐 Cloudflare Tunnel</div>
    <div class="spinner">⏳ Starting tunnel… (run <code>brew install cloudflared</code> if this takes too long)</div>
  </div>`}
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

  // The hook scripts ship with the default port hardcoded. Inject the actually
  // configured port so hooks keep working when kiroRemote.relayPort is changed.
  const port = vscode.workspace.getConfiguration('kiroRemote').get<number>('relayPort', 3737);

  for (const file of hookFiles) {
    const src = path.join(hookSrcDir, file);
    const dest = path.join(hooksDir, file);
    if (!fs.existsSync(src)) {
      console.warn(`[kiro-remote] Hook script not found: ${src}`);
      continue;
    }
    const script = fs.readFileSync(src, 'utf8')
      .replace(/RELAY_URL="http:\/\/localhost:\d+"/, `RELAY_URL="http://localhost:${port}"`);
    fs.writeFileSync(dest, script);
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

/** Probe the relay /health endpoint to learn if it's alive and what token/build it has. */
async function probeServer(port: number): Promise<{ alive: boolean; token: string | null; build: string | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return { alive: true, token: null, build: null };
    const data = await res.json() as { token?: string | null; build?: string | null };
    return { alive: true, token: data.token ?? null, build: data.build ?? null };
  } catch {
    return { alive: false, token: null, build: null };
  }
}

/**
 * A build fingerprint for the bundled relay server. Derived from the bundle's
 * mtime so that a reinstalled/updated extension produces a different id and
 * therefore REPLACES any stale relay still running from the previous build.
 */
function getBuildId(context: vscode.ExtensionContext): string {
  try {
    const p = context.asAbsolutePath(path.join('server', 'dist', 'index.js'));
    return String(Math.floor(fs.statSync(p).mtimeMs));
  } catch {
    return '0';
  }
}

/**
 * Wait until the relay server responds AND confirms it's running OUR token.
 * This guarantees we're talking to the server we just spawned, not a stale one.
 *
 * Uses the loopback-only /health endpoint (NOT /session/:token): /session is
 * rate-limited to 30 req/min per IP, and polling it every 250ms for up to 12s
 * can trip that limiter and produce a false "server not ready" timeout even
 * though the server is up. /health is exempt from rate limiting for loopback.
 */
async function waitForServer(port: number, token: string, maxWaitMs = 12000): Promise<void> {
  const start = Date.now();
  let lastErr = 'timeout';
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const data = await res.json() as { token?: string | null };
        if (data.token === token) return;
        lastErr = `token mismatch (got ${data.token ?? 'null'})`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
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
