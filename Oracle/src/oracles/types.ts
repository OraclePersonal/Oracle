export interface OracleProfile {
  name: string;
  skill: string;
  description?: string;
  model?: string;
  provider?: string;
  memory?: boolean;
  systemPrompt?: string;
}

export interface MemoryEntry {
  summary: string;
  sessionId: string;
  prompt: string;
  createdAt: string;
}

export interface Workshop {
  name: string;
  oracles: string[];
  include: string[];
  exclude: string[];
}
