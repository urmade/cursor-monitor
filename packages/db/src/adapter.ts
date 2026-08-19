export type JsonObject = Record<string, unknown>;

export type DatabaseAdapterInfo = {
  readonly id: string;
  readonly displayName: string;
};

export type HookEventSummary = {
  id: string;
  eventName: string;
  conversationId: string | null;
  conversationKey: string | null;
  generationId: string | null;
  repositoryKey: string | null;
  repositoryLabel: string | null;
  gitBranch: string | null;
  workspaceRoot: string | null;
  userEmail: string | null;
  model: string | null;
  status: string | null;
  durationMs: number | null;
  occurredAt: Date;
  receivedAt: Date;
};

export type NewHookEvent = HookEventSummary & {
  payload: JsonObject;
};

export type HookEventPayload = {
  id: string;
  payload: JsonObject;
};

export type UsageEventSummary = {
  fingerprint: string;
  conversationId: string | null;
  conversationKey: string | null;
  userEmail: string | null;
  model: string | null;
  kind: string | null;
  chargedCents: number | null;
  occurredAt: Date;
};

export type NewUsageEvent = UsageEventSummary & {
  teamId: number | null;
  payload: JsonObject;
  fetchedAt: Date;
};

export type RepositoryPreferenceRecord = {
  repositoryKey: string;
  displayName: string | null;
  mergedIntoKey: string | null;
};

export type RepositoryMergeDecision = {
  source: string;
  targetRoot: string;
};

export type ConversationPreferenceRecord = {
  conversationKey: string;
  displayName: string;
};

export type BranchPreferenceRecord = {
  repositoryKey: string;
  branchKey: string;
  displayName: string;
};

export type SyncRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export type SyncRunRecord = {
  id: string;
  source: string;
  status: SyncRunStatus;
  windowStartedAt: Date;
  windowEndedAt: Date;
  fetchedCount: number;
  insertedCount: number;
  pages: number;
  truncated: boolean;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
};

export type NewSyncRun = {
  id: string;
  source: string;
  status: SyncRunStatus;
  windowStartedAt: Date;
  windowEndedAt: Date;
  fetchedCount?: number;
  insertedCount?: number;
  pages?: number;
  truncated?: boolean;
  error?: string | null;
  startedAt?: Date;
  completedAt?: Date | null;
};

export type SyncRunUpdate = Partial<
  Pick<
    SyncRunRecord,
    | 'status'
    | 'fetchedCount'
    | 'insertedCount'
    | 'pages'
    | 'truncated'
    | 'error'
    | 'completedAt'
  >
>;

export type SyncLeaseAttempt = {
  source: string;
  ownerId: string;
  now: Date;
  expiresAt: Date;
};

export interface DatabaseAdapter {
  readonly info: DatabaseAdapterInfo;

  ping(): Promise<boolean>;
  close(): Promise<void>;

  readonly hooks: {
    insert(event: NewHookEvent): Promise<string | null>;
    listRecent(limit: number): Promise<HookEventSummary[]>;
    listPayloads(ids: readonly string[]): Promise<HookEventPayload[]>;
    count(): Promise<number>;
  };

  readonly usage: {
    insertDeduplicated(events: readonly NewUsageEvent[]): Promise<number>;
    listRecent(limit: number): Promise<UsageEventSummary[]>;
    count(): Promise<number>;
  };

  readonly repositoryPreferences: {
    list(): Promise<RepositoryPreferenceRecord[]>;
    setDisplayName(
      repositoryKey: string,
      displayName: string | null,
      updatedAt: Date,
    ): Promise<void>;
    merge(
      decide: (
        current: readonly RepositoryPreferenceRecord[],
      ) => RepositoryMergeDecision,
      updatedAt: Date,
    ): Promise<RepositoryMergeDecision>;
    clearMerge(repositoryKey: string, updatedAt: Date): Promise<void>;
  };

  readonly conversationPreferences: {
    list(): Promise<ConversationPreferenceRecord[]>;
    setDisplayName(
      conversationKey: string,
      displayName: string,
      updatedAt: Date,
    ): Promise<void>;
    delete(conversationKey: string): Promise<void>;
  };

  readonly branchPreferences: {
    list(repositoryKey: string): Promise<BranchPreferenceRecord[]>;
    setDisplayName(
      preference: BranchPreferenceRecord,
      updatedAt: Date,
    ): Promise<void>;
    delete(repositoryKey: string, branchKey: string): Promise<void>;
  };

  readonly sync: {
    latestSuccessfulWindowEnd(source: string): Promise<Date | null>;
    insertRun(run: NewSyncRun): Promise<void>;
    updateRun(id: string, update: SyncRunUpdate): Promise<void>;
    listRecentRuns(limit: number): Promise<SyncRunRecord[]>;
    tryAcquireLease(attempt: SyncLeaseAttempt): Promise<boolean>;
    releaseLease(source: string, ownerId: string): Promise<void>;
  };
}
