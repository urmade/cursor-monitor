import { afterEach, describe, expect, it, vi } from 'vitest';

const getMe = vi.fn();
const filteredUsageEvents = vi.fn();

vi.mock('@nexus/cursor-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexus/cursor-client')>();
  return {
    ...actual,
    createCursorClient: () => ({ getMe }),
    createCursorAdminClient: () => ({ filteredUsageEvents }),
  };
});

import {
  isUserScopedApiKey,
  probeTeamApiKey,
  probeUserApiKey,
} from './probe-api-key';

describe('isUserScopedApiKey', () => {
  it('detects user identity fields', () => {
    expect(isUserScopedApiKey({ userEmail: 'a@example.com' })).toBe(true);
    expect(isUserScopedApiKey({ userId: 12 })).toBe(true);
    expect(isUserScopedApiKey({ apiKeyName: 'CI' })).toBe(false);
    expect(isUserScopedApiKey(null)).toBe(false);
  });
});

describe('probeUserApiKey', () => {
  afterEach(() => {
    getMe.mockReset();
    filteredUsageEvents.mockReset();
  });

  it('accepts a user-scoped /v1/me response', async () => {
    getMe.mockResolvedValue({
      apiKeyName: 'Personal',
      userEmail: 'dev@example.com',
    });
    const result = await probeUserApiKey({
      apiKey: 'cursor_user_key_long_enough_xx',
      baseUrl: 'https://api.cursor.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.kind).toBe('user');
    expect(result.identity).toMatch(/dev@example.com/);
  });

  it('rejects a service-account / team identity on the User path', async () => {
    getMe.mockResolvedValue({ apiKeyName: 'CI bot' });
    const result = await probeUserApiKey({
      apiKey: 'cursor_team_key_long_enough_xx',
      baseUrl: 'https://api.cursor.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/Team API key/);
  });
});

describe('probeTeamApiKey', () => {
  afterEach(() => {
    getMe.mockReset();
    filteredUsageEvents.mockReset();
  });

  it('rejects user-scoped keys before calling the usage API', async () => {
    getMe.mockResolvedValue({
      apiKeyName: 'Personal',
      userEmail: 'dev@example.com',
    });
    const result = await probeTeamApiKey({
      apiKey: 'cursor_user_key_long_enough_xx',
      baseUrl: 'https://api.cursor.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.looksLikeUserKey).toBe(true);
    expect(filteredUsageEvents).not.toHaveBeenCalled();
  });

  it('accepts keys that can call /teams/filtered-usage-events', async () => {
    getMe.mockRejectedValue(new Error('401 Invalid API key'));
    filteredUsageEvents.mockResolvedValue({
      totalUsageEventsCount: 4,
      usageEvents: [{ timestamp: '1', chargedCents: 1 }],
    });
    const result = await probeTeamApiKey({
      apiKey: 'cursor_team_admin_key_xxxxxx',
      baseUrl: 'https://api.cursor.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.kind).toBe('team');
    expect(result.note).toMatch(/usage events accepted/);
    expect(filteredUsageEvents).toHaveBeenCalled();
  });

  it('rejects Invalid Team API Key from the usage API', async () => {
    getMe.mockRejectedValue(new Error('401'));
    filteredUsageEvents.mockRejectedValue(
      new Error('401 Invalid Team API Key'),
    );
    const result = await probeTeamApiKey({
      apiKey: 'cursor_user_key_long_enough_xx',
      baseUrl: 'https://api.cursor.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.looksLikeUserKey).toBe(true);
    expect(result.error).toMatch(/Not a Team API key/);
  });
});
