import { CursorClient, type CursorClientOptions } from './client';
import type {
  FilteredUsageEvent,
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

  /**
   * Page through filtered usage events until exhausted or `maxPages` is hit.
   * Prefers `usageEvents`, falls back to legacy `events`.
   */
  async listAllFilteredUsageEvents(
    body: Omit<FilteredUsageEventsRequest, 'page' | 'pageSize'>,
    opts?: { pageSize?: number; maxPages?: number },
  ): Promise<{ items: FilteredUsageEvent[]; truncated: boolean }> {
    const pageSize = opts?.pageSize ?? 1000;
    const maxPages = opts?.maxPages ?? 20;
    const items: FilteredUsageEvent[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const res = await this.filteredUsageEvents({
        ...body,
        page,
        pageSize,
      });
      const batch = res.usageEvents ?? res.events ?? [];
      items.push(...batch);
      const hasNext =
        res.pagination?.hasNextPage === true ||
        (res.pagination?.numPages != null &&
          page < res.pagination.numPages);
      if (!hasNext || batch.length === 0) {
        return { items, truncated: false };
      }
    }
    return { items, truncated: true };
  }
}

export function createCursorAdminClient(
  opts: CursorClientOptions,
): CursorAdminClient {
  return new CursorAdminClient(opts);
}
