# Kiro Remote Control

Control your Kiro IDE from your Android phone.

## Components

- **relay-server/** — Node.js relay server that runs on your Mac
- **extension/** — VS Code/Kiro extension (VSIX)
- **mobile-ui/** — PWA served by the relay server

## Quick Start

### 1. Build the relay server
```bash
cd relay-server
npm install
npm run build
```

### 2. Build and package the extension
```bash
cd extension
npm install
npm run compile
npx vsce package --no-dependencies
```

### 3. Install the extension in Kiro
`Cmd+Shift+P` → Extensions: Install from VSIX → `kiro-remote-control-0.1.0.vsix`

### 4. Start a session
`Cmd+Shift+P` → Kiro Remote: Start Remote Session

### 5. Install hooks into your project
`Cmd+Shift+P` → Kiro Remote: Install Hooks into Workspace

### 6. Scan QR on your Android phone
Opens in Chrome → tap "Add to Home Screen" for PWA install

## Tips

- Run `caffeinate -i` to prevent Mac from sleeping during a session
- Cloudflare Tunnel is auto-launched for remote access (no setup required)
- If `cloudflared` isn't installed, run `brew install cloudflared` manually
