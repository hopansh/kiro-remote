import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './session';
import { createServer } from './server';
import { TunnelManager } from './tunnel';
import { printQRToTerminal, saveQRToPNG } from './qr';

const PORT = parseInt(process.env.PORT ?? '3737', 10);

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

function printBanner(localUrl: string, tunnelUrl: string | null, token: string) {
  const line = '─'.repeat(47);
  console.log(`\n┌${line}┐`);
  console.log(`│   Kiro Remote Control — Session Started        │`);
  console.log(`│                                                 │`);
  console.log(`│   Local (same WiFi):                            │`);
  console.log(`│   ${localUrl.padEnd(44)} │`);
  console.log(`│                                                 │`);
  if (tunnelUrl) {
    console.log(`│   Remote (any network):                         │`);
    console.log(`│   ${(tunnelUrl + '/?token=' + token).substring(0, 44).padEnd(44)} │`);
    console.log(`│                                                 │`);
  } else {
    console.log(`│   Remote: starting Cloudflare Tunnel...         │`);
    console.log(`│                                                 │`);
  }
  console.log(`│   Session expires in: 60 minutes                │`);
  console.log(`└${line}┘\n`);
}

async function main() {
  // 1. Create session — use the token provided by the extension if present,
  //    so the QR code always matches the server the extension spawned.
  const fixedToken = process.env.KIRO_REMOTE_TOKEN;
  const sessionManager = new SessionManager(3600, fixedToken);
  const session = sessionManager.create();
  console.log(`Session token: ${session.token}${fixedToken ? ' (from extension)' : ' (generated)'}`);

  // 2. Start server with proper error handling
  const server = createServer(sessionManager);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`FATAL: port ${PORT} is already in use. Another relay server is running.`);
    } else {
      console.error('FATAL server error:', err.message);
    }
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      console.log(`\n🚀 Relay server running on port ${PORT}`);
      resolve();
    });
  });

  // 3. Detect local IP + build mobile URL
  const localIP = process.env.KIRO_REMOTE_LOCAL_IP || getLocalIP();
  const localUrl = `http://${localIP}:${PORT}/?token=${session.token}`;

  // 4. Print banner + QR
  printBanner(localUrl, null, session.token);
  await printQRToTerminal(localUrl);

  // 5. Save QR PNG
  const qrDir = path.join(os.homedir(), '.kiro-remote');
  fs.mkdirSync(qrDir, { recursive: true });
  const qrPath = path.join(qrDir, 'qr.png');
  try {
    await saveQRToPNG(localUrl, qrPath);
    console.log(`📸 QR saved to ${qrPath}`);
  } catch (e) {
    console.warn('Could not save QR PNG:', e);
  }

  // 6. Start Cloudflare Tunnel in background (non-blocking)
  const tunnel = new TunnelManager();
  tunnel.start(PORT).then((tunnelUrl) => {
    const fullTunnelUrl = `${tunnelUrl}/?token=${session.token}`;
    console.log(`\n🌐 Cloudflare Tunnel active:`);
    console.log(`   ${fullTunnelUrl}\n`);
    printQRToTerminal(fullTunnelUrl).catch(() => {});
    saveQRToPNG(fullTunnelUrl, path.join(qrDir, 'qr-tunnel.png')).catch(() => {});
  }).catch((err) => {
    console.warn(`\n⚠️  Cloudflare Tunnel unavailable: ${err.message}`);
    console.warn('   For remote access, run: brew install cloudflared\n');
  });

  // Graceful shutdown — force exit so the port is freed even with open WS connections.
  const shutdown = () => {
    console.log('\n👋 Shutting down relay server...');
    tunnel.stop();
    server.close(() => process.exit(0));
    // Force-exit if close() hangs on open WebSocket connections.
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
