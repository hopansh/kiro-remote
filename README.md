# Kiro Remote Control

[![Build](https://github.com/hopansh/kiro-remote-control/actions/workflows/build.yml/badge.svg)](https://github.com/hopansh/kiro-remote-control/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Control your [Kiro IDE](https://kiro.dev) from your phone. View chat sessions, approve tool
calls, send messages, and get real-time streaming responses — all from a mobile browser PWA
that works over WiFi or anywhere via Cloudflare Tunnel.

<!-- Screenshot placeholder: add a screenshot here once available -->

## Features

- **Live chat** — browse all Kiro chat sessions across every workspace; messages stream in real-time as Kiro responds
- **Tool approval** — approve or deny tool calls with a tap, with countdown timer
- **Supervised mode** — accept or reject file changes when Kiro is in supervised mode
- **Agent status** — see whether Kiro is idle, running, or waiting for approval
- **Background push** — get a push notification when Kiro needs approval, even with the app closed (over the HTTPS tunnel)
- **Session browser** — browse and search all past chat sessions, sorted by most recently active
- **Remote access** — Cloudflare Tunnel gives you a public HTTPS URL so you can connect from any network, no account needed
- **PWA** — installable on Android/iOS home screen for a native feel
- **Secure** — token-authenticated WebSocket, rate limiting, timing-safe comparisons, no secrets exposed over the tunnel

## Requirements

- macOS (Windows/Linux support is not yet implemented)
- [Kiro IDE](https://kiro.dev)
- Node.js 20+ (for building from source)
- Android or iOS with Chrome/Safari (for the mobile UI)

## Quick Start

1. **Install the extension** — download the latest `.vsix` from [Releases](../../releases)
   and install via **Cmd+Shift+P → Extensions: Install from VSIX**

2. **Start a session** — **Cmd+Shift+P → Kiro Remote: Start Remote Session**

3. **Scan the QR code** — tap **Show QR** in the notification; two QR codes appear:
   - 📶 **Local WiFi** — use when on the same network as your Mac
   - 🌐 **Cloudflare Tunnel** — use from any network (starts within ~10s)

4. Open in Chrome and tap **Add to Home Screen** to install as a PWA.

## Architecture

```
┌────────────────────┐  ws://127.0.0.1/extension  ┌──────────────────┐
│  Kiro IDE Extension│ ◄──────────────────────────►│  Relay Server    │
│  (extension/)      │   loopback only, no auth    │  (relay-server/) │
└────────────────────┘                             └───────┬──────────┘
         │                                                 │
   Reads session                              wss://…/mobile?token=X
   files from disk                          (token required, rate-limited)
                                                           │
                                              ┌────────────▼────────────┐
                                              │   Mobile PWA            │
                                              │   (mobile-ui/)          │
                                              └─────────────────────────┘
```

The extension spawns a local relay server on port 3737 (configurable). The relay
serves the mobile PWA over HTTP and bridges WebSocket connections between the Kiro
extension and the phone.

## Security

The relay server is designed to be safe to expose over a public Cloudflare Tunnel:

| What | How |
|---|---|
| Mobile WebSocket auth | `?token=TOKEN` required; constant-time comparison; rate-limited |
| Hook endpoint auth | `Authorization: Bearer TOKEN` header required |
| Extension WebSocket | Accepts connections from `127.0.0.1` only — never reachable from the internet |
| `/health` endpoint | Responds only to loopback — the session token is never exposed over the tunnel |
| CORS | Restricted to localhost, local network ranges, and `*.trycloudflare.com` (HTTPS only) |
| Rate limiting | 30 requests/min per IP on all auth-touching endpoints |
| Message size limits | 1 MB for extension messages, 64 KB for mobile messages |

The session token is a 6-character random alphanumeric string stored in `~/.kiro-remote/token`.
It's included in the QR code URL and persists across restarts so you only scan once.
Use **Kiro Remote: Reset Session Token** to rotate it and invalidate old QR codes.

## Development Setup

```bash
# Build the relay server
cd relay-server && npm install && npm run build

# Build the extension
cd ../extension && npm install && npm run compile

# Package everything into a VSIX (syncs relay + mobile-ui into the bundle)
npm run package
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `kiroRemote.relayPort` | `3737` | Local port for the relay server |
| `kiroRemote.autoStart` | `false` | Start relay automatically when Kiro opens |
| `kiroRemote.approvalTimeoutSeconds` | `60` | Seconds before a pending approval auto-denies |
| `kiroRemote.sessionTimeoutMinutes` | `60` | Minutes a session/QR token stays valid |
| `kiroRemote.preventSleep` | `true` | Keep your Mac awake (via `caffeinate`) while a session is active |

## Optional: Install Hooks

For real-time tool approval prompts and task events:

```
Cmd+Shift+P → Kiro Remote: Install Hooks into Workspace
```

This copies hook scripts into `.kiro/hooks/` and registers them in `hooks.json`.
The hooks authenticate to the relay using the token from `~/.kiro-remote/token`.

> **Note:** After updating the extension, run **Install Hooks** again to refresh the scripts.

## Commands

| Command | Description |
|---|---|
| `Kiro Remote: Start Remote Session` | Start the relay server and connect |
| `Kiro Remote: Stop Remote Session` | Stop everything |
| `Kiro Remote: Show QR Code` | Show both local and tunnel QR codes side by side |
| `Kiro Remote: Install Hooks into Workspace` | Copy hook scripts into `.kiro/hooks/` |
| `Kiro Remote: Show Logs` | Open the "Kiro Remote" output channel |
| `Kiro Remote: Reset Session Token` | Rotate the session token (invalidates old QR codes) |

## Tips

- Run `caffeinate -i` to prevent your Mac from sleeping during a long session (this is automatic while a session is active unless you disable `kiroRemote.preventSleep`)
- Tap the status dot **3 times** in the mobile app to open the on-screen debug log
- The tunnel URL changes on every session restart; the local WiFi URL is always `http://<ip>:3737/?token=<token>`
- The relay log is at `~/.kiro-remote/relay.log` — useful for diagnosing connection issues

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Copyright (c) 2024 KiroRemote Contributors
