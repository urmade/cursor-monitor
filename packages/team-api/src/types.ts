export type UsageEvent = {
  timestamp: string;
  conversationId?: string;
  userEmail?: string;
  serviceAccountId?: string;
  serviceAccountName?: string;
  cloudAgentId?: string;
  automationId?: string;
  model?: string;
  kind?: string;
  chargedCents?: number;
  teamId?: number;
  [key: string]: unknown;
};

export type UsageEventsRequest = {
  startDate: number;
  endDate: number;
  page: number;
  pageSize: number;
  organizationId?: string;
};

export type UsageEventsResponse = {
  usageEvents?: UsageEvent[];
  events?: UsageEvent[];
  pagination?: {
    numPages?: number;
    currentPage?: number;
    hasNextPage?: boolean;
  };
};

export type TeamApiCredentials =
  | {
      kind: 'team';
      apiKey: string;
    }
  | {
      kind: 'organization';
      apiKey: string;
      organizationId: string;
    };

export type ListUsageResult = {
  events: UsageEvent[];
  pages: number;
  truncated: boolean;
};
