export type McpServerConfig = {
  name: string;
  type: 'http' | 'stdio' | string;
  url?: string;
  headers?: Record<string, string>;
};

export type ModelSelection = {
  id: string;
  params?: Array<{ id: string; value: string }>;
};

export type CreateAgentRequest = {
  agentId?: string;
  name?: string;
  prompt: { text: string };
  model?: ModelSelection | string;
  repos?: Array<{ url: string; startingRef?: string }>;
  autoCreatePR?: boolean;
  mcpServers?: McpServerConfig[];
};

/** Raw API shape from POST /v1/agents */
export type CreateAgentResponse = {
  agent: {
    id: string;
    name?: string;
    status?: string;
    url?: string;
    latestRunId?: string;
    [key: string]: unknown;
  };
  run: {
    id: string;
    agentId?: string;
    status?: string;
    [key: string]: unknown;
  };
};

export type CreateRunRequest = {
  prompt: { text: string };
  model?: ModelSelection | string;
  mcpServers?: McpServerConfig[];
};

export type CreateRunResponse = {
  id: string;
  status?: string;
  [key: string]: unknown;
};

export type AgentRun = {
  id: string;
  status: string;
  durationMs?: number | null;
  result?: unknown;
  git?: { branches?: unknown[] };
  [key: string]: unknown;
};

export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  usageUuid?: string;
  chargedCents?: number;
  rawCostCents?: number;
  [key: string]: unknown;
};

export type ModelInfo = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

export type AgentSummary = {
  id: string;
  name?: string;
  createdAt?: string;
  [key: string]: unknown;
};

export type FilteredUsageEventsRequest = {
  startDate?: string;
  endDate?: string;
  cloudAgentId?: string;
  automationId?: string;
  page?: number;
  pageSize?: number;
  [key: string]: unknown;
};

export type FilteredUsageEventsResponse = {
  events?: Array<{
    chargedCents?: number;
    tokenUsage?: unknown;
    model?: string;
    cloudAgentId?: string;
    automationId?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type AutomationWebhookPayload = {
  ticket_id: string;
  nonce: string;
  stage?: string;
  mcp_url?: string;
  [key: string]: unknown;
};
