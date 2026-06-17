#!/usr/bin/env node
/**
 * dev-test.js — standalone test harness for the mobile UI.
 *
 * Starts the relay server and pumps real Kiro session data into it,
 * so you can test the phone UI in a browser without installing the extension.
 *
 * Usage:
 *   node scripts/dev-test.js
 *
 * Then open the printed URL in your browser (or phone).
 */

'use strict';
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const PORT = 3737;
const TOKEN = 'DEVTEST';

// ── 1. Start relay server ────────────────────────────────────────
const serverPath = path.join(__dirname, '..', 'dist', 'index.js');
if (!fs.existsSync(serverPath)) {
  console.error('❌  Build the relay server first: npm run build');
  process.exit(1);
}

const relay = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: String(PORT), KIRO_REMOTE_TOKEN: TOKEN },
  stdio: 'inherit',
});
relay.on('error', e => { console.error('relay error:', e.message); process.exit(1); });

// ── 2. Wait for relay to be ready ───────────────────────────────
async function waitReady(ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`Relay did not start on port ${PORT}`);
}

// ── 3. Read real Kiro sessions from disk ────────────────────────
const SESSIONS_BASE = path.join(
  os.homedir(), 'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent', 'workspace-sessions'
);
const EXEC_BASE = path.join(
  os.homedir(), 'Library', 'Application Support', 'Kiro', 'User',
  'globalStorage', 'kiro.kiroagent'
);
const EXEC_SUBDIR = '414d1636299d2b9e4ce7e17fb11f63e9';

function decodeKey(dir) {
  return Buffer.from(dir.replace(/_+$/, ''), 'base64').toString('utf8');
}

function extractSayResponse(actions) {
  if (!Array.isArray(actions)) return null;
  let last = null;
  for (const a of actions) {
    if (a.actionType === 'say') {
      const msg = a.output?.message;
      if (msg && msg.trim()) last = msg.trim();
    }
  }
  return last;
}

// Build execution response cache
function buildExecCache() {
  const cache = new Map();
  try {
    for (const hashDir of fs.readdirSync(EXEC_BASE)) {
      const dir = path.join(EXEC_BASE, hashDir, EXEC_SUBDIR);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        const fpath = path.join(dir, file);
        if (!fs.statSync(fpath).isFile()) continue;
        try {
          const d = JSON.parse(fs.readFileSync(fpath, 'utf8'));
          if (!d.executionId) continue;
          const resp = extractSayResponse(d.actions);
          if (resp) cache.set(d.executionId, resp);
        } catch { /* skip */ }
      }
    }
  } catch { /* no exec dir */ }
  console.log(`📚 Indexed ${cache.size} execution responses`);
  return cache;
}

function readAllSessions() {
  const sessions = [];
  if (!fs.existsSync(SESSIONS_BASE)) return sessions;
  for (const dir of fs.readdirSync(SESSIONS_BASE)) {
    let wsPath;
    try { wsPath = decodeKey(dir); } catch { continue; }
    const wsName = path.basename(wsPath);
    const listFile = path.join(SESSIONS_BASE, dir, 'sessions.json');
    if (!fs.existsSync(listFile)) continue;
    let list;
    try { list = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch { continue; }
    for (const s of list) {
      const sf = path.join(SESSIONS_BASE, dir, `${s.sessionId}.json`);
      let mc = 0, last = '';
      if (fs.existsSync(sf)) {
        try {
          const d = JSON.parse(fs.readFileSync(sf, 'utf8'));
          mc = (d.history || []).length;
          const h = d.history || [];
          for (let i = h.length - 1; i >= 0; i--) {
            const msg = h[i].message || {};
            const t = typeof msg.content === 'string' ? msg.content
              : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '');
            if (t.trim()) { last = t.trim().substring(0, 100); break; }
          }
        } catch { /* skip */ }
      }
      sessions.push({
        sessionId: s.sessionId,
        title: s.title || 'Chat',
        workspacePath: wsPath,
        workspaceName: wsName,
        workspaceKey: dir,
        dateCreated: s.dateCreated ? parseInt(s.dateCreated) : 0,
        messageCount: mc,
        lastMessage: last,
      });
    }
  }
  return sessions.sort((a, b) => b.dateCreated - a.dateCreated);
}

function readSessionHistory(workspaceKey, sessionId, execCache) {
  const file = path.join(SESSIONS_BASE, workspaceKey, `${sessionId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const history = d.history || [];
    const title = d.title || 'Chat';
    const baseTs = d.dateCreated ? parseInt(d.dateCreated) : 0;
    const msgs = [];
    let idx = 0;
    for (const entry of history) {
      const msg = entry.message || {};
      const role = msg.role || 'user';
      let text;
      if (role === 'assistant') {
        text = (entry.executionId && execCache.get(entry.executionId)) ||
          (typeof msg.content === 'string' ? msg.content
            : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('\n') : ''));
      } else {
        text = typeof msg.content === 'string' ? msg.content
          : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('\n') : '');
      }
      if (text && text.trim()) {
        msgs.push({ id: msg.id || `${sessionId}-${idx}`, role, text: text.trim(), timestamp: baseTs + idx, sessionId, sessionTitle: title });
        idx++;
      }
    }
    return msgs;
  } catch (e) { console.error('readSessionHistory error:', e.message); return []; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 4. Main ──────────────────────────────────────────────────────
(async () => {
  console.log('\n🔧 dev-test.js — starting relay server...\n');

  await sleep(2000); // let relay start printing its own banner
  await waitReady();
  console.log('\n✅ Relay ready. Connecting as extension...\n');

  const execCache = buildExecCache();
  const sessions = readAllSessions();
  console.log(`📂 Found ${sessions.length} sessions across ${new Set(sessions.map(s => s.workspacePath)).size} workspaces\n`);

  // ── Connect as the extension
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/extension`);

  ws.on('open', () => {
    console.log('🔌 Extension WS connected to relay');

    // Send session list immediately
    ws.send(JSON.stringify({
      type: 'session_list',
      id: 'dev-sessions',
      timestamp: Date.now(),
      sessions,
    }));
    console.log(`📋 Sent ${sessions.length} sessions to relay`);

    // Send a status update so the phone shows something
    ws.send(JSON.stringify({
      type: 'status_update',
      id: 'dev-status',
      timestamp: Date.now(),
      agentState: 'idle',
      workspaceName: 'dev-test',
    }));

    console.log('\n📱 Open on your phone or browser:');
    const ip = getLocalIP();
    console.log(`   http://${ip}:${PORT}/?token=${TOKEN}`);
    console.log(`   http://localhost:${PORT}/?token=${TOKEN}\n`);
  });

  // Handle requests from the phone (via relay)
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'request_session_history') {
      console.log(`📖 Phone requested history for session ${msg.sessionId.substring(0, 8)}...`);
      const msgs = readSessionHistory(msg.workspaceKey, msg.sessionId, execCache);
      console.log(`   → streaming ${msgs.length} messages`);
      for (const m of msgs) {
        ws.send(JSON.stringify({
          type: 'chat_message',
          ...m,
        }));
      }
    }

    if (msg.type === 'request_refresh') {
      console.log('🔄 Phone connected — resending session list');
      ws.send(JSON.stringify({
        type: 'session_list',
        id: 'dev-sessions-refresh',
        timestamp: Date.now(),
        sessions,
      }));
    }

    if (msg.type === 'send_to_session' || msg.type === 'send_instruction') {
      const text = msg.message || '';
      console.log(`💬 Message from phone: "${text.substring(0, 80)}"`);
      console.log('   (In dev-test mode, this would be sent to Kiro. No extension connected.)');
    }

    if (msg.type === 'approval_response') {
      console.log(`✅ Approval response: ${msg.approved ? 'APPROVED' : 'DENIED'}`);
    }
  });

  ws.on('error', e => console.error('WS error:', e.message));
  ws.on('close', () => { console.log('Extension WS closed — relay may have stopped'); });

  // Demo: simulate an approval request after 5s so you can test the modal
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log('\n🔔 Sending demo approval request (test the approve/deny modal)...');
      ws.send(JSON.stringify({
        type: 'approval_request',
        id: 'demo-approval-1',
        timestamp: Date.now(),
        toolName: 'shell',
        command: 'npm run build && npm run deploy:prod',
        context: 'Deploying the latest changes to production',
        timeoutSeconds: 30,
      }));
    }
  }, 5000);

  // Demo: simulate agent running after 10s
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'status_update', id: 'demo-running', timestamp: Date.now(),
        agentState: 'running', currentTask: 'Updating Field Tracking Dashboard',
      }));
      console.log('⚡ Sent demo status: RUNNING');
    }
  }, 10000);

  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'status_update', id: 'demo-idle', timestamp: Date.now(),
        agentState: 'idle',
      }));
      console.log('💤 Sent demo status: IDLE');
    }
  }, 15000);

  process.on('SIGINT', () => {
    console.log('\n👋 Stopping...');
    relay.kill();
    process.exit(0);
  });
})();

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}
