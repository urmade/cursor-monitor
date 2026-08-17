import type {
  ListUsageResult,
  TeamApiCredentials,
  UsageEvent,
  UsageEventsResponse,
} from './types';

export class TeamApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TeamApiError';
  }
}

export type TeamApiClientOptions = {
  credentials: TeamApiCredentials;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
};

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TeamApiClient {
  private readonly credentials: TeamApiCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(options: TeamApiClientOptions) {
    this.credentials = options.credentials;
    this.baseUrl = (options.baseUrl ?? 'https://api.cursor.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 45_000;
  }

  async listUsageEvents(options: {
    startDate: number;
    endDate: number;
    pageSize?: number;
    maxPages?: number;
    deadlineAt?: number;
  }): Promise<ListUsageResult> {
    const pageSize = options.pageSize ?? 1000;
    const maxPages = options.maxPages ?? 20;
    const events: UsageEvent[] = [];
    const deadline = options.deadlineAt ?? Date.now() + this.totalTimeoutMs;

    for (let page = 1; page <= maxPages; page += 1) {
      if (Date.now() >= deadline) {
        throw new TeamApiError('Cursor Team API sync exceeded its deadline', 0);
      }
      const response = await this.requestPage({
        startDate: options.startDate,
        endDate: options.endDate,
        page,
        pageSize,
      }, deadline);
      const batch = response.usageEvents ?? response.events ?? [];
      events.push(...batch);
      const hasNext =
        response.pagination?.hasNextPage === true ||
        (response.pagination?.numPages != null &&
          page < response.pagination.numPages);
      if (!hasNext || batch.length === 0) {
        return { events, pages: page, truncated: false };
      }
    }

    return { events, pages: maxPages, truncated: true };
  }

  private async requestPage(body: {
    startDate: number;
    endDate: number;
    page: number;
    pageSize: number;
  }, deadline: number): Promise<UsageEventsResponse> {
    const organization =
      this.credentials.kind === 'organization'
        ? { organizationId: this.credentials.organizationId }
        : {};
    const path =
      this.credentials.kind === 'organization'
        ? '/organizations/filtered-usage-events'
        : '/teams/filtered-usage-events';

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new TeamApiError('Cursor Team API sync exceeded its deadline', 0);
      }
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(this.credentials.apiKey),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...body, ...organization }),
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(this.requestTimeoutMs, remaining)),
          ),
        });
        const text = await response.text();
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (response.ok) return parsed as UsageEventsResponse;

        const message =
          parsed && typeof parsed === 'object' && 'message' in parsed
            ? String((parsed as { message: unknown }).message)
            : `Cursor Team API returned ${response.status}`;
        const error = new TeamApiError(message, response.status);
        if (
          (response.status !== 429 && response.status < 500) ||
          attempt === this.maxRetries
        ) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (error instanceof TeamApiError && error.status > 0) throw error;
        lastError = error;
        if (attempt === this.maxRetries) break;
      }
      if (Date.now() >= deadline) break;
      await sleep(250 * 2 ** attempt);
    }

    throw new TeamApiError(
      lastError instanceof Error ? lastError.message : 'Cursor Team API request failed',
      0,
    );
  }
}

export function credentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TeamApiCredentials | null {
  const organizationKey = env.CURSOR_ORGANIZATION_API_KEY?.trim();
  const organizationId = env.CURSOR_ORGANIZATION_ID?.trim();
  if (organizationKey && organizationId) {
    return {
      kind: 'organization',
      apiKey: organizationKey,
      organizationId,
    };
  }
  const teamKey = env.CURSOR_TEAM_API_KEY?.trim();
  return teamKey ? { kind: 'team', apiKey: teamKey } : null;
}
