import QRCode from 'qrcode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrcodeTerminal = require('qrcode-terminal') as { generate: (text: string, opts?: { small?: boolean }) => void };

export async function printQRToTerminal(url: string): Promise<void> {
  console.log('\n📱 Scan this QR code with your Android phone:\n');
  qrcodeTerminal.generate(url, { small: true });
  console.log(`\n🔗 Or open: ${url}\n`);
}

export async function saveQRToPNG(url: string, outputPath: string): Promise<void> {
  await QRCode.toFile(outputPath, url, {
    type: 'png',
    width: 400,
    margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' }
  });
}
