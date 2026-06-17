# Kiro Remote Control

Control your [Kiro IDE](https://kiro.dev) from your phone. View chat history across all
your workspaces, approve or deny tool executions, send messages, and get real-time streaming
responses — all from a mobile PWA that works over WiFi or anywhere via Cloudflare Tunnel.

---

## How It Works

Three components work together:

```
Kiro IDE ──── Extension ──── Relay Server ──── Mobile PWA (your phone)
                  │               │
            reads chat       WebSocket
            from disk          bridge
```

- **Extension** — reads Kiro's session files from disk, streams responses in real-time, polls for pending approvals, and connects to the relay server via WebSocket.
- **Relay Server** — a local Node.js server bundled inside the extension. It bridges the IDE and your phone, serves the mobile PWA, and optionally exposes a public HTTPS URL via Cloudflare Tunnel.
- **Mobile PWA** — a progressive web app opened on your phone by scanning a QR code. Works as an installable app (Add to Home Screen in Chrome).

---

## Quick Start

### 1. Start a Remote Session

```
Cmd+Shift+P → Kiro Remote: Start Remote Session
```

The relay server starts and a notification appears in the IDE.

### 2. Scan the QR Code

```
Cmd+Shift+P → Kiro Remote: Show QR Code
```

Two QR codes appear side by side:
- 📶 **Local WiFi** — use when your phone and Mac are on the same network
- 🌐 **Cloudflare Tunnel** — use from any network, no account needed (starts within ~10s)

Scan with your phone's camera. The mobile app opens immediately.

### 3. Install Hooks (optional but recommended)

```
Cmd+Shift+P → Kiro Remote: Install Hooks into Workspace
```

Installs `.kiro/hooks/` scripts that give you real-time tool approval prompts and
task notifications on your phone. The hooks authenticate to the relay automatically
using your session token — **re-run this command after every extension update**.

### 4. Stop the Session

```
Cmd+Shift+P → Kiro Remote: Stop Remote Session
```

---

## Mobile App

### 💬 Chat Tab
- Browse all Kiro chat sessions across every workspace, sorted by most recently active
- Messages stream in real-time as Kiro responds (each partial response appears immediately)
- Typing indicator shows while Kiro is working
- Tap any session in the 🗂 Sessions tab to open it; your message goes to that specific session
- Multi-line input: Enter sends, Shift+Enter inserts a newline

### 🗂 Sessions Tab
- Lists all sessions across all workspaces, newest interaction first
- Search by session title, workspace name, or message content
- Tap any session to view its full history and continue the conversation

### ⚠️ Approval Modal
- Appears fullscreen when Kiro needs a yes/no on a tool execution or file write
- Shows the tool name, full command/input, and a countdown timer
- **Approve** / **Deny** — your response goes back to Kiro immediately
- Auto-denies when the timer expires (configurable)
- Also handles supervised mode: when Kiro has pending file changes, you can **Accept Changes** or **Reject Changes** from your phone

### Status Bar
- Shows connection state in the bottom-right corner of Kiro
- Click to open the QR code panel

---

## Security

The relay is designed to be safe to expose publicly via the Cloudflare Tunnel:

| What | How |
|---|---|
| Mobile WebSocket | Requires `?token=TOKEN` in the URL; constant-time comparison; rate-limited (30/min per IP) |
| Hook endpoints | Require `Authorization: Bearer TOKEN` header |
| Extension WebSocket | Only accepts connections from `127.0.0.1` — never reachable from outside |
| `/health` endpoint | Returns the session token only to loopback addresses; remote callers get `403` |
| CORS | Allowed origins: localhost, local network ranges, `*.trycloudflare.com` (HTTPS only) |
| Message size | 1 MB limit for extension messages, 64 KB for mobile messages |

The session token is stored in `~/.kiro-remote/token` and persists across restarts —
scan once and the same QR code keeps working. Use **Reset Session Token** to rotate it.

---

## Commands

| Command | Description |
|---|---|
| `Kiro Remote: Start Remote Session` | Start the relay server and connect |
| `Kiro Remote: Stop Remote Session` | Stop the relay server and disconnect |
| `Kiro Remote: Show QR Code` | Show local + tunnel QR codes side by side |
| `Kiro Remote: Install Hooks into Workspace` | Copy authenticated hook scripts into `.kiro/hooks/` |
| `Kiro Remote: Show Logs` | Open the "Kiro Remote" output channel |
| `Kiro Remote: Reset Session Token` | Rotate the token; invalidates all existing QR codes |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `kiroRemote.relayPort` | `3737` | Port for the local relay server |
| `kiroRemote.autoStart` | `false` | Start automatically when Kiro opens |
| `kiroRemote.approvalTimeoutSeconds` | `60` | Seconds before an unanswered approval auto-denies |

---

## Troubleshooting

**"Relay server not found"** — Reinstall the `.vsix` and reload the window.

**Phone shows "Connecting…" permanently** — Check that you're using the right QR:
local WiFi QR for same-network, tunnel QR from elsewhere. The tunnel takes ~10s to initialize.

**"Session Expired" screen on phone** — The token changed (you reset it or reinstalled
the extension). Close the old tab/PWA, re-scan the new QR from **Show QR Code**.

**Approval modal appears but Approve/Deny does nothing** — Open the debug log
(tap the status dot 3× on your phone) and check for errors. Make sure you're on
the latest version of the extension.

**No chat history** — Make sure you've run at least one Kiro agent session. Check
the "Kiro Remote" output panel (`Cmd+Shift+U`) for `[kiro-remote:chat]` log lines.

**Hook approvals not working** — Run **Install Hooks into Workspace** again after
updating the extension. The hooks need the updated authentication logic.

**Tunnel not starting** — Install cloudflared via `brew install cloudflared`,
then restart the session.

---

## Architecture Notes

### Chat history (disk-based)

```
~/Library/Application Support/Kiro/User/
  globalStorage/kiro.kiroagent/workspace-sessions/
    <base64(workspacePath)>/
      sessions.json       ← session list (id, title, dateCreated)
      <uuid>.json         ← session data: history[], title, workspacePath…
```

### Real-time response streaming

Kiro writes `say` actions to execution files as the agent runs — one per partial response,
each with an `emittedAt` timestamp. The extension watches these files and streams each new
`say` action to your phone as soon as it's written, so you see responses incrementally
rather than waiting for the full completion.

```
~/Library/Application Support/Kiro/User/
  globalStorage/kiro.kiroagent/<hash>/414d1636299d2b9e4ce7e17fb11f63e9/
    <execution-uuid>    ← { executionId, actions: [say, model, readFile, …] }
```

### Hook authentication

Hook scripts read the session token from `~/.kiro-remote/token` and send it as an
`Authorization: Bearer <token>` header with every request to the relay. This ensures
that even if the relay port is somehow reachable from outside, the hook endpoints
can't be called without the token.

---

## Privacy

All data stays local. The relay server runs on your Mac and only communicates with your
phone. The Cloudflare Tunnel is point-to-point with no data stored by Cloudflare.
No analytics, no telemetry.
