import * as vscode from 'vscode';
import { RelayClient } from './relayClient';
import { ApprovalWatcher } from './approvalWatcher';
import { StatusPoller } from './statusPoller';
import { StatusBarController } from './statusBar';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { randomUUID } from 'crypto';

let relayClient: RelayClient | null = null;
let approvalWatcher: ApprovalWatcher | null = null;
let statusPoller: StatusPoller | null = null;
let statusBar: StatusBarController | null = null;
let relayProcess: cp.ChildProcess | null = null;

export function activate(context: vscode.ExtensionContext) {
  statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroRemote.start', () => void startSession(context)),
    vscode.commands.registerCommand('kiroRemote.stop', () => void stopSession()),
    vscode.commands.registerCommand('kiroRemote.showQR', () => void showQR(context)),
    vscode.commands.registerCommand('kiroRemote.installHooks', () => void installHooks(context)),
  );

  const config = vscode.workspace.getConfiguration('kiroRemote');
  if (config.get('autoStart')) {
    void startSession(context);
  }
}

async function startSession(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('kiroRemote');
  const port = config.get<number>('relayPort', 3737);

  // Start relay server as a child process
  const serverPath = context.asAbsolutePath(
    path.join('server', 'dist', 'index.js')
  );

  if (!fs.existsSync(serverPath)) {
    vscode.window.showErrorMessage(
      `Relay server not found at ${serverPath}. Please reinstall the extension.`
    );
    return;
  }

  relayProcess = cp.spawn(process.execPath, [serverPath, '--port', String(port)], {
    env: { ...process.env },
    detached: false,
  });

  relayProcess.stdout?.on('data', (d: Buffer) => {
    console.log('[relay]', d.toString().trim());
  });
  relayProcess.stderr?.on('data', (d: Buffer) => {
    console.error('[relay]', d.toString().trim());
  });

  relayProcess.on('error', (err) => {
    console.error('[relay] Failed to start:', err.message);
    vscode.window.showErrorMessage(`Failed to start relay server: ${err.message}`);
  });

  // Wait for server to be ready
  try {
    await waitForPort(port);
  } catch {
    vscode.window.showErrorMessage(`Relay server did not start on port ${port}`);
    return;
  }

  // Connect extension WS client to relay
  const timeoutSeconds = config.get<number>('approvalTimeoutSeconds', 60);
  relayClient = new RelayClient(`ws://localhost:${port}/extension`);

  try {
    await relayClient.connect();
  } catch {
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

  statusBar?.setConnected(port);

  const action = await vscode.window.showInformationMessage(
    'Kiro Remote Control started. Scan the QR code in the terminal.',
    'Show QR'
  );
  if (action === 'Show QR') {
    void showQR(context);
  }
}

async function stopSession() {
  statusPoller?.stop();
  statusPoller = null;
  approvalWatcher?.stop();
  approvalWatcher = null;
  relayClient?.disconnect();
  relayClient = null;
  relayProcess?.kill();
  relayProcess = null;
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

async function waitForPort(port: number, maxWaitMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await fetch(`http://localhost:${port}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Relay server did not start on port ${port}`);
}

export function deactivate() {
  void stopSession();
}
