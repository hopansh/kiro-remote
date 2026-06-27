// Shared message types — copy of relay-server/src/types.ts

export type MessageType =
  | 'status_update'
  | 'approval_request'
  | 'task_started'
  | 'task_completed'
  | 'tool_used'
  | 'session_info'
  | 'approval_response'
  | 'send_instruction'
  | 'chat_message'
  | 'session_list'        // extension → phone: full list of all sessions
  | 'send_to_session'     // phone → extension: open session + send message
  | 'request_refresh'     // relay → extension: phone connected, resend state
  | 'request_session_history' // phone → extension: fetch a specific session's history
  | 'ping'
  | 'pong'
  | 'error';

export interface BaseMessage {
  type: MessageType;
  id: string;
  timestamp: number;
}

export interface StatusUpdateMessage extends BaseMessage {
  type: 'status_update';
  agentState: 'idle' | 'running' | 'waiting_approval';
  currentTask?: string;
  workspaceName?: string;
}

export interface ApprovalRequestMessage extends BaseMessage {
  type: 'approval_request';
  command: string;
  toolName: string;
  context?: string;
  timeoutSeconds: number;
  /** For multi-choice questions (e.g. Kiro's userInput) — render as buttons. */
  options?: Array<{ id: string; label: string }>;
}

export interface ApprovalResponseMessage extends BaseMessage {
  type: 'approval_response';
  requestId: string;
  approved: boolean;
  /** Chosen option label for multi-choice questions (overrides approved mapping). */
  answer?: string;
  note?: string;
}

export interface TaskEventMessage extends BaseMessage {
  type: 'task_started' | 'task_completed';
  taskName: string;
  taskIndex: number;
  totalTasks?: number;
  specName?: string;
}

export interface ToolUsedMessage extends BaseMessage {
  type: 'tool_used';
  toolName: string;
  toolInput: Record<string, unknown>;
  success: boolean;
}

export interface SendInstructionMessage extends BaseMessage {
  type: 'send_instruction';
  message: string;
}

export interface SessionInfoMessage extends BaseMessage {
  type: 'session_info';
  sessionId: string;
  machineName: string;
  workspaceName?: string;
  connectedAt: number;
}

export interface PingMessage extends BaseMessage {
  type: 'ping';
}

export interface PongMessage extends BaseMessage {
  type: 'pong';
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  message: string;
}

export interface KiroSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  workspaceName: string;
  workspaceKey: string;
  dateCreated: number;
  messageCount: number;
  lastMessage?: string;
}

export interface SessionListMessage extends BaseMessage {
  type: 'session_list';
  sessions: KiroSession[];
}

export interface SendToSessionMessage extends BaseMessage {
  type: 'send_to_session';
  sessionId: string;
  workspacePath: string;
  message: string;
}

export interface ChatMessageMessage extends BaseMessage {
  type: 'chat_message';
  role: 'user' | 'assistant' | 'tool';
  text: string;
  sessionId: string;
  sessionTitle: string;
  /** true for live "thinking"/reasoning bubbles (rendered muted on the phone). */
  thinking?: boolean;
}

export interface RequestRefreshMessage extends BaseMessage {
  type: 'request_refresh';
}

export interface RequestSessionHistoryMessage extends BaseMessage {
  type: 'request_session_history';
  sessionId: string;
  workspaceKey: string;
}

export type KiroMessage =
  | StatusUpdateMessage
  | ApprovalRequestMessage
  | ApprovalResponseMessage
  | TaskEventMessage
  | ToolUsedMessage
  | SendInstructionMessage
  | SessionInfoMessage
  | PingMessage
  | PongMessage
  | ErrorMessage
  | SessionListMessage
  | SendToSessionMessage
  | ChatMessageMessage
  | RequestRefreshMessage
  | RequestSessionHistoryMessage;
