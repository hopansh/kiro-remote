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
}

export interface ApprovalResponseMessage extends BaseMessage {
  type: 'approval_response';
  requestId: string;
  approved: boolean;
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
  | ErrorMessage;
