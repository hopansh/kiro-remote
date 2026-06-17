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

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

// ── Simple in-memory rate limiter ────────────────────────────────
// Tracks request counts per IP per window to prevent brute-force token guessing.
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;  // 1 minute window
const RATE_MAX       = 30;      // max 30 requests per IP per minute on auth endpoints

function checkRateLimit(ip: string): boolean {
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
    });
  });

  // ── Hook routes — require token (used by shell scripts on localhost) ──
  app.post('/hook/pre-tool-use',  requireToken, hookPreToolUse);
  app.post('/hook/post-tool-use', requireToken, hookPostToolUse);
  app.post('/hook/task-start',    requireToken, hookTaskStart);
  app.post('/hook/task-complete', requireToken, hookTaskComplete);

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

  // Pending approvals map
  const pendingApprovals = new Map<string, PendingApproval>();

  // HTTP server
  const httpServer = http.createServer(app);

  // WebSocket server
  const wss = new WebSocket.Server({ noServer: true });

  let extensionWs: WebSocket.WebSocket | null = null;
  const mobileClients = new Set<WebSocket.WebSocket>();

  let lastSessionList: KiroMessage | null = null;
  const recentChatMessages: KiroMessage[] = [];

  function broadcastToMobile(message: KiroMessage) {
    if (message.type === 'session_list') {
      lastSessionList = message;
    } else if (message.type === 'chat_message') {
      recentChatMessages.push(message);
      if (recentChatMessages.length > 200) recentChatMessages.shift();
    }
    const payload = JSON.stringify(message);
    for (const client of mobileClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function sendToExtension(message: KiroMessage) {
    if (extensionWs?.readyState === WebSocket.OPEN) {
      extensionWs.send(JSON.stringify(message));
    }
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
      extensionWs = ws;
      if (session) session.extensionConnected = true;
      rlog('ws', '🔌 Extension connected');

      ws.on('message', (data: WebSocket.RawData) => {
        // Enforce message size limit (1 MB)
        if (data.toString().length > 1_048_576) {
          rlog('ws', 'Extension message too large — dropping');
          return;
        }
        try {
          const msg: KiroMessage = JSON.parse(data.toString());
          handleExtensionMessage(msg);
        } catch (e) {
          rlog('ws', `Failed to parse extension message: ${e}`);
        }
      });

      ws.on('close', () => {
        extensionWs = null;
        if (session) session.extensionConnected = false;
        rlog('ws', '🔌 Extension disconnected');
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
        }));
      }
      if (lastSessionList) {
        ws.send(JSON.stringify(lastSessionList));
      }
      for (const m of recentChatMessages) {
        ws.send(JSON.stringify(m));
      }
      if (extensionWs?.readyState === WebSocket.OPEN) {
        extensionWs.send(JSON.stringify({
          type: 'request_refresh',
          id: randomUUID(),
          timestamp: Date.now(),
        }));
      }

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

  function handleExtensionMessage(msg: KiroMessage) {
    if (msg.type === 'approval_request') {
      const req = msg as ApprovalRequestMessage;
      broadcastToMobile(req);
      const timer = setTimeout(() => {
        const pending = pendingApprovals.get(req.id);
        if (pending) {
          pendingApprovals.delete(req.id);
          pending.resolve(false);
          sendToExtension({
            type: 'approval_response',
            id: randomUUID(),
            timestamp: Date.now(),
            requestId: req.id,
            approved: false,
            note: 'Auto-denied: timeout',
          } as ApprovalResponseMessage);
        }
      }, req.timeoutSeconds * 1000);

      pendingApprovals.set(req.id, {
        resolve: (_approved: boolean) => {
          clearTimeout(timer);
          pendingApprovals.delete(req.id);
        },
        timeout: timer,
      });
    } else {
      broadcastToMobile(msg);
    }
  }

  function handleMobileMessage(msg: KiroMessage) {
    if (msg.type === 'approval_response') {
      const response = msg as ApprovalResponseMessage;
      const pending = pendingApprovals.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingApprovals.delete(response.requestId);
        pending.resolve(response.approved);
      }
      sendToExtension(response);
    } else if (
      msg.type === 'send_instruction' ||
      msg.type === 'send_to_session' ||
      msg.type === 'request_session_history'
    ) {
      sendToExtension(msg);
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

    const requestId = randomUUID();
    const approvalMsg: ApprovalRequestMessage = {
      type: 'approval_request',
      id: requestId,
      timestamp: Date.now(),
      command: JSON.stringify(payload.tool_input ?? {}),
      toolName: payload.tool_name ?? 'unknown',
      timeoutSeconds: 60,
    };
    broadcastToMobile(approvalMsg);

    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(requestId);
        resolve(false);
      }, 60_000);
      pendingApprovals.set(requestId, { resolve, timeout: timer });
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
