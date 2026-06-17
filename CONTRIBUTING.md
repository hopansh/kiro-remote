# Contributing to Kiro Remote Control

Thanks for your interest! Here's everything you need to get started.

## Platform Note

Kiro Remote Control is currently **macOS-only**. It reads chat session files from
`~/Library/Application Support/Kiro/...` and uses `lsof` for port management.
Contributions that add Windows/Linux support are welcome.

---

## Architecture

```
┌─────────────────────┐  ws://127.0.0.1/extension  ┌───────────────────┐
│  Kiro IDE Extension │ ◄──────────────────────────►│   Relay Server    │
│  (extension/)       │   loopback only, no auth    │  (relay-server/)  │
└─────────────────────┘                             └────────┬──────────┘
                                                             │
                                               wss://…/mobile?token=X
                                               (token required, rate-limited)
                                                             │
                                                    ┌────────▼──────────┐
                                                    │   Mobile PWA      │
                                                    │  (mobile-ui/)     │
                                                    └───────────────────┘
```

- **relay-server/** — Node.js/Express + WebSocket server. Relays messages, serves
  the mobile PWA, and optionally exposes a Cloudflare Tunnel. The security model
  (auth, rate limiting, CORS) lives here.
- **extension/** — VS Code/Kiro extension. Reads Kiro's on-disk session files,
  streams real-time execution responses, polls for approvals, and spawns the relay.
- **mobile-ui/** — Single-file PWA (`index.html`). No build step — plain HTML/CSS/JS.

### Key data flows

| Flow | Path |
|---|---|
| Chat history | Extension reads `~/.../workspace-sessions/<key>/<uuid>.json` every 2s |
| Streaming responses | Extension watches `~/.../414d1636…/<exec-uuid>` for new `say` actions |
| Approval (hooks) | Shell script → `POST /hook/pre-tool-use` (token required) → relay → phone → relay → shell |
| Approval (API) | Extension polls `kiroAgent.executions.getPendingQuestions` → relay → phone → relay → Kiro |
| Send message | Phone → relay → extension → `kiroAgent.agent.askAgent` or `kiroAgent.loadSessionWithPrompt` |

---

## Development Setup

### Prerequisites

- macOS
- Node.js 20+
- Kiro IDE (for testing)

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
npm run compile
```

### 4. Package into a VSIX

```bash
cd extension
npm run package    # compile + sync bundles + vsce package
```

Install the `.vsix` in Kiro via **Extensions: Install from VSIX**.

---

## Build Commands

| Directory | Command | What it does |
|---|---|---|
| `relay-server` | `npm run build` | TypeScript → `dist/` |
| `relay-server` | `npm run dev` | Watch mode |
| `extension` | `npm run compile` | TypeScript → `out/` |
| `extension` | `npm run watch` | Watch mode |
| `extension` | `npm run build` | Compile + sync relay dist + mobile-ui into bundle |
| `extension` | `npm run package` | Full build + VSIX |
| `extension` | `npm run package:only` | VSIX only (skip build — after manual sync) |

> Always use `npm run package` (not `package:only`) to ensure the relay server and
> mobile-ui bundles are synced before packaging.

---

## Security Model

Understanding the security design is important before contributing to the relay or auth code.

### Token

A 6-char random alphanumeric token is stored in `~/.kiro-remote/token`. It's created
once and persists across restarts (survives extension reinstalls). It's included in:
- The QR code URL (`?token=TOKEN`)
- Mobile WebSocket URL (`/mobile?token=TOKEN`)
- Hook requests (`Authorization: Bearer TOKEN`)

Rotate it with **Kiro Remote: Reset Session Token**.

### What's protected vs public

| Endpoint | Auth required | Why |
|---|---|---|
| `GET /` (PWA shell) | No | Safe to serve publicly — it's just HTML |
| `GET /manifest.json`, `/sw.js`, `/icon-192.png` | No | Static PWA assets |
| `GET /session/:token` | Token in path (rate-limited) | Used by phone to validate before WS connect |
| `GET /health` | Loopback only | Returns token — must never be exposed over tunnel |
| `POST /hook/*` | Bearer token header | Called by local shell scripts |
| `WS /extension` | Loopback only | Extension connects from 127.0.0.1 |
| `WS /mobile` | Token in query param | Phone connects with token from QR |

### Rate limiting

All auth-touching endpoints are rate-limited to **30 requests/min per IP**.
The implementation is in-memory (`Map<ip, {count, resetAt}>`), sufficient for
a single-user server. If you add persistence across sessions, consider a more
robust solution.

### Adding new endpoints

If you add a new HTTP route:
1. If it handles any sensitive data or actions, add `requireToken` middleware
2. If it's a management endpoint (like `/health`), add a loopback-only check
3. Update this document

---

## How to Test

1. `cd extension && npm run package`
2. Install the `.vsix` in Kiro
3. `Cmd+Shift+P → Kiro Remote: Start Remote Session`
4. Scan the QR code on your phone
5. `Cmd+Shift+P → Kiro Remote: Install Hooks into Workspace`
6. Run a Kiro agent task and verify status/approvals appear on your phone

### Testing the security layer

```bash
# Should return 403 (health is loopback-only when accessed from non-loopback)
curl http://localhost:3737/health   # works (loopback)

# Should return 401
curl -X POST http://localhost:3737/hook/pre-tool-use \
  -H "Content-Type: application/json" -d '{}'

# Should return 200 (with token)
TOKEN=$(cat ~/.kiro-remote/token)
curl -X POST http://localhost:3737/hook/pre-tool-use \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"tool_name":"test","tool_input":{}}'

# Should return 401 (bad token)
curl http://localhost:3737/session/BADTOKEN
```

### Debugging

- **Extension logs** — Output panel (`Cmd+Shift+U`) → "Kiro Remote"
- **Relay logs** — `~/.kiro-remote/relay.log` (tail it live: `tail -f ~/.kiro-remote/relay.log`)
- **Mobile debug** — Tap the status dot 3× in the mobile app to open the on-screen debug log

---

## Source vs Bundled Files

Always edit the source; the build copies them into the extension bundle:

| Edit this | Not this |
|---|---|
| `mobile-ui/index.html` | `extension/mobile-ui/index.html` |
| `relay-server/src/` | `extension/server/` |
| `extension/hooks/*.sh` | The copies in `.kiro/hooks/` (workspace-specific) |

---

## Pull Request Guidelines

- Keep PRs focused: one feature or fix per PR
- Describe what changed, why, and how to test it manually
- TypeScript: aim for zero `any` casts; use the types in `types.ts`
- Security changes: note what threat you're addressing and how
- Mobile UI: test on both Android Chrome and iOS Safari if possible
- Run `npm run compile` in `extension/` and `npm run build` in `relay-server/` before submitting — both must pass with zero errors
