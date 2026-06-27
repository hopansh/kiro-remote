# Kiro Remote Control

[![Build](https://github.com/hopansh/kiro-remote-control/actions/workflows/build.yml/badge.svg)](https://github.com/hopansh/kiro-remote-control/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Control your [Kiro IDE](https://kiro.dev) from your phone. Browse chat sessions,
approve tool calls, send messages, and watch responses stream in real-time — all
from a mobile PWA that works over WiFi or anywhere via Cloudflare Tunnel.

## Features

- **Live streaming** — responses appear in real-time as Kiro generates them, without waiting for the full reply
- **Full chat history** — browse all sessions across every workspace; history loads when you open a session
- **Tool approval** — approve or deny tool calls with a tap; multi-choice questions render as option buttons with a countdown timer
- **Supervised mode** — accept or reject file changes when Kiro is in supervised mode
- **Reliable agent status** — idle / running / waiting, driven from the execution files on disk (not brittle command polling)
- **Background push notifications** — get a push notification when Kiro needs approval, even with the app closed (over the HTTPS tunnel)
- **Remote access** — Cloudflare Tunnel provides a public HTTPS URL automatically, no account needed
- **PWA install** — tap "Install for full-screen" in the app banner to add it to your home screen and get a true full-screen experience with no browser address bar
- **Sleep prevention** — automatically keeps your Mac awake while a session is active via `caffeinate`
- **Multi-window** — multiple Kiro workspaces can be open simultaneously; status is aggregated, messages route to the right window
- **Secure** — token-authenticated WebSocket, rate limiting, timing-safe comparisons, build-verified relay replacement on reinstall

## Requirements

- macOS (Windows/Linux not yet supported)
- [Kiro IDE](https://kiro.dev)
- Node.js 20+ (for building from source)
- Android or iOS with Chrome/Safari

## Quick Start

### Install

1. Download `kiro-remote-control-x.y.z.vsix` from [Releases](../../releases).
2. In Kiro: **Cmd+Shift+P → Extensions: Install from VSIX**.

### Connect

1. **Cmd+Shift+P → Kiro Remote: Start Remote Session**
2. Tap **Show QR** in the notification. Two QR codes appear:
   - 📶 **Local WiFi** — same network as your Mac
   - 🌐 **Cloudflare Tunnel** — any network (ready in ~10s)
3. Scan the appropriate QR on your phone. Open in Chrome.
4. Tap the **"Install for full-screen"** banner (or **Add to Home Screen**) to install as a PWA and remove the browser address bar.

### Optional: enable tool approval via hooks

```
Cmd+Shift+P → Kiro Remote: Install Hooks into Workspace
```

Copies approval hook scripts into `.kiro/hooks/`. Re-run after each extension update.

## Architecture

```
┌────────────────────┐  ws://127.0.0.1/extension  ┌──────────────────┐
│  Kiro IDE Extension│ ◄──────────────────────────►│  Relay Server    │
│  (extension/)      │   loopback, no auth          │  (relay-server/) │
└─────────┬──────────┘                             └───────┬──────────┘
          │                                                │
  Reads session +                            wss://…/mobile?token=X
  execution files                           (token auth, rate-limited)
  from disk                                              │
  (disk-driven,                            ┌────────────▼────────────┐
  reliable)                                │   Mobile PWA            │
                                           │   (mobile-ui/)          │
                                           └─────────────────────────┘
```

The extension spawns a local relay on port 3737 (configurable). On reinstall,
it compares build fingerprints and replaces any stale relay, so the new UI and
server code take effect immediately.

## Security

| What | How |
|---|---|
| Mobile WebSocket | `?token=TOKEN`; constant-time comparison; rate-limited |
| Hook endpoints | `Authorization: Bearer TOKEN` header |
| Push subscription | `?token=TOKEN` on VAPID key + subscribe endpoints |
| Extension WebSocket | Loopback (`127.0.0.1`) only — never reachable remotely |
| `/health` | Loopback only — exposes token + build id, never tunnelled |
| CORS | Localhost, RFC-1918 ranges, `*.trycloudflare.com` (HTTPS) only |
| Rate limiting | 30 req/min per IP; loopback is always exempt |
| Message size | 1 MB extension, 64 KB mobile |

The token is a 6-character alphanumeric string in `~/.kiro-remote/token`.
Rotate it with **Kiro Remote: Reset Session Token** (invalidates old QR codes).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `kiroRemote.relayPort` | `3737` | Local port for the relay server |
| `kiroRemote.autoStart` | `false` | Start relay automatically when Kiro opens |
| `kiroRemote.approvalTimeoutSeconds` | `60` | Seconds before a pending approval auto-denies |
| `kiroRemote.sessionTimeoutMinutes` | `60` | Minutes a session/QR token stays valid |
| `kiroRemote.preventSleep` | `true` | Keep your Mac awake via `caffeinate` while a session is active |

## Commands

| Command | Description |
|---|---|
| `Kiro Remote: Start Remote Session` | Start the relay and connect |
| `Kiro Remote: Stop Remote Session` | Stop everything |
| `Kiro Remote: Show QR Code` | Show local + tunnel QR codes (generated fresh from the live relay URL) |
| `Kiro Remote: Install Hooks into Workspace` | Copy hook scripts into `.kiro/hooks/` |
| `Kiro Remote: Show Logs` | Open the "Kiro Remote" output channel |
| `Kiro Remote: Reset Session Token` | Rotate the token and invalidate old QR codes |

## Tips

- The install banner in the PWA is the best way to remove the browser address bar — tap it once, and the app opens full-screen from your home screen
- Tap the status dot **3 times** in the mobile app to reveal the on-screen debug log
- The relay log is at `~/.kiro-remote/relay.log` (`tail -f` it for live diagnostics)
- The tunnel URL changes on every restart; the local URL stays stable as long as your IP doesn't change
- VAPID keys are persisted to `~/.kiro-remote/vapid.json` — existing push subscriptions survive relay restarts
- `caffeinate` runs automatically while a session is active; disable with `kiroRemote.preventSleep: false` if you'd rather manage sleep yourself

## Development

```bash
# Relay server
cd relay-server && npm install && npm run build

# Extension (compile only)
cd ../extension && npm install && npm run compile

# Full build + sync bundles + package VSIX
cd extension && npm run package
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide, including
the approval system internals, build fingerprinting, multi-window design, and
security testing.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Copyright (c) 2024 KiroRemote Contributors
