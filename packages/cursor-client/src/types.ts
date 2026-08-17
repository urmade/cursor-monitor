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

export type RunGitBranch = {
  repoUrl?: string;
  branch?: string;
  prUrl?: string;
  [key: string]: unknown;
};

export type AgentRun = {
  id: string;
  agentId?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number | null;
  result?: unknown;
  git?: { branches?: RunGitBranch[] };
  [key: string]: unknown;
};

export type AgentUsageRun = {
  id: string;
  usageUuid?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  };
  cost?: {
    rawCostCents?: number;
    chargedCents?: number;
  };
  [key: string]: unknown;
};

/** Normalised usage — flat fields for callers, plus nested live-API shape. */
export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  usageUuid?: string;
  chargedCents?: number;
  rawCostCents?: number;
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  };
  cost?: {
    rawCostCents?: number;
    chargedCents?: number;
  };
  runs?: AgentUsageRun[];
  [key: string]: unknown;
};

export type ListAgentsOptions = {
  limit?: number;
  cursor?: string;
};

export type ListAgentsPage = {
  items: AgentSummary[];
  nextCursor?: string | null;
};

export type ListRunsOptions = {
  limit?: number;
  cursor?: string;
};

export type ListRunsPage = {
  items: AgentRun[];
  nextCursor?: string | null;
};

export type ModelInfo = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

export type AgentRepoRef = {
  url?: string;
  startingRef?: string;
  prUrl?: string;
  [key: string]: unknown;
};

export type AgentSummary = {
  id: string;
  name?: string;
  status?: string;
  url?: string;
  latestRunId?: string;
  createdAt?: string;
  updatedAt?: string;
  repos?: AgentRepoRef[];
  /**
   * Origin of the agent when the API exposes it (e.g. `automations`, `desktop`,
   * `api`). Not always present on Cloud Agents API responses today.
   */
  source?: string;
  /** Automation UUID when this agent was launched by an automation. */
  automationId?: string;
  /** Human automation name when the API exposes it. */
  automationName?: string;
  [key: string]: unknown;
};

/** GET /v1/me — user-scoped keys include identity; service accounts omit user fields. */
export type ApiKeyInfo = {
  apiKeyName?: string;
  createdAt?: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  [key: string]: unknown;
};

export type FilteredUsageEventsRequest = {
  startDate?: number | string;
  endDate?: number | string;
  cloudAgentId?: string;
  automationId?: string;
  /** Organization Admin API (`/organizations/filtered-usage-events`). */
  organizationId?: string;
  teamIds?: number[];
  userId?: number;
  email?: string;
  serviceAccountId?: string;
  page?: number;
  pageSize?: number;
  [key: string]: unknown;
};

export type FilteredUsageEvent = {
  timestamp: string;
  userEmail?: string;
  serviceAccountId?: string;
  serviceAccountName?: string;
  cloudAgentId?: string;
  automationId?: string;
  /** Join key with stop-hook `conversation_id` / other session sources. */
  conversationId?: string;
  model?: string;
  kind?: string;
  chargedCents?: number;
  teamId?: number;
  maxMode?: boolean;
  requestsCosts?: number;
  isTokenBasedCall?: boolean;
  isChargeable?: boolean;
  isHeadless?: boolean;
  cursorTokenFee?: number;
  tokenUsage?: Record<string, unknown>;
  [key: string]: unknown;
};

export type FilteredUsageEventsResponse = {
  totalUsageEventsCount?: number;
  pagination?: {
    numPages?: number;
    currentPage?: number;
    pageSize?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
  usageEvents?: FilteredUsageEvent[];
  /** Legacy alias retained for older fixtures. */
  events?: FilteredUsageEvent[];
  period?: { startDate?: number; endDate?: number };
  [key: string]: unknown;
};

export type AutomationWebhookPayload = {
  ticket_id: string;
  nonce: string;
  stage?: string;
  mcp_url?: string;
  [key: string]: unknown;
};

export type OrganizationMember = {
  userId?: number;
  email?: string;
  name?: string;
  organizationRole?: string;
  teams?: Array<{ teamId?: number; teamRole?: string }>;
  [key: string]: unknown;
};

export type OrganizationMembersResponse = {
  members?: OrganizationMember[];
  pagination?: {
    page?: number;
    pageSize?: number;
    totalCount?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
  organizationId?: string;
  [key: string]: unknown;
};

export type OrganizationGroup = {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type OrganizationGroupsResponse = {
  groups?: OrganizationGroup[];
  pagination?: {
    page?: number;
    pageSize?: number;
    totalCount?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
  organizationId?: string;
  [key: string]: unknown;
};

export type OrganizationPooledUsagePool = {
  limitCents?: number;
  usedCents?: number;
  remainingCents?: number;
  contractStartDate?: string;
  contractEndDate?: string;
  [key: string]: unknown;
};

export type OrganizationPooledUsageResponse = {
  enabled?: boolean;
  pool?: OrganizationPooledUsagePool;
  teams?: Array<{ teamId?: number; usedCents?: number; [key: string]: unknown }>;
  organizationId?: string;
  [key: string]: unknown;
};
