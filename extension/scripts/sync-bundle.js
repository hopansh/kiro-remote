#!/usr/bin/env node
/**
 * sync-bundle.js — runs after `tsc` to:
 *   1. Build the relay server (tsc in relay-server/)
 *   2. Wipe and re-copy relay-server/dist + node_modules → extension/server/
 *   3. Copy mobile-ui/ → extension/mobile-ui/
 *
 * Run via: npm run build  (which calls: tsc && node scripts/sync-bundle.js)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT  = path.resolve(__dirname, '..');

function run(cmd, cwd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) {
    console.error(`  ✗ source not found: ${src}`);
    process.exit(1);
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`  ✓ ${path.relative(ROOT, src)} → ${path.relative(ROOT, dst)}`);
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) {
    console.error(`  ✗ source not found: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`  ✓ ${path.relative(ROOT, src)} → ${path.relative(ROOT, dst)}`);
}

// Step 1: Build relay server
console.log('\n── Building relay server ──');
run('npm run build', path.join(ROOT, 'relay-server'));

// Step 2: Sync relay server dist + node_modules into extension/server/
console.log('\n── Syncing relay server into extension/server/ ──');
const serverDst = path.join(EXT, 'server');
fs.rmSync(serverDst, { recursive: true, force: true });
fs.mkdirSync(serverDst);
copyDir(path.join(ROOT, 'relay-server', 'dist'),         path.join(serverDst, 'dist'));
copyDir(path.join(ROOT, 'relay-server', 'node_modules'), path.join(serverDst, 'node_modules'));

// Step 3: Sync mobile-ui into extension/mobile-ui/
console.log('\n── Syncing mobile-ui into extension/mobile-ui/ ──');
const mobileUiSrc = path.join(ROOT, 'mobile-ui');
const mobileUiDst = path.join(EXT, 'mobile-ui');
fs.rmSync(mobileUiDst, { recursive: true, force: true });
fs.mkdirSync(mobileUiDst);
for (const file of fs.readdirSync(mobileUiSrc)) {
  copyFile(path.join(mobileUiSrc, file), path.join(mobileUiDst, file));
}

console.log('\n✅ Bundle synced. Run `npm run package` or `npm run package:only` to create the VSIX.\n');
