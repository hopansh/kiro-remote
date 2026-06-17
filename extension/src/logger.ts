import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Kiro Remote');
  }
  return channel;
}

export function log(scope: string, msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  const line = `[${ts}] [${scope}] ${msg}`;
  if (channel) {
    channel.appendLine(line);
  }
  console.log(`[kiro-remote:${scope}] ${msg}`);
}

export function show() {
  channel?.show(true);
}

export function disposeLogger() {
  channel?.dispose();
  channel = null;
}
