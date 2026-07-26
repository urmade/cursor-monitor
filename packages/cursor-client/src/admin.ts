import { CursorClient, type CursorClientOptions } from './client';
import type {
  FilteredUsageEventsRequest,
  FilteredUsageEventsResponse,
} from './types';

/**
 * Admin API client. Uses a team-scoped Admin API key.
 * `filteredUsageEvents` may return 401 on non-Enterprise / insufficient tiers.
 */
export class CursorAdminClient extends CursorClient {
  constructor(opts: CursorClientOptions) {
    super(opts);
  }

  async filteredUsageEvents(
    body: FilteredUsageEventsRequest,
  ): Promise<FilteredUsageEventsResponse> {
    return this.request<FilteredUsageEventsResponse>(
      'POST',
      '/teams/filtered-usage-events',
      body,
    );
  }
}

export function createCursorAdminClient(
  opts: CursorClientOptions,
): CursorAdminClient {
  return new CursorAdminClient(opts);
}
