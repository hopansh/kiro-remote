export type MessageType =
  // Extension → Relay → Phone
  | 'status_update'
  | 'approval_request'
  | 'task_started'
  | 'task_completed'
  | 'tool_used'
  | 'session_info'
  | 'chat_message'
  | 'session_list'

  // Phone → Relay → Extension
  | 'approval_response'
  | 'send_instruction'
  | 'send_to_session'
  | 'request_session_history' // phone → extension: fetch a specific session's history

  // Relay → Extension
  | 'request_refresh'     // relay → extension: phone connected, resend state

  // Internal
  | 'ping'
  | 'pong'
  | 'error';

export interface BaseMessage {
  type: MessageType;
  id: string;          // uuid, for correlating approval request/response
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
  command: string;         // the shell command Kiro wants to run
  toolName: string;        // e.g. "shell", "write", "read"
  context?: string;        // surrounding context if available
  timeoutSeconds: number;  // how long phone has to respond before auto-deny
  options?: Array<{ id: string; label: string }>; // multi-choice question options
}

export interface ApprovalResponseMessage extends BaseMessage {
  type: 'approval_response';
  requestId: string;       // matches the ApprovalRequestMessage.id
  approved: boolean;
  answer?: string;         // chosen option label for multi-choice questions
  note?: string;           // optional message from user
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
