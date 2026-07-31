import { CursorApiError, mapHttpError } from './errors';
import { normalizeAgentUsage } from './usage';
import type {
  AgentRun,
  AgentSummary,
  AgentUsage,
  ApiKeyInfo,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateRunRequest,
  CreateRunResponse,
  ListAgentsOptions,
  ListAgentsPage,
  ListRunsOptions,
  ListRunsPage,
  ModelInfo,
  ModelSelection,
} from './types';

export type CursorClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Initial backoff ms; doubles each retry. Default 250. */
  initialBackoffMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basicAuthHeader(apiKey: string): string {
  const token = Buffer.from(`${apiKey}:`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

/** Cloud Agents API requires `model` as `{ id }` (string form → validation_error). */
function normaliseCreateBody<T extends { model?: ModelSelection | string }>(
  body: T,
): T {
  if (typeof body.model === 'string') {
    return { ...body, model: { id: body.model } };
  }
  return body;
}

export class CursorClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;

  constructor(opts: CursorClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.cursor.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.initialBackoffMs = opts.initialBackoffMs ?? 250;
  }

  async createAgent(body: CreateAgentRequest): Promise<CreateAgentResponse> {
    return this.request<CreateAgentResponse>(
      'POST',
      '/v1/agents',
      normaliseCreateBody(body),
    );
  }

  async createRun(
    agentId: string,
    body: CreateRunRequest,
  ): Promise<CreateRunResponse> {
    return this.request<CreateRunResponse>(
      'POST',
      `/v1/agents/${encodeURIComponent(agentId)}/runs`,
      normaliseCreateBody(body),
    );
  }

  async getRun(agentId: string, runId: string): Promise<AgentRun> {
    return this.request<AgentRun>(
      'GET',
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  async cancelRun(agentId: string, runId: string): Promise<AgentRun> {
    return this.request<AgentRun>(
      'POST',
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }

  async getUsage(agentId: string, runId?: string): Promise<AgentUsage> {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    const raw = await this.request<unknown>(
      'GET',
      `/v1/agents/${encodeURIComponent(agentId)}/usage${qs}`,
    );
    return normalizeAgentUsage(raw);
  }

  async getAgent(agentId: string): Promise<AgentSummary> {
    return this.request<AgentSummary>(
      'GET',
      `/v1/agents/${encodeURIComponent(agentId)}`,
    );
  }

  async getMe(): Promise<ApiKeyInfo> {
    return this.request<ApiKeyInfo>('GET', '/v1/me');
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request<
      { items?: ModelInfo[]; models?: ModelInfo[] } | ModelInfo[]
    >('GET', '/v1/models');
    if (Array.isArray(res)) return res;
    return res.items ?? res.models ?? [];
  }

  async listAgents(opts?: ListAgentsOptions): Promise<ListAgentsPage> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString() ? `?${params}` : '';
    const res = await this.request<
      | { items?: AgentSummary[]; agents?: AgentSummary[]; nextCursor?: string | null }
      | AgentSummary[]
    >('GET', `/v1/agents${qs}`);
    if (Array.isArray(res)) {
      return { items: res, nextCursor: null };
    }
    return {
      items: res.items ?? res.agents ?? [],
      nextCursor: res.nextCursor ?? null,
    };
  }

  /** Page through GET /v1/agents until exhausted or `maxPages` is hit. */
  async listAllAgents(opts?: {
    pageSize?: number;
    maxPages?: number;
  }): Promise<{ items: AgentSummary[]; truncated: boolean }> {
    // API caps page size at 100 — larger values 400. Prefer 100 to cut
    // round-trips roughly in half vs the old default of 50.
    const pageSize = opts?.pageSize ?? 100;
    const maxPages = opts?.maxPages ?? 40;
    const items: AgentSummary[] = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < maxPages; page += 1) {
      const res = await this.listAgents({ limit: pageSize, cursor });
      items.push(...res.items);
      if (!res.nextCursor) {
        return { items, truncated: false };
      }
      cursor = res.nextCursor;
    }
    truncated = true;
    return { items, truncated };
  }

  async listRuns(
    agentId: string,
    opts?: ListRunsOptions,
  ): Promise<ListRunsPage> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString() ? `?${params}` : '';
    const res = await this.request<
      { items?: AgentRun[]; runs?: AgentRun[]; nextCursor?: string | null } | AgentRun[]
    >('GET', `/v1/agents/${encodeURIComponent(agentId)}/runs${qs}`);
    if (Array.isArray(res)) {
      return { items: res, nextCursor: null };
    }
    return {
      items: res.items ?? res.runs ?? [],
      nextCursor: res.nextCursor ?? null,
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: basicAuthHeader(this.apiKey),
            Accept: 'application/json',
            ...(body !== undefined
              ? { 'Content-Type': 'application/json' }
              : {}),
            ...(init?.headers ?? {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          ...init,
        });

        const text = await res.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = text;
          }
        }

        if (res.ok) {
          return parsed as T;
        }

        const err = mapHttpError(res.status, parsed);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === this.maxRetries) {
          throw err;
        }
        lastError = err;
      } catch (err) {
        if (err instanceof CursorApiError && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
        if (attempt === this.maxRetries) {
          if (err instanceof CursorApiError) throw err;
          throw new CursorApiError({
            message: err instanceof Error ? err.message : 'network error',
            status: 0,
            code: 'network_error',
            body: err,
          });
        }
      }

      const backoff = this.initialBackoffMs * 2 ** attempt;
      await sleep(backoff);
      attempt += 1;
    }

    throw lastError instanceof Error
      ? lastError
      : new CursorApiError({
          message: 'request failed',
          status: 0,
          code: 'network_error',
        });
  }
}

export function createCursorClient(opts: CursorClientOptions): CursorClient {
  return new CursorClient(opts);
}
