# Kiro Remote Control

Control your [Kiro IDE](https://kiro.dev) from your Android phone. View chat history across all your workspaces, approve or deny tool executions, and send messages to the Kiro agent — all from a mobile PWA that works over WiFi or anywhere via Cloudflare Tunnel.

---

## How It Works

Three components work together:

```
Kiro IDE ──── Extension ──── Relay Server ──── Mobile PWA (your phone)
                  │               │
            reads chat       WebSocket
            from disk          bridge
```

- **Extension** — reads Kiro's session files from disk, polls for pending approvals, and connects to the relay server via WebSocket.
- **Relay Server** — a local Node.js server bundled inside the extension. It bridges the IDE and your phone, serves the mobile PWA, and optionally exposes a public URL via Cloudflare Tunnel for remote access.
- **Mobile PWA** — a progressive web app opened on your phone by scanning a QR code. Works as an installable app (Add to Home Screen in Chrome).

---

## Quick Start

### 1. Start a Remote Session

Open the Command Palette (`Cmd+Shift+P`) and run:

```
Kiro Remote: Start Remote Session
```

The relay server starts, a QR code appears in the terminal, and a notification shows in the IDE.

### 2. Scan the QR Code

Open the QR code panel:

```
Kiro Remote: Show QR Code
```

Scan it with your Android phone using Chrome. The mobile app opens immediately.

### 3. Install Hooks (optional but recommended)

To get real-time tool call events and approval prompts from the hooks system:

```
Kiro Remote: Install Hooks into Workspace
```

This installs `.kiro/hooks/` scripts and a `hooks.json` config into your current workspace. Kiro will call these scripts before/after every tool use and on task start/complete.

### 4. Stop the Session

```
Kiro Remote: Stop Remote Session
```

---

## Mobile App Features

### 💬 Chat Tab
- Loads your full Kiro chat history from disk — all sessions, all workspaces.
- New messages appear live as Kiro responds (polls every 2 seconds, watches for file changes).
- Type a message and tap Send to submit it to the active Kiro session.

### 📋 Activity Tab
- Real-time feed of tool calls, task starts and completions, and approval decisions.
- Each entry shows a timestamp and tool name.

### ⚠️ Approval Modal
- Appears fullscreen when Kiro needs a yes/no on a tool execution.
- Shows the tool name, full command, and a countdown timer.
- Tap **Approve** or **Deny** — your response is sent back to Kiro immediately.
- Auto-denies if the timer expires (configurable timeout).

### Status Bar
- Shows connection state in the bottom-right status bar.
- Click it to open the QR code panel.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `kiroRemote.relayPort` | `3737` | Port for the local relay server |
| `kiroRemote.autoStart` | `false` | Start automatically when Kiro opens |
| `kiroRemote.approvalTimeoutSeconds` | `60` | Seconds before an unanswered approval auto-denies |

---

## Multiple Workspaces

The extension watches chat history for **all** your Kiro workspaces simultaneously — not just the one open in the current window. Sessions from every workspace appear in the Chat tab, grouped by session title.

---

## Remote Access (Away from WiFi)

When started, the extension automatically attempts to launch a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) to create a public HTTPS URL. No account or configuration needed.

If it fails, install cloudflared manually:

```bash
brew install cloudflared
```

Then restart the session. The tunnel URL appears in the terminal alongside the local URL.

> **Tip:** Run `caffeinate -i` in a separate terminal to prevent your Mac from sleeping during a remote session.

---

## Commands

| Command | Description |
|---|---|
| `Kiro Remote: Start Remote Session` | Start the relay server and connect |
| `Kiro Remote: Stop Remote Session` | Stop the relay server and disconnect |
| `Kiro Remote: Show QR Code` | Open the QR code in a side panel |
| `Kiro Remote: Install Hooks into Workspace` | Copy hook scripts into `.kiro/hooks/` |

---

## Troubleshooting

**"Relay server not found"** — The extension was not installed correctly. Uninstall and reinstall the `.vsix` file, then reload the window.

**Phone shows "Connecting…" and never connects** — Make sure your phone and Mac are on the same WiFi network. If using the tunnel URL, wait a few seconds for it to initialize.

**No chat history on phone** — Check that you have run at least one Kiro agent session. History is stored at `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/workspace-sessions/`. Open Kiro's Output panel (`Cmd+Shift+U`) and look for `[kiro-remote:chat]` log lines to see what the extension is reading.

**Approval modal doesn't appear** — Install the hooks first (`Kiro Remote: Install Hooks into Workspace`). The approval flow works through two paths: the hooks system (pre-tool-use.sh) and the internal execution API. At least one should fire.

**Sent message doesn't appear in Kiro** — The extension tries `kiroAgent.agent.askAgent` first, then `kiroAgent.executions.queueUserMessage`, then falls back to copying to clipboard and focusing the chat input. Check the Output panel for `[kiro-remote]` logs.

---

## Architecture Notes

Chat history is read from Kiro's on-disk session storage:

```
~/Library/Application Support/Kiro/User/
  globalStorage/kiro.kiroagent/workspace-sessions/
    <base64(workspacePath)>/
      sessions.json          ← list of sessions with titles
      <uuid>.json            ← full session: history[], title, workspacePath, …
```

Each session file contains a `history` array where each entry has a `message` with `role` (`user` or `assistant`) and `content` (string or array of text blocks). The extension reads these directly — no undocumented APIs, no Kiro internals beyond what's on disk.

---

## Privacy

All data stays local. The relay server runs on your Mac and only communicates with your phone. The Cloudflare Tunnel is point-to-point with no data stored by Cloudflare. No analytics, no telemetry.
