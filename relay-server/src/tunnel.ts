import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

export class TunnelManager {
  private tunnelProcess: ReturnType<typeof spawn> | null = null;
  private publicUrl: string | null = null;

  async ensureCloudflaredInstalled(): Promise<void> {
    // Check if cloudflared is on PATH
    try {
      await execFileAsync('cloudflared', ['--version']);
      return; // already installed
    } catch {
      // not found, try ~/.kiro-remote/cloudflared
      const localBin = path.join(os.homedir(), '.kiro-remote', 'cloudflared');
      if (fs.existsSync(localBin)) {
        process.env.PATH = `${path.dirname(localBin)}:${process.env.PATH}`;
        // Verify it actually works
        try {
          await execFileAsync(localBin, ['--version']);
          return;
        } catch {
          // Binary exists but may be corrupt/wrong arch — redownload
          fs.unlinkSync(localBin);
        }
      }
      // download it
      await this.downloadCloudflared();
    }
  }

  async start(port: number): Promise<string> {
    await this.ensureCloudflaredInstalled();

    // Find the cloudflared binary path
    const localBin = path.join(os.homedir(), '.kiro-remote', 'cloudflared');
    const binaryPath = fs.existsSync(localBin) ? localBin : 'cloudflared';

    return new Promise((resolve, reject) => {
      this.tunnelProcess = spawn(binaryPath, [
        'tunnel', '--url', `http://localhost:${port}`
      ]);

      let output = '';

      this.tunnelProcess.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
        // cloudflared prints the URL to stderr
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          this.publicUrl = match[0];
          resolve(this.publicUrl);
        }
      });

      this.tunnelProcess.on('error', reject);

      // Timeout after 15 seconds
      setTimeout(() => reject(new Error('Tunnel startup timeout')), 15000);
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

  private async downloadCloudflared(): Promise<void> {
    // Download the appropriate binary for macOS (arm64 or x64)
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}`;
    const dest = path.join(os.homedir(), '.kiro-remote', 'cloudflared');

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    console.log(`📥 Downloading cloudflared for darwin-${arch}...`);
    // Use curl (available on all Macs)
    await execFileAsync('curl', ['-L', '-o', dest, url]);
    fs.chmodSync(dest, '755');

    // Add to PATH for this process
    process.env.PATH = `${path.dirname(dest)}:${process.env.PATH}`;
    console.log('✅ cloudflared installed to ~/.kiro-remote/cloudflared');
  }
}
