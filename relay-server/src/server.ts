import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import cors from 'cors';
import { SessionManager } from './session';
import {
  KiroMessage,
  ApprovalRequestMessage,
  ApprovalResponseMessage,
  ToolUsedMessage,
  TaskEventMessage,
} from './types';
import { randomUUID } from 'crypto';
import { rlog } from './log';
import { initPush, getPublicKey, addSubscription, sendPush } from './push';

// Approval timeout (seconds) — single source shared by the WS approval path and
// the hook approval path, so both behave consistently. Provided by the
// extension via env (mirrors kiroRemote.approvalTimeoutSeconds).
const APPROVAL_TIMEOUT_SEC = parseInt(process.env.KIRO_REMOTE_APPROVAL_TIMEOUT ?? '60', 10);

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
  key: string;
}

// ── Simple in-memory rate limiter ────────────────────────────────
// Tracks request counts per IP per window to prevent brute-force token guessing.
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;  // 1 minute window
const RATE_MAX       = 30;      // max 30 requests per IP per minute on auth endpoints

function isLoopback(ip: string): boolean {
  const clean = ip.replace('::ffff:', '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

function checkRateLimit(ip: string): boolean {
  // Loopback is the local extension itself — never throttle it. The limiter
  // exists to stop remote brute-force of the token, not local polling.
  if (isLoopback(ip)) return true;
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true; // allowed
  }
  entry.count++;
  if (entry.count > RATE_MAX) return false; // blocked
  return true;
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60_000);

// ── Constant-time token comparison ──────────────────────────────
// Prevents timing attacks when comparing tokens.
function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function createServer(sessionManager: SessionManager) {
  const app = express();

  // Restrict CORS to same-origin and the Cloudflare tunnel (no wildcard).
  // The tunnel origin is unknown at startup so we validate dynamically.
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, mobile app PWA, same-origin)
      if (!origin) return callback(null, true);
      // Allow localhost
      if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        return callback(null, true);
      }
      // Allow trycloudflare.com tunnel origins (HTTPS only)
      if (origin.endsWith('.trycloudflare.com') && origin.startsWith('https://')) {
        return callback(null, true);
      }
      // Allow local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      const localNet = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin);
      if (localNet) return callback(null, true);
      return callback(new Error('CORS: origin not allowed'));
    },
    credentials: true,
  }));

  // Body parser with size limit to prevent DoS via large payloads
  app.use(express.json({ limit: '64kb' }));

  // Tunnel URL — set after cloudflared connects
  let tunnelUrl: string | null = null;

  // Initialize Web Push (VAPID). Safe no-op if it can't init.
  initPush();

  // ── Request logging ───────────────────────────────────────────
  app.use((req: Request, _res: Response, next: NextFunction) => {
    rlog('http', `${req.method} ${req.path} from ${req.ip}`);
    next();
  });

  const mobileUiDir = path.join(__dirname, '..', '..', 'mobile-ui');

  // ── Middleware: require token for all non-static, non-health routes ──
  // Token can be passed as query param (?token=X) or Authorization header (Bearer X)
  function requireToken(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip ?? 'unknown';

    // Rate limit auth attempts per IP
    if (!checkRateLimit(ip)) {
      rlog('auth', `Rate limit exceeded for ${ip}`);
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const session = sessionManager.get();
    if (!session) {
      res.status(503).json({ error: 'No active session' });
      return;
    }

    const queryToken = req.query['token'] as string | undefined;
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const provided = queryToken ?? bearerToken ?? '';

    if (!provided || !safeTokenCompare(provided, session.token)) {
      rlog('auth', `Rejected request from ${ip} — bad token`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  }

  // ── Static files (no auth — these are needed to load the PWA) ──
  // The PWA itself requires a token to connect via WebSocket, so serving
  // the HTML is safe — it's just a shell with no sensitive data.
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(mobileUiDir, 'index.html'));
  });
  app.get('/manifest.json', (_req: Request, res: Response) => {
    res.sendFile(path.join(mobileUiDir, 'manifest.json'));
  });
  app.get('/sw.js', (_req: Request, res: Response) => {
    res.sendFile(path.join(mobileUiDir, 'sw.js'));
  });
  app.get('/icon-192.png', (_req: Request, res: Response) => {
    res.sendFile(path.join(mobileUiDir, 'icon-192.png'));
  });

  // ── Health — LOCAL ONLY (token is sensitive, never expose over tunnel) ──
  // Only responds to loopback. Remote callers get 403.
  app.get('/health', (req: Request, res: Response) => {
    const ip = req.ip ?? '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const session = sessionManager.get();
    res.json({
      status: 'ok',
      sessionId: session?.id ?? null,
      token: session?.token ?? null,
      build: process.env.KIRO_REMOTE_BUILD ?? '',
      tunnelUrl: tunnelUrl ?? null,
      connected: {
        extension: session?.extensionConnected ?? false,
        mobile: session?.mobileConnected ?? false,
      },
    });
  });

  // ── Session validation — rate-limited, no token leakage ──
  app.get('/session/:token', (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    const { token } = req.params;
    const session = sessionManager.get();
    if (!session || !safeTokenCompare(token, session.token)) {
      // Always check if session is expired too
      if (session && Date.now() > session.expiresAt) {
        res.status(401).json({ error: 'Session expired' });
      } else {
        res.status(401).json({ error: 'Invalid session token' });
      }
      return;
    }
    // Don't leak token or session internals — return minimal info
    res.json({
      machineName: os.hostname(),
      connectedAt: Date.now(),
      expiresAt: session.expiresAt,
      approvalTimeoutSeconds: APPROVAL_TIMEOUT_SEC,
    });
  });

  // ── Hook routes — require token (used by shell scripts on localhost) ──
  app.post('/hook/pre-tool-use',  requireToken, hookPreToolUse);
  app.post('/hook/post-tool-use', requireToken, hookPostToolUse);
  app.post('/hook/task-start',    requireToken, hookTaskStart);
  app.post('/hook/task-complete', requireToken, hookTaskComplete);

  // ── Web Push routes — token-protected ──
  app.get('/push/vapid-public-key', requireToken, (_req: Request, res: Response) => {
    const key = getPublicKey();
    if (!key) { res.status(503).json({ error: 'Push not available' }); return; }
    res.json({ publicKey: key });
  });
  app.post('/push/subscribe', requireToken, (req: Request, res: Response) => {
    const sub = req.body as { endpoint?: string };
    if (!sub?.endpoint) { res.status(400).json({ error: 'Invalid subscription' }); return; }
    addSubscription(sub as Parameters<typeof addSubscription>[0]);
    res.json({ ok: true });
  });

  // ── Catch-all 404 — don't leak route info ──
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Error handler ─────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err.message?.startsWith('CORS:')) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    rlog('error', `Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Pending approvals map (unified: shared by WS approvals + hook approvals)
  const pendingApprovals = new Map<string, PendingApproval>();
  // Dedup: tool+command -> requestId currently awaiting a decision, so the
  // poll-based and hook-based paths don't show two modals for the same action.
  const inFlightApprovalKey = new Map<string, string>();

  // HTTP server
  const httpServer = http.createServer(app);

  // WebSocket server
  const wss = new WebSocket.Server({ noServer: true });

  // Multiple Kiro windows can each connect an extension socket. We keep them all
  // and route appropriately (see sendToExtension / sendToPrimaryExtension).
  const extensionClients = new Set<WebSocket.WebSocket>();
  // Per-extension reported state, so we can broadcast an AGGREGATE status to the
  // phone (most active wins) instead of letting windows clobber each other.
  const extensionState = new Map<WebSocket.WebSocket, 'idle' | 'running' | 'waiting_approval'>();
  const mobileClients = new Set<WebSocket.WebSocket>();

  let lastSessionList: KiroMessage | null = null;
  let lastAggregateStatus: 'idle' | 'running' | 'waiting_approval' = 'idle';
  const recentChatMessages: KiroMessage[] = [];

  function broadcastToMobile(message: KiroMessage) {
    if (message.type === 'session_list') {
      lastSessionList = message;
    } else if (message.type === 'chat_message') {
      // Keep the replay buffer to ONE entry per id (latest text wins), so a
      // newly-connected phone gets the current version without partial dupes.
      // We always forward to connected phones below — the phone dedups/updates
      // by id itself, and on-demand history replay MUST reach the phone even if
      // the same id was streamed live earlier this session.
      const id = (message as { id: string }).id;
      const existingIdx = recentChatMessages.findIndex(
        m => m.type === 'chat_message' && (m as { id: string }).id === id
      );
      if (existingIdx >= 0) {
        recentChatMessages[existingIdx] = message;
      } else {
        recentChatMessages.push(message);
        if (recentChatMessages.length > 200) recentChatMessages.shift();
      }
    }
    const payload = JSON.stringify(message);
    for (const client of mobileClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Send to ALL connected extensions (e.g. approval responses; each extension
   *  ignores ones it doesn't have a pending request for). */
  function sendToExtension(message: KiroMessage) {
    const payload = JSON.stringify(message);
    for (const ws of extensionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Send to ONE extension only (e.g. instructions / session loads) so the
   *  action isn't executed in every open window. */
  function sendToPrimaryExtension(message: KiroMessage) {
    for (const ws of extensionClients) {
      if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(message)); return; }
    }
  }

  /** Recompute and broadcast the aggregate agent status across all windows. */
  function recomputeAggregateStatus(template?: KiroMessage) {
    let agg: 'idle' | 'running' | 'waiting_approval' = 'idle';
    for (const s of extensionState.values()) {
      if (s === 'waiting_approval') { agg = 'waiting_approval'; break; }
      if (s === 'running') agg = 'running';
    }
    if (agg === lastAggregateStatus) return;
    lastAggregateStatus = agg;
    const base = template as { currentTask?: string; workspaceName?: string } | undefined;
    broadcastToMobile({
      type: 'status_update',
      id: randomUUID(),
      timestamp: Date.now(),
      agentState: agg,
      currentTask: agg === 'idle' ? undefined : base?.currentTask,
      workspaceName: base?.workspaceName,
    } as KiroMessage);
  }

  // ── WebSocket upgrade — auth at the transport layer ───────────
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const clientIp = (request.socket.remoteAddress ?? 'unknown').replace('::ffff:', '');
    rlog('ws', `Upgrade: ${url.pathname} from ${clientIp}`);

    if (url.pathname === '/extension') {
      // Extension only accepts connections from loopback
      if (clientIp !== '127.0.0.1' && clientIp !== '::1') {
        rlog('ws', `REJECTED /extension from non-local IP ${clientIp}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit('connection', ws, request, 'extension');
      });

    } else if (url.pathname === '/mobile') {
      // Rate-limit mobile connection attempts
      if (!checkRateLimit(clientIp)) {
        rlog('ws', `REJECTED /mobile from ${clientIp} — rate limited`);
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') ?? '';
      const session = sessionManager.get();
      const valid = session != null && safeTokenCompare(token, session.token) && !sessionManager.isExpired();
      rlog('ws', `Mobile connect: valid=${valid} from ${clientIp}`);
      if (!valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit('connection', ws, request, 'mobile');
      });

    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket.WebSocket, _request: http.IncomingMessage, role: string) => {
    const session = sessionManager.get();

    if (role === 'extension') {
      extensionClients.add(ws);
      if (session) session.extensionConnected = true;
      rlog('ws', `🔌 Extension connected (total: ${extensionClients.size})`);

      ws.on('message', (data: WebSocket.RawData) => {
        // Enforce message size limit (1 MB)
        if (data.toString().length > 1_048_576) {
          rlog('ws', 'Extension message too large — dropping');
          return;
        }
        try {
          const msg: KiroMessage = JSON.parse(data.toString());
          handleExtensionMessage(msg, ws);
        } catch (e) {
          rlog('ws', `Failed to parse extension message: ${e}`);
        }
      });

      ws.on('close', () => {
        extensionClients.delete(ws);
        extensionState.delete(ws);
        if (session) session.extensionConnected = extensionClients.size > 0;
        recomputeAggregateStatus();
        rlog('ws', `🔌 Extension disconnected (remaining: ${extensionClients.size})`);
      });

    } else if (role === 'mobile') {
      mobileClients.add(ws);
      if (session) session.mobileConnected = true;
      rlog('ws', `📱 Mobile connected (total: ${mobileClients.size})`);

      if (session) {
        ws.send(JSON.stringify({
          type: 'session_info',
          id: randomUUID(),
          timestamp: Date.now(),
          sessionId: session.id,
          machineName: os.hostname(),
          connectedAt: Date.now(),
          expiresAt: session.expiresAt,
          approvalTimeoutSeconds: APPROVAL_TIMEOUT_SEC,
        }));
      }
      if (lastSessionList) {
        ws.send(JSON.stringify(lastSessionList));
      }
      for (const m of recentChatMessages) {
        ws.send(JSON.stringify(m));
      }
      // Ask one window to resend its state (sessions + history) for this phone.
      sendToPrimaryExtension({
        type: 'request_refresh',
        id: randomUUID(),
        timestamp: Date.now(),
      } as KiroMessage);

      ws.on('message', (data: WebSocket.RawData) => {
        // Enforce message size limit (64 KB for phone messages)
        if (data.toString().length > 65_536) {
          rlog('ws', 'Mobile message too large — dropping');
          return;
        }
        try {
          const msg: KiroMessage = JSON.parse(data.toString());
          handleMobileMessage(msg);
        } catch (e) {
          rlog('ws', `Failed to parse mobile message: ${e}`);
        }
      });

      ws.on('close', () => {
        mobileClients.delete(ws);
        if (session && mobileClients.size === 0) session.mobileConnected = false;
        rlog('ws', `📱 Mobile disconnected (remaining: ${mobileClients.size})`);
      });
    }
  });

  // ── Unified approval coordinator ──────────────────────────────
  // Both the WS approval path (extension's ApprovalWatcher) and the hook path
  // (/hook/pre-tool-use) funnel through here, so behaviour + timeout are
  // identical and duplicate prompts for the same action are coalesced.
  function registerApproval(req: ApprovalRequestMessage, onResolve: (approved: boolean) => void) {
    const key = `${req.toolName}|${req.command}`;

    // If an identical action is already awaiting a decision, attach to it
    // instead of showing a second modal/notification.
    const existingId = inFlightApprovalKey.get(key);
    if (existingId && pendingApprovals.has(existingId)) {
      const existing = pendingApprovals.get(existingId)!;
      const prev = existing.resolve;
      existing.resolve = (approved: boolean) => { prev(approved); onResolve(approved); };
      rlog('approval', `Coalesced duplicate approval for ${key} → ${existingId}`);
      return;
    }

    const timeout = setTimeout(() => {
      const pending = pendingApprovals.get(req.id);
      if (pending) {
        pendingApprovals.delete(req.id);
        inFlightApprovalKey.delete(key);
        pending.resolve(false); // auto-deny
      }
    }, req.timeoutSeconds * 1000);

    pendingApprovals.set(req.id, {
      key,
      timeout,
      resolve: (approved: boolean) => {
        clearTimeout(timeout);
        pendingApprovals.delete(req.id);
        if (inFlightApprovalKey.get(key) === req.id) inFlightApprovalKey.delete(key);
        onResolve(approved);
      },
    });
    inFlightApprovalKey.set(key, req.id);

    // Broadcast to the phone (live modal) + push notification (backgrounded).
    broadcastToMobile(req);
    void sendPush({
      type: 'approval_request',
      toolName: req.toolName,
      command: req.command?.substring(0, 200),
      requestId: req.id,
    });
  }

  function resolveApproval(requestId: string, approved: boolean): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    pending.resolve(approved);
    return true;
  }

  function handleExtensionMessage(msg: KiroMessage, fromWs?: WebSocket.WebSocket) {
    if (msg.type === 'approval_request') {
      const req = msg as ApprovalRequestMessage;
      // Route the phone's decision back to the extension that asked.
      registerApproval(req, (approved) => {
        sendToExtension({
          type: 'approval_response',
          id: randomUUID(),
          timestamp: Date.now(),
          requestId: req.id,
          approved,
          note: undefined,
        } as ApprovalResponseMessage);
      });
    } else if (msg.type === 'status_update') {
      // Track per-window state and broadcast the aggregate (most active wins).
      if (fromWs) {
        extensionState.set(fromWs, (msg as { agentState: 'idle' | 'running' | 'waiting_approval' }).agentState);
      }
      recomputeAggregateStatus(msg);
    } else {
      broadcastToMobile(msg);
    }
  }

  function handleMobileMessage(msg: KiroMessage) {
    if (msg.type === 'approval_response') {
      const response = msg as ApprovalResponseMessage;
      const handled = resolveApproval(response.requestId, response.approved);
      // Fallback: if we had no pending record (e.g. already timed out), still
      // forward so an extension waiting on its own local timeout can settle.
      if (!handled) sendToExtension(response);
    } else if (
      msg.type === 'send_instruction' ||
      msg.type === 'send_to_session' ||
      msg.type === 'request_session_history'
    ) {
      // Route to a single window so the action isn't duplicated across windows.
      sendToPrimaryExtension(msg);
    } else if (msg.type === 'ping') {
      broadcastToMobile({ type: 'pong', id: (msg as { id: string }).id, timestamp: Date.now() } as KiroMessage);
    }
  }

  // ── Hook handlers ─────────────────────────────────────────────
  async function hookPreToolUse(req: Request, res: Response) {
    const payload = req.body as {
      tool_name?: string;
      tool_input?: Record<string, unknown>;
    };

    if (mobileClients.size === 0) {
      res.json({ action: 'allow' });
      return;
    }

    const approvalMsg: ApprovalRequestMessage = {
      type: 'approval_request',
      id: randomUUID(),
      timestamp: Date.now(),
      command: JSON.stringify(payload.tool_input ?? {}),
      toolName: payload.tool_name ?? 'unknown',
      timeoutSeconds: APPROVAL_TIMEOUT_SEC,
    };

    // Same unified path (broadcast + push + dedup + timeout) as WS approvals.
    const approved = await new Promise<boolean>((resolve) => {
      registerApproval(approvalMsg, resolve);
    });

    res.json({
      action: approved ? 'allow' : 'deny',
      reason: approved ? undefined : 'Denied by remote user',
    });
  }

  function hookPostToolUse(req: Request, res: Response) {
    const p = req.body as { tool_name?: string; tool_input?: Record<string, unknown>; success?: boolean };
    broadcastToMobile({
      type: 'tool_used',
      id: randomUUID(),
      timestamp: Date.now(),
      toolName: p.tool_name ?? 'unknown',
      toolInput: p.tool_input ?? {},
      success: p.success ?? true,
    } as ToolUsedMessage);
    res.json({ ok: true });
  }

  function hookTaskStart(req: Request, res: Response) {
    const p = req.body as { task_name?: string; task_index?: number; total_tasks?: number; spec_name?: string };
    broadcastToMobile({
      type: 'task_started',
      id: randomUUID(),
      timestamp: Date.now(),
      taskName: p.task_name ?? 'Unknown task',
      taskIndex: p.task_index ?? 0,
      totalTasks: p.total_tasks,
      specName: p.spec_name,
    } as TaskEventMessage);
    res.json({ ok: true });
  }

  function hookTaskComplete(req: Request, res: Response) {
    const p = req.body as { task_name?: string; task_index?: number; total_tasks?: number; spec_name?: string };
    broadcastToMobile({
      type: 'task_completed',
      id: randomUUID(),
      timestamp: Date.now(),
      taskName: p.task_name ?? 'Unknown task',
      taskIndex: p.task_index ?? 0,
      totalTasks: p.total_tasks,
      specName: p.spec_name,
    } as TaskEventMessage);
    res.json({ ok: true });
  }

  (httpServer as any).setTunnelUrl = (url: string) => { tunnelUrl = url; };

  return httpServer;
}

declare module 'http' {
  interface Server {
    setTunnelUrl?: (url: string) => void;
  }
}
