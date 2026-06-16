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
  // 1. Create session
  const sessionManager = new SessionManager(3600);
  const session = sessionManager.create();

  // 2. Start server
  const server = createServer(sessionManager);
  server.listen(PORT, () => {
    console.log(`\n🚀 Relay server running on port ${PORT}`);
  });

  // 3. Detect local IP + build mobile URL
  const localIP = getLocalIP();
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
    // Save tunnel QR
    saveQRToPNG(fullTunnelUrl, path.join(qrDir, 'qr-tunnel.png')).catch(() => {});
  }).catch((err) => {
    console.warn(`\n⚠️  Cloudflare Tunnel unavailable: ${err.message}`);
    console.warn('   For remote access, run: brew install cloudflared\n');
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down relay server...');
    tunnel.stop();
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    tunnel.stop();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
