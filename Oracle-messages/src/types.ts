export const MESSAGE_KINDS = ["message", "request", "response", "event", "note", "question", "review-request", "proposal", "end"] as const;
export const ACK_STATUSES = ["received", "accepted", "completed", "rejected", "failed"] as const;
export const TASK_STATUSES = ["pending", "assigned", "in_progress", "completed", "failed", "cancelled"] as const;
export const PRESENCE_STATUSES = ["online", "busy", "idle", "offline"] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type AckStatus = (typeof ACK_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export interface Message {
  id: string;
  ts: string;
  sender: string;
  recipient: string;
  kind: MessageKind;
  body: string;
  subject?: string;
  parent_id?: string;
  in_reply_to?: string;
  channel?: string;
  meta?: Record<string, unknown>;
  expires_at?: string;
}

export interface Acknowledgement {
  message_id: string;
  agent: string;
  status: AckStatus;
  ts: string;
  note?: string;
}

export interface AgentRegistration {
  agent: string;
  client?: string;
  role?: string;
  group?: string;
  capabilities: string[];
  registered_at: string;
  last_seen_at: string;
  meta?: Record<string, unknown>;
}

export interface AgentCard {
  agent: string;
  name?: string;
  description?: string;
  contact?: string;
  channels: string[];
  meta?: Record<string, unknown>;
  updated_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  sender: string;
  created_at: string;
  updated_at: string;
  meta?: Record<string, unknown>;
}

export interface Subscription {
  agent: string;
  channel: string;
  subscribed_at: string;
}

export interface Cursor {
  agent: string;
  message_id: string;
  ts: string;
}

export interface Session {
  id: string;
  agent: string;
  joined_at: string;
  last_active_at: string;
}

export interface Thread {
  root?: Message;
  replies: Message[];
}

export interface MailboxStats {
  total_messages: number;
  total_agents: number;
  oldest_message_ts: string | null;
  newest_message_ts: string | null;
}

export interface PruneResult {
  messages_removed: number;
  reads_removed: number;
  acknowledgements_removed: number;
  expired_removed?: number;
}

export interface MessageFilter {
  agent?: string;
  sender?: string;
  kind?: MessageKind;
  channel?: string;
  limit?: number;
  query?: string;
}

export interface SendInput {
  sender: string;
  recipient: string;
  body: string;
  kind?: MessageKind;
  subject?: string;
  parent_id?: string;
  in_reply_to?: string;
  channel?: string;
  meta?: Record<string, unknown>;
  ttl_seconds?: number;
}

export interface PresenceRecord {
  agent: string;
  status: PresenceStatus;
  since: string;
  updated_at: string;
}

export interface Reaction {
  message_id: string;
  agent: string;
  emoji: string;
  ts: string;
}

export interface Webhook {
  agent: string;
  url: string;
  created_at: string;
  meta?: Record<string, unknown>;
}
