export type MessageType =
  // Extension → Relay → Phone
  | 'status_update'       // agent is idle/running/waiting
  | 'approval_request'    // Kiro wants to run a command, needs yes/no
  | 'task_started'        // a spec task just began
  | 'task_completed'      // a spec task just finished
  | 'tool_used'           // post-tool-use notification
  | 'session_info'        // sent to phone on connect (session metadata)

  // Phone → Relay → Extension
  | 'approval_response'   // user approved or denied a command
  | 'send_instruction'    // user typed a message to send to Kiro agent

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
}

export interface ApprovalResponseMessage extends BaseMessage {
  type: 'approval_response';
  requestId: string;       // matches the ApprovalRequestMessage.id
  approved: boolean;
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
