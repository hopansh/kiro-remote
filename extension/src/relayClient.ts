// Pure Node.js WebSocket client — no external dependencies
import * as net from 'net';
import * as crypto from 'crypto';
import { KiroMessage, ApprovalRequestMessage, ApprovalResponseMessage, SendInstructionMessage } from './types';
import { ChatMessage } from './chatWatcher';
import { randomUUID } from 'crypto';

type ApprovalResolver = (approved: boolean) => void;

// Minimal WebSocket frame decoder/encoder for text frames only
function encodeFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; // FIN + text opcode
    header[1] = 0x80 | len; // MASK bit + length
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    // write 8-byte big-endian length (only lower 4 bytes needed for sane messages)
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  // Masking key (4 bytes at end of header)
  const maskOffset = header.length - 4;
  const mask = crypto.randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, masked]);
}

function decodeFrames(buf: Buffer): { text: string; rest: Buffer }[] {
  const results: { text: string; rest: Buffer }[] = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    // const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerEnd = offset + 2;

    if (payloadLen === 126) {
      if (buf.length < headerEnd + 2) break;
      payloadLen = buf.readUInt16BE(headerEnd);
      headerEnd += 2;
    } else if (payloadLen === 127) {
      if (buf.length < headerEnd + 8) break;
      payloadLen = buf.readUInt32BE(headerEnd + 4); // just lower 32 bits
      headerEnd += 8;
    }

    const maskLen = masked ? 4 : 0;
    if (buf.length < headerEnd + maskLen + payloadLen) break;

    const maskKey = masked ? buf.slice(headerEnd, headerEnd + 4) : null;
    const payloadStart = headerEnd + maskLen;
    const payload = buf.slice(payloadStart, payloadStart + payloadLen);

    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    offset = payloadStart + payloadLen;

    if (opcode === 0x01) { // text frame
      results.push({ text: payload.toString('utf8'), rest: buf.slice(offset) });
    } else if (opcode === 0x08) { // close frame
      results.push({ text: '__close__', rest: buf.slice(offset) });
    }
    // ping/pong: ignore
  }
  return results;
}

class NativeWebSocket {
  private socket: net.Socket | null = null;
  private _readyState: number = 0; // CONNECTING
  private buffer: Buffer = Buffer.alloc(0);
  
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  get readyState() { return this._readyState; }

  constructor(url: string) {
    this.connect(url);
  }

  private connect(url: string) {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parseInt(parsed.port || '80', 10);
    const path = parsed.pathname + (parsed.search || '');
    const key = crypto.randomBytes(16).toString('base64');

    this.socket = net.createConnection(port, host, () => {
      const handshake = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        `\r\n`
      ].join('\r\n');
      this.socket!.write(handshake);
    });

    let handshakeDone = false;
    let headerBuf = '';

    this.socket.on('data', (chunk: Buffer) => {
      if (!handshakeDone) {
        headerBuf += chunk.toString('binary');
        const headerEnd = headerBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const statusLine = headerBuf.split('\r\n')[0];
        if (!statusLine.includes('101')) {
          this._readyState = NativeWebSocket.CLOSED;
          this.onerror?.(new Error(`WebSocket handshake failed: ${statusLine}`));
          return;
        }

        handshakeDone = true;
        this._readyState = NativeWebSocket.OPEN;
        // any data after headers
        const afterHeader = chunk.slice(headerBuf.indexOf('\r\n\r\n') + 4 - (headerBuf.length - chunk.toString('binary').length));
        if (afterHeader.length > 0) {
          this.buffer = Buffer.concat([this.buffer, afterHeader]);
          this.processBuffer();
        }
        this.onopen?.();
        return;
      }

      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });

    this.socket.on('close', () => {
      this._readyState = NativeWebSocket.CLOSED;
      this.onclose?.();
    });

    this.socket.on('error', (err: Error) => {
      this._readyState = NativeWebSocket.CLOSED;
      this.onerror?.(err);
    });
  }

  private processBuffer() {
    const frames = decodeFrames(this.buffer);
    for (const { text, rest } of frames) {
      this.buffer = rest;
      if (text === '__close__') {
        this.close();
      } else {
        this.onmessage?.(text);
      }
    }
  }

  send(data: string) {
    if (this._readyState === NativeWebSocket.OPEN && this.socket) {
      this.socket.write(encodeFrame(data));
    }
  }

  close() {
    if (this._readyState === NativeWebSocket.OPEN && this.socket) {
      this._readyState = NativeWebSocket.CLOSING;
      // send close frame
      this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      this.socket.end();
    }
  }
}

export class RelayClient {
  private ws: NativeWebSocket | null = null;
  private pendingApprovals = new Map<string, ApprovalResolver>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  /** Called when the relay asks for a fresh session list (e.g. a phone connected). */
  onRefreshRequest: (() => void) | null = null;
  /** Called when the phone opens a specific session and wants its full history. */
  onRequestSessionHistory: ((sessionId: string, workspacePath: string) => void) | null = null;

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new NativeWebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        console.log('[kiro-remote] Connected to relay server');
        resolve();
      };
      ws.onerror = (err) => {
        console.error('[kiro-remote] WebSocket error:', err.message);
        reject(err);
      };
      ws.onclose = () => {
        console.log('[kiro-remote] Disconnected from relay server');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };
      ws.onmessage = (data: string) => {
        this.onMessage(data);
      };
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(message: KiroMessage) {
    if (this.ws?.readyState === NativeWebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  async sendApprovalRequest(message: ApprovalRequestMessage): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(message.id, resolve);
      this.send(message);

      // Local timeout as safety net (relay also has one)
      setTimeout(() => {
        if (this.pendingApprovals.has(message.id)) {
          this.pendingApprovals.delete(message.id);
          resolve(false); // deny on timeout
        }
      }, (message.timeoutSeconds + 5) * 1000);
    });
  }

  /** Broadcast a Kiro chat message to connected phone(s) */
  sendChatMessage(msg: ChatMessage) {
    const payload: KiroMessage = {
      type: 'chat_message' as any,
      id: msg.id ?? randomUUID(),
      timestamp: msg.timestamp ?? Date.now(),
      role: msg.role,
      text: msg.text,
      sessionId: msg.sessionId,
      sessionTitle: msg.sessionTitle,
    } as any;
    this.send(payload);
  }

  private onMessage(raw: string) {
    try {
      const msg: KiroMessage = JSON.parse(raw);

      if (msg.type === 'approval_response') {
        const response = msg as ApprovalResponseMessage;
        const resolver = this.pendingApprovals.get(response.requestId);
        if (resolver) {
          resolver(response.approved);
          this.pendingApprovals.delete(response.requestId);
        }
      }

      if (msg.type === 'send_instruction') {
        const instruction = msg as SendInstructionMessage;
        void this.submitInstruction(instruction.message);
      }

      if (msg.type === 'send_to_session') {
        const req = msg as any;
        void this.submitToSession(req.sessionId, req.workspacePath, req.message);
      }

      if ((msg as any).type === 'request_refresh') {
        this.onRefreshRequest?.();
      }

      if ((msg as any).type === 'request_session_history') {
        const req = msg as any;
        this.onRequestSessionHistory?.(req.sessionId, req.workspaceKey);
      }
    } catch (e) {
      console.error('[kiro-remote] Failed to parse message:', e);
    }
  }

  private async submitToSession(sessionId: string, workspacePath: string, text: string) {
    console.log(`[kiro-remote] Sending to session ${sessionId}: ${text.substring(0, 50)}`);
    try {
      const { commands } = await import('vscode');
      // kiroAgent.loadSessionWithPrompt(chatSessionId, prompt) — opens the session and sends the message
      await commands.executeCommand('kiroAgent.loadSessionWithPrompt', sessionId, text);
      console.log(`[kiro-remote] Sent to session ${sessionId} via loadSessionWithPrompt`);
      return;
    } catch (e) {
      console.log(`[kiro-remote] loadSessionWithPrompt failed: ${e}, trying focusContinueInput`);
    }

    // Fallback: just focus the chat and submit generically
    await this.submitInstruction(text);
  }

  private async submitInstruction(text: string) {
    console.log('[kiro-remote] Submitting instruction:', text.substring(0, 50));
    // Discovered real commands from Kiro's extension.js:
    // kiroAgent.agent.askAgent — submits to active chat session
    // kiroAgent.executions.queueUserMessage — queues a message to active execution

    const tryCommands: Array<[string, unknown]> = [
      ['kiroAgent.agent.askAgent', text],
      ['kiroAgent.executions.queueUserMessage', { message: text }],
      ['kiroAgent.focusContinueInputWithoutClear', undefined],
    ];

    for (const [cmd, arg] of tryCommands) {
      try {
        const { commands } = await import('vscode');
        if (arg !== undefined) {
          await commands.executeCommand(cmd, arg);
        } else {
          await commands.executeCommand(cmd);
        }
        console.log(`[kiro-remote] Instruction submitted via ${cmd}`);
        return;
      } catch (e) {
        console.log(`[kiro-remote] ${cmd} failed: ${e}`);
      }
    }

    // Last resort: copy to clipboard and notify
    try {
      const { window, env } = await import('vscode');
      await env.clipboard.writeText(text);
      window.showInformationMessage(
        `📱 Message from phone copied to clipboard. Paste into Kiro chat.`,
        'Focus Chat'
      ).then(async action => {
        if (action === 'Focus Chat') {
          const { commands } = await import('vscode');
          try { await commands.executeCommand('kiroAgent.focusChatInput'); } catch { }
        }
      });
    } catch (e) {
      console.error('[kiro-remote] clipboard fallback failed:', e);
    }
  }
}
