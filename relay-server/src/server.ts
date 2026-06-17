import express, { Request, Response } from 'express';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import cors from 'cors';
import { SessionManager } from './session';
import {
  KiroMessage,
  ApprovalRequestMessage,
  ApprovalResponseMessage,
  ToolUsedMessage,
  TaskEventMessage,
  SendInstructionMessage,
} from './types';
import { randomUUID } from 'crypto';
import { rlog } from './log';

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export function createServer(sessionManager: SessionManager) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const mobileUiDir = path.join(__dirname, '..', '..', 'mobile-ui');

  // HTTP routes
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

  app.get('/health', (_req: Request, res: Response) => {
    const session = sessionManager.get();
    res.json({
      status: 'ok',
      sessionId: session?.id ?? null,
      token: session?.token ?? null,
      connected: {
        extension: session?.extensionConnected ?? false,
        mobile: session?.mobileConnected ?? false,
      },
    });
  });

  app.get('/session/:token', (req: Request, res: Response) => {
    const { token } = req.params;
    if (!sessionManager.isValid(token)) {
      res.status(401).json({ error: 'Invalid or expired session token' });
      return;
    }
    const session = sessionManager.get()!;
    res.json({
      sessionId: session.id,
      machineName: os.hostname(),
      connectedAt: Date.now(),
    });
  });

  // Pending approvals map
  const pendingApprovals = new Map<string, PendingApproval>();

  // HTTP server
  const httpServer = http.createServer(app);

  // WebSocket server (handles both /extension and /mobile paths)
  const wss = new WebSocket.Server({ noServer: true });

  // Track connected clients
  let extensionWs: WebSocket.WebSocket | null = null;
  const mobileClients = new Set<WebSocket.WebSocket>();

  // Cache the most recent session list so we can replay it to a phone the
  // instant it connects (avoids waiting for the next 10s refresh).
  let lastSessionList: KiroMessage | null = null;
  // Buffer recent chat messages so a newly-connected phone sees history.
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

  // Handle upgrade (route to extension or mobile WS handler)
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    rlog('ws', `Upgrade request: ${url.pathname} from ${request.socket.remoteAddress}`);

    if (url.pathname === '/extension') {
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit('connection', ws, request, 'extension');
      });
    } else if (url.pathname === '/mobile') {
      const token = url.searchParams.get('token') ?? '';
      const session = sessionManager.get();
      const expected = session?.token ?? '(no session)';
      const valid = sessionManager.isValid(token);
      rlog('ws', `Mobile connect attempt. token="${token}" expected="${expected}" valid=${valid}`);
      if (!valid) {
        rlog('ws', `REJECTED mobile connection — token mismatch or expired`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit('connection', ws, request, 'mobile');
      });
    } else {
      rlog('ws', `Unknown upgrade path: ${url.pathname} — destroying socket`);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket.WebSocket, _request: http.IncomingMessage, role: string) => {
    const session = sessionManager.get();

    if (role === 'extension') {
      extensionWs = ws;
      if (session) session.extensionConnected = true;
      console.log('🔌 Extension connected');

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg: KiroMessage = JSON.parse(data.toString());
          handleExtensionMessage(msg);
        } catch (e) {
          console.error('Failed to parse extension message:', e);
        }
      });

      ws.on('close', () => {
        extensionWs = null;
        if (session) session.extensionConnected = false;
        console.log('🔌 Extension disconnected');
      });

    } else if (role === 'mobile') {
      mobileClients.add(ws);
      if (session) session.mobileConnected = true;
      rlog('ws', `📱 Mobile client connected (total: ${mobileClients.size})`);

      // Send session info on connect
      if (session) {
        const sessionInfo: KiroMessage = {
          type: 'session_info',
          id: randomUUID(),
          timestamp: Date.now(),
          sessionId: session.id,
          machineName: os.hostname(),
          connectedAt: Date.now(),
        };
        ws.send(JSON.stringify(sessionInfo));
      }

      // Replay cached session list immediately so the phone shows data at once.
      if (lastSessionList) {
        ws.send(JSON.stringify(lastSessionList));
        rlog('ws', `Replayed cached session_list to new mobile`);
      }
      // Replay buffered chat history.
      for (const m of recentChatMessages) {
        ws.send(JSON.stringify(m));
      }
      // Ask the extension to refresh the session list now (in case it changed).
      if (extensionWs?.readyState === WebSocket.OPEN) {
        extensionWs.send(JSON.stringify({ type: 'request_refresh', id: randomUUID(), timestamp: Date.now() }));
      }

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg: KiroMessage = JSON.parse(data.toString());
          handleMobileMessage(msg);
        } catch (e) {
          console.error('Failed to parse mobile message:', e);
        }
      });

      ws.on('close', () => {
        mobileClients.delete(ws);
        if (session && mobileClients.size === 0) session.mobileConnected = false;
        rlog('ws', `📱 Mobile client disconnected (remaining: ${mobileClients.size})`);
      });
    }
  });

  function handleExtensionMessage(msg: KiroMessage) {
    if (msg.type === 'approval_request') {
      const req = msg as ApprovalRequestMessage;
      // Forward to phone
      broadcastToMobile(req);
      // Set up timeout
      const timer = setTimeout(() => {
        const pending = pendingApprovals.get(req.id);
        if (pending) {
          pendingApprovals.delete(req.id);
          pending.resolve(false);
          // Notify extension of auto-deny
          const response: ApprovalResponseMessage = {
            type: 'approval_response',
            id: randomUUID(),
            timestamp: Date.now(),
            requestId: req.id,
            approved: false,
            note: 'Auto-denied: timeout',
          };
          sendToExtension(response);
        }
      }, req.timeoutSeconds * 1000);

      pendingApprovals.set(req.id, {
        resolve: (approved: boolean) => {
          clearTimeout(timer);
          pendingApprovals.delete(req.id);
        },
        timeout: timer,
      });
    } else {
      // Forward all other extension messages to mobile (status_update, task_*, tool_used)
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
    } else if (msg.type === 'send_instruction' || msg.type === 'send_to_session'
               || (msg as { type: string }).type === 'request_session_history') {
      // Forward to extension
      sendToExtension(msg);
    } else if (msg.type === 'ping') {
      const pong: KiroMessage = { type: 'pong', id: (msg as { id: string }).id, timestamp: Date.now() };
      broadcastToMobile(pong);
    }
  }

  // Hook routes — called by shell scripts
  app.post('/hook/pre-tool-use', async (req: Request, res: Response) => {
    const payload = req.body as {
      hook_event_name?: string;
      tool_name?: string;
      tool_input?: Record<string, unknown>;
    };

    if (mobileClients.size === 0) {
      // No phone connected — allow through
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

    // Wait for response
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(requestId);
        resolve(false);
      }, 60000);

      pendingApprovals.set(requestId, { resolve, timeout: timer });
    });

    res.json({
      action: approved ? 'allow' : 'deny',
      reason: approved ? undefined : 'Denied by remote user',
    });
  });

  app.post('/hook/post-tool-use', (req: Request, res: Response) => {
    const payload = req.body as {
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      success?: boolean;
    };

    const msg: ToolUsedMessage = {
      type: 'tool_used',
      id: randomUUID(),
      timestamp: Date.now(),
      toolName: payload.tool_name ?? 'unknown',
      toolInput: payload.tool_input ?? {},
      success: payload.success ?? true,
    };
    broadcastToMobile(msg);
    res.json({ ok: true });
  });

  app.post('/hook/task-start', (req: Request, res: Response) => {
    const payload = req.body as {
      task_name?: string;
      task_index?: number;
      total_tasks?: number;
      spec_name?: string;
    };

    const msg: TaskEventMessage = {
      type: 'task_started',
      id: randomUUID(),
      timestamp: Date.now(),
      taskName: payload.task_name ?? 'Unknown task',
      taskIndex: payload.task_index ?? 0,
      totalTasks: payload.total_tasks,
      specName: payload.spec_name,
    };
    broadcastToMobile(msg);
    res.json({ ok: true });
  });

  app.post('/hook/task-complete', (req: Request, res: Response) => {
    const payload = req.body as {
      task_name?: string;
      task_index?: number;
      total_tasks?: number;
      spec_name?: string;
    };

    const msg: TaskEventMessage = {
      type: 'task_completed',
      id: randomUUID(),
      timestamp: Date.now(),
      taskName: payload.task_name ?? 'Unknown task',
      taskIndex: payload.task_index ?? 0,
      totalTasks: payload.total_tasks,
      specName: payload.spec_name,
    };
    broadcastToMobile(msg);
    res.json({ ok: true });
  });

  return httpServer;
}
