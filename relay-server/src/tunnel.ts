import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);
const INSTALL_DIR = path.join(os.homedir(), '.kiro-remote');
const BIN = path.join(INSTALL_DIR, 'cloudflared');

/** Returns a path to a working cloudflared, downloading+extracting if needed. */
async function ensureCloudflared(): Promise<string | null> {
  // 1. Already on PATH (brew install cloudflared)
  try {
    await execFileAsync('cloudflared', ['--version']);
    return 'cloudflared';
  } catch { /* not on PATH */ }

  // 2. Already downloaded and working
  if (fs.existsSync(BIN)) {
    try {
      await execFileAsync(BIN, ['--version']);
      return BIN;
    } catch {
      try { fs.unlinkSync(BIN); } catch { /* ignore */ }
    }
  }

  // 3. Download the official .tgz and extract
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
    const tgz = path.join(INSTALL_DIR, 'cloudflared.tgz');

    console.log(`📥 Downloading cloudflared (${arch})...`);
    await execFileAsync('curl', ['-fsSL', '-o', tgz, url], { maxBuffer: 1024 * 1024 * 64 });

    // Extract — the tgz contains a single `cloudflared` binary
    await execFileAsync('tar', ['-xzf', tgz, '-C', INSTALL_DIR]);
    fs.chmodSync(BIN, 0o755);
    try { fs.unlinkSync(tgz); } catch { /* ignore */ }

    // Verify it runs
    await execFileAsync(BIN, ['--version']);
    console.log('✅ cloudflared installed');
    return BIN;
  } catch (e) {
    console.warn(`Could not install cloudflared: ${(e as Error).message}`);
    try { fs.unlinkSync(BIN); } catch { /* ignore */ }
    return null;
  }
}

export class TunnelManager {
  private tunnelProcess: ReturnType<typeof spawn> | null = null;
  private publicUrl: string | null = null;

  async start(port: number): Promise<string> {
    const bin = await ensureCloudflared();
    if (!bin) {
      throw new Error('cloudflared unavailable (install manually: brew install cloudflared)');
    }

    return new Promise((resolve, reject) => {
      this.tunnelProcess = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`]);
      let output = '';
      const onData = (data: Buffer) => {
        output += data.toString();
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !this.publicUrl) {
          this.publicUrl = match[0];
          resolve(this.publicUrl);
        }
      };
      this.tunnelProcess.stdout?.on('data', onData);
      this.tunnelProcess.stderr?.on('data', onData);
      this.tunnelProcess.on('error', (err) => reject(err));
      setTimeout(() => reject(new Error('Tunnel startup timeout')), 20000);
    });
  }

  stop(): void {
    this.tunnelProcess?.kill();
    this.tunnelProcess = null;
    this.publicUrl = null;
  }

  getUrl(): string | null {
    return this.publicUrl;
  }
}
