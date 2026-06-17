import * as vscode from 'vscode';

export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 100
    );
    this.item.command = 'kiroRemote.showQR';
    this.setDisconnected();
    this.item.show();
  }

  setConnected(port: number) {
    this.item.text = '$(broadcast) Kiro Remote';
    this.item.tooltip = `Remote Control active on :${port} — click for QR`;
    this.item.backgroundColor = undefined;
  }

  setDisconnected() {
    this.item.text = '$(circle-slash) Kiro Remote';
    this.item.tooltip = 'Remote Control inactive — click to start';
    this.item.backgroundColor = undefined;
  }

  dispose() {
    this.item.dispose();
  }
}
