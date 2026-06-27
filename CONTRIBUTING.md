# Contributing to Kiro Remote Control

Thanks for your interest! Here's everything you need to get started.

## Platform Note

Kiro Remote Control is currently **macOS-only**. It reads chat session and execution
log files from `~/Library/Application Support/Kiro/...`, uses `caffeinate` for
sleep prevention, and `lsof` for port management. Contributions that add
Windows/Linux support are welcome.

---

## Architecture

```
┌─────────────────────┐  ws://127.0.0.1/extension  ┌───────────────────┐
│  Kiro IDE Extension │ ◄──────────────────────────►│   Relay Server    │
│  (extension/)       │   loopback only, no auth    │  (relay-server/)  │
└──────────┬──────────┘                             └────────┬──────────┘
           │                                                 │
  Reads session files                         wss://…/mobile?token=X
  Reads execution logs                       (token required, rate-limited)
  (disk-driven, no                                           │
   kiroAgent command                              ┌──────────▼──────────┐
   dependency)                                    │   Mobile PWA        │
                                                  │  (mobile-ui/)       │
                                                  └─────────────────────┘
```

### Components

**`relay-server/`** — Node.js/Express + WebSocket server. Relays messages,
serves the mobile PWA as static files, manages Web Push (VAPID) for background
notifications, and optionally exposes a Cloudflare Tunnel. The security model
(auth, rate limiting, CORS, approval coordination) lives here.

**`extension/`** — VS Code/Kiro extension. Reads Kiro's on-disk session and
execution files to drive all features. Spawns and manages the relay process.
Replaced when a newer build is installed (build fingerprint in `/health`).

**`mobile-ui/`** — Single-file PWA (`index.html` + `sw.js`). No build step —
plain HTML/CSS/JS. The service worker enables PWA installation and background
push notifications.

### Key source files

| File | Purpose |
|---|---|
| `extension/src/extension.ts` | Entry point: spawns relay, starts all watchers |
| `extension/src/executionFiles.ts` | Shared disk helpers: find newest execution file |
| `extension/src/agentState.ts` | Shared in-process approval-state signal |
| `extension/src/approvalWatcher.ts` | Detects pending questions from disk + command |
| `extension/src/executionWatcher.ts` | Streams live `say` actions to phone |
| `extension/src/chatWatcher.ts` | Streams chat history from session files |
| `extension/src/statusPoller.ts` | Broadcasts agent status (disk-driven) |
| `extension/src/relayClient.ts` | Native WS client (no npm dep) to relay |
| `extension/src/sessionManager.ts` | Reads/sends full session list to phone |
| `relay-server/src/server.ts` | Express + WS; unified approval coordinator |
| `relay-server/src/push.ts` | Web Push / VAPID for background notifications |
| `relay-server/src/tunnel.ts` | Cloudflare Tunnel lifecycle |
| `mobile-ui/index.html` | The complete PWA UI |
| `mobile-ui/sw.js` | Service worker (offline cache + push handler) |

### Key data flows

| Flow | Path |
|---|---|
| Chat history | Extension reads `~/.../workspace-sessions/<key>/<uuid>.json` every 2s |
| Live streaming | Extension watches newest execution file for `say` actions (by mtime) |
| Approval (hooks) | Shell script → `POST /hook/pre-tool-use` → unified coordinator → phone |
| Approval (disk) | Watcher reads `PendingAction` from execution log → coordinator → phone |
| Approval (command) | Watcher calls `getPendingQuestions` (when execution is yielded) → coordinator → phone |
| Approval dedup | Both paths funnel through `registerApproval()` — same modal, same timeout |
| Answer | Extension calls `kiroAgent.executions.acceptUserResponse({questionId, response:{type:'answered', answer}, executionId})` |
| Agent status | `statusPoller` checks `agentState` store + newest file mtime |
| Send message | Phone → relay → extension → `kiroAgent.loadSessionWithPrompt` (or fallback) |
| Background push | Relay calls `sendPush()` → browser push subscription → service worker |
| Session expiry | Relay exposes `expiresAt` + `approvalTimeoutSeconds` via `/session/:token` and WS `session_info` |
| Build replacement | Extension stamps relay with `KIRO_REMOTE_BUILD`; on restart it checks `/health` and replaces if build differs |

---

## Development Setup

### Prerequisites

- macOS
- Node.js 20+
- Kiro IDE (for end-to-end testing)

### 1. Clone

```bash
git clone https://github.com/hopansh/kiro-remote-control.git
cd kiro-remote-control
```

### 2. Build the relay server

```bash
cd relay-server
npm install
npm run build
```

### 3. Build the extension

```bash
cd ../extension
npm install
npm run compile   # TypeScript only
npm run build     # TypeScript + sync relay dist + mobile-ui into bundle
```

### 4. Package into a VSIX

```bash
cd extension
npm run package   # compile + sync + vsce package
```

Install the `.vsix` in Kiro via **Extensions: Install from VSIX**.

> **Always bump the version** in `extension/package.json` before repackaging.
> Kiro/VS Code may skip the reinstall if the version string hasn't changed.

---

## Build Commands

| Directory | Command | What it does |
|---|---|---|
| `relay-server/` | `npm run build` | TypeScript → `dist/` |
| `relay-server/` | `npm run dev` | Watch mode via `ts-node` |
| `extension/` | `npm run compile` | TypeScript → `out/` |
| `extension/` | `npm run watch` | TypeScript watch mode |
| `extension/` | `npm run build` | Compile + rebuild relay + sync relay `dist/` + `mobile-ui/` into `server/` and `mobile-ui/` |
| `extension/` | `npm run package` | Full build + VSIX |
| `extension/` | `npm run package:only` | VSIX only (no rebuild — use after manual sync) |

> The `npm run build` step in `extension/` triggers `relay-server/npm run build`
> automatically. You don't need to build them separately unless you're iterating
> on the relay alone.

### What `sync-bundle.js` does

`extension/scripts/sync-bundle.js` (run by `npm run build`) copies:
- `relay-server/dist/` → `extension/server/dist/`
- `relay-server/node_modules/` → `extension/server/node_modules/`
- `mobile-ui/` files → `extension/mobile-ui/`

This is how the VSIX ships a self-contained relay server and mobile UI without
requiring the user to build anything separately.

---

## Build Fingerprinting

Every spawned relay receives a `KIRO_REMOTE_BUILD` env var (the mtime of
`extension/server/dist/index.js`). The relay exposes it via `GET /health`.

When the extension starts a session:
1. It probes `/health` to read the running relay's `token` and `build`.
2. If both match → reuse the existing relay (multi-window case).
3. If either differs → kill the old relay and spawn a fresh one.

This means **reinstalling the extension always replaces the relay** and serves
the new mobile UI and server code. Without this, a stale relay (old UI, old
routing) would stay running indefinitely.

---

## Approval System

The approval flow has two detection paths that converge on one coordinator in
the relay.

### Detection (extension side)

1. **File-based** (`ApprovalWatcher`): scans the newest execution log every 800ms
   for actions with `actionState === "PendingAction"` and unanswered `output.questions[]`.
   Works regardless of the `kiroAgent` command surface.

2. **Command-based** (`ApprovalWatcher`): also calls
   `kiroAgent.executions.getPendingQuestions()` — returns results when the current
   execution is yielded. Acts as a supplement to the file-based path.

Both paths are deduped by `questionId` before forwarding.

### Coordinator (relay side)

`registerApproval(req, onResolve)` in `relay-server/src/server.ts`:
- Broadcasts the approval request to connected phones (live WebSocket modal).
- Fires a Web Push notification to any background push subscriptions.
- Coalesces duplicate requests for the same `tool|command` key into one modal.
- Uses `APPROVAL_TIMEOUT_SEC` (from `KIRO_REMOTE_APPROVAL_TIMEOUT` env, mirroring
  `kiroRemote.approvalTimeoutSeconds`) for both the WS and hook paths.

### Resolution (extension side)

```typescript
await vscode.commands.executeCommand('kiroAgent.executions.acceptUserResponse', {
  questionId,
  response: { type: 'answered', answer },  // 'Yes' | 'No' | option label
  executionId,
});
```

### Multi-choice questions

Kiro's `userInput` actions can carry `options: string[]` (e.g. "Yes" / "No" / custom
labels). These are normalised to `{id, label}[]`, forwarded in the
`ApprovalRequestMessage.options` field, and rendered as tappable option buttons on
the phone. The chosen label is sent back as `ApprovalResponseMessage.answer` and
passed directly to `acceptUserResponse`.

---

## Security Model

### Token

A 6-char random alphanumeric token is stored in `~/.kiro-remote/token`. Created
once; persists across restarts and reinstalls. Included in:
- QR code URL (`?token=TOKEN`)
- Mobile WebSocket URL (`/mobile?token=TOKEN`)
- Hook requests (`Authorization: Bearer TOKEN`)
- Web Push subscription endpoint (`?token=TOKEN`)

Rotate with **Kiro Remote: Reset Session Token**.

### What's protected vs public

| Endpoint | Auth required | Notes |
|---|---|---|
| `GET /` | None | PWA shell — just HTML, no sensitive data |
| `GET /manifest.json`, `/sw.js`, `/icon-192.png` | None | Static PWA assets |
| `GET /session/:token` | Token in path (rate-limited) | Returns `expiresAt` + `approvalTimeoutSeconds`; no token leakage |
| `GET /health` | Loopback only | Returns token + build id; never exposed over tunnel |
| `POST /hook/*` | Bearer token header | Called by local shell scripts |
| `GET /push/vapid-public-key` | Bearer token | Returns VAPID public key for push subscription |
| `POST /push/subscribe` | Bearer token | Stores push subscription |
| `WS /extension` | Loopback only | Multiple windows supported; each in `extensionClients` set |
| `WS /mobile` | Token in query param | Rate-limited; session expiry enforced |

### Rate limiting

All auth-touching endpoints: **30 requests/min per IP**, except loopback
(the local extension itself is always exempt). In-memory; sufficient for
single-user use.

### CORS

Restricted to:
- `localhost` / `127.0.0.1`
- Local network RFC-1918 ranges
- `*.trycloudflare.com` (HTTPS only)

---

## Web Push

VAPID keys are generated on first run and persisted to `~/.kiro-remote/vapid.json`
so existing phone subscriptions survive relay restarts.

Push is sent to all active subscriptions whenever `registerApproval()` fires.
Expired/unsubscribed endpoints (HTTP 404/410) are removed automatically.

Push only works in a **secure context** (HTTPS). Over the Cloudflare Tunnel it
works out of the box. Over plain-HTTP local WiFi the in-page notification fallback
is used instead.

---

## How to Test

### Basic smoke test

```bash
cd extension && npm run package
# Install the VSIX in Kiro, then:
# Cmd+Shift+P → Kiro Remote: Start Remote Session
# Cmd+Shift+P → Kiro Remote: Install Hooks into Workspace
# Scan QR code on phone, run a Kiro task
```

### Verify build replacement (after reinstall)

After reinstalling a new VSIX, watch the output panel. You should see:
```
replacing it … different build
Starting relay … (build <timestamp>)
```
If you see "reusing it (not spawning)", the relay was NOT replaced — the build
fingerprint matched, meaning the code didn't change.

### Testing the security layer

```bash
TOKEN=$(cat ~/.kiro-remote/token)

# /health is loopback-only
curl http://127.0.0.1:3737/health          # 200 with token + build
# curl from non-loopback → 403 (test by changing 127.0.0.1 to your LAN IP)

# Hook without token → 401
curl -X POST http://127.0.0.1:3737/hook/pre-tool-use \
  -H "Content-Type: application/json" -d '{}'

# Hook with token → 200 (action: allow when no mobile connected)
curl -X POST http://127.0.0.1:3737/hook/pre-tool-use \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"tool_name":"test","tool_input":{}}'

# Session validation
curl http://127.0.0.1:3737/session/$TOKEN  # 200 + expiresAt + approvalTimeoutSeconds
curl http://127.0.0.1:3737/session/BADTOK  # 401

# VAPID key
curl "http://127.0.0.1:3737/push/vapid-public-key?token=$TOKEN"  # 200 + publicKey
```

### Debugging

| Where | How |
|---|---|
| Extension logs | Output panel (`Cmd+Shift+U`) → "Kiro Remote" |
| Relay logs | `tail -f ~/.kiro-remote/relay.log` |
| Mobile debug | Tap the status dot **3×** in the PWA to reveal the on-screen debug log |
| Approval detection | Watch extension output for `[kiro-remote:approval]` lines; confirms which questions are being found and sent |

---

## Source vs Bundled Files

**Always edit the source.** The build copies them into the extension bundle:

| Edit this (source) | Not this (generated) |
|---|---|
| `mobile-ui/index.html` | `extension/mobile-ui/index.html` |
| `mobile-ui/sw.js` | `extension/mobile-ui/sw.js` |
| `relay-server/src/` | `extension/server/dist/` |
| `relay-server/src/` | `extension/server/node_modules/` |
| `extension/hooks/*.sh` | `.kiro/hooks/` (workspace installs) |

---

## Session & Timeout Configuration

All timeouts are driven from VS Code settings and passed to the relay via
environment variables:

| Setting | Env var | Default | Used by |
|---|---|---|---|
| `kiroRemote.approvalTimeoutSeconds` | `KIRO_REMOTE_APPROVAL_TIMEOUT` | `60` | Relay approval coordinator + phone countdown |
| `kiroRemote.sessionTimeoutMinutes` | `KIRO_REMOTE_SESSION_TIMEOUT` (in seconds) | `60` | Session expiry; `/session/:token`, WS `session_info` |
| `kiroRemote.relayPort` | `PORT` | `3737` | Relay listen port |
| `kiroRemote.preventSleep` | (macOS `caffeinate`) | `true` | Spawns `caffeinate -i -s -m` while session is active |

The phone displays a live session countdown (`session Nm` in the header) and
auto-shows the expired screen when it hits zero.

---

## Multi-Window Support

Multiple Kiro windows can each connect an extension WebSocket. The relay
maintains a `Set<WebSocket>` (`extensionClients`) and a
`Map<WebSocket, AgentState>` (`extensionState`).

- Status updates are **aggregated** across windows (`waiting_approval > running > idle`).
- Instructions from the phone route to **one** window (primary) so actions aren't duplicated.
- Chat messages are deduped by `id` in the relay buffer; duplicate sends from
  multiple window watchers are suppressed at the phone.
- Approvals broadcast to **all** windows (each resolves only its own pending requests).

---

## Pull Request Guidelines

- Keep PRs focused: one feature or fix per PR.
- Describe what changed, why, and how to test it manually.
- TypeScript: aim for zero `any` casts; use the shared types in `types.ts`.
- Security changes: note the threat model and how the change addresses it.
- Approval changes: test both the file-based and command-based detection paths.
- Mobile UI: test on Android Chrome (primary target). iOS Safari is a bonus.
- Before submitting, run:

```bash
cd relay-server && npm run build    # must pass with zero errors
cd ../extension && npm run compile  # must pass with zero errors
node -e "const fs=require('fs');const h=fs.readFileSync('mobile-ui/index.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);require('vm').compileFunction(m[1]);console.log('mobile JS OK');" 
```
