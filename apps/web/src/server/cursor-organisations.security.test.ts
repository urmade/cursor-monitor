import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireSession,
  currentUser,
  discoverOrganizationId,
  upsertCursorOrganisation,
  addCursorOrganisationApiKey,
  deleteCursorOrganisation,
  deleteAllCursorOrganisations,
  revokeCursorOrganisationApiKey,
  listCursorOrganisations,
  listDbOrganisationViews,
  invalidateMonitoringCache,
  cookiesDelete,
  cookiesSet,
  cookiesGet,
  kvSet,
  kvGet,
  kvDel,
} = vi.hoisted(() => ({
  requireSession: vi.fn(),
  currentUser: vi.fn(),
  discoverOrganizationId: vi.fn(),
  upsertCursorOrganisation: vi.fn(),
  addCursorOrganisationApiKey: vi.fn(),
  deleteCursorOrganisation: vi.fn(),
  deleteAllCursorOrganisations: vi.fn(),
  revokeCursorOrganisationApiKey: vi.fn(),
  listCursorOrganisations: vi.fn(),
  listDbOrganisationViews: vi.fn(),
  invalidateMonitoringCache: vi.fn(),
  cookiesDelete: vi.fn(),
  cookiesSet: vi.fn(),
  cookiesGet: vi.fn(),
  kvSet: vi.fn(),
  kvGet: vi.fn(),
  kvDel: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    delete: cookiesDelete,
    set: cookiesSet,
    get: cookiesGet,
  })),
}));

vi.mock('./session', () => ({
  requireSession: (...args: unknown[]) => requireSession(...args),
}));

vi.mock('./identity', () => ({
  currentUser: (...args: unknown[]) => currentUser(...args),
}));

vi.mock('./monitoring-cache', () => ({
  invalidateMonitoringCache: (...args: unknown[]) =>
    invalidateMonitoringCache(...args),
  credentialFingerprint: (key: string) => `fp:${key.slice(0, 8)}`,
}));

vi.mock('./cursor', () => ({
  combinedCredentialFingerprint: (fingerprints: string[]) => {
    const sorted = [...fingerprints].filter(Boolean).sort();
    if (sorted.length === 0) return '';
    if (sorted.length === 1) return sorted[0];
    return `combined:${sorted.join('|')}`;
  },
  formatApiKeyIdentity: () => 'test-identity',
}));

vi.mock('@nexus/cursor-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexus/cursor-client')>();
  return {
    ...actual,
    discoverOrganizationId: (...args: unknown[]) =>
      discoverOrganizationId(...args),
    createCursorClient: () => ({
      getMe: vi.fn(async () => ({ apiKeyName: 'test' })),
    }),
    createCursorOrgClient: () => ({
      pooledUsage: vi.fn(async () => ({ pool: { usedCents: 1 } })),
    }),
    createCursorAdminClient: () => ({
      filteredOrgUsageEvents: vi.fn(async () => ({
        totalUsageEventsCount: 0,
        usageEvents: [],
      })),
    }),
  };
});

vi.mock('@nexus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexus/core')>();
  return {
    ...actual,
    upsertCursorOrganisation: (...args: unknown[]) =>
      upsertCursorOrganisation(...args),
    addCursorOrganisationApiKey: (...args: unknown[]) =>
      addCursorOrganisationApiKey(...args),
    deleteCursorOrganisation: (...args: unknown[]) =>
      deleteCursorOrganisation(...args),
    deleteAllCursorOrganisations: (...args: unknown[]) =>
      deleteAllCursorOrganisations(...args),
    revokeCursorOrganisationApiKey: (...args: unknown[]) =>
      revokeCursorOrganisationApiKey(...args),
    listCursorOrganisations: (...args: unknown[]) =>
      listCursorOrganisations(...args),
    listCursorOrganisationViews: (...args: unknown[]) =>
      listDbOrganisationViews(...args),
    kvSet: (...args: unknown[]) => kvSet(...args),
    kvGet: (...args: unknown[]) => kvGet(...args),
    kvDel: (...args: unknown[]) => kvDel(...args),
  };
});

const {
  actionDiscoverOrganizationId,
  actionUpsertCursorOrganisation,
  actionAddCursorOrganisationApiKey,
  actionRemoveCursorOrganisation,
  actionRemoveCursorOrganisationApiKey,
  actionRemoveAllCursorOrganisations,
  listCursorOrganisationViews,
} = await import('./cursor-organisations');
const { actionConnectCursorApiKey } = await import('./cursor-credentials');
const { clearCursorOrganisations, readCursorOrganisations } = await import(
  './cursor-org-store'
);

function sessionStub(orgId = 'nexus-org-1') {
  return {
    user: { externalSub: 'sub', rawClaims: {} },
    userId: 'user-1',
    orgId,
    ctx: {
      orgId,
      actor: { kind: 'human' as const, userId: 'user-1' },
      db: {},
      clock: () => new Date('2026-01-01T00:00:00Z'),
      flags: { enabled: async () => false },
    },
  };
}

function expectNoKvApis(): void {
  expect(kvSet).not.toHaveBeenCalled();
  expect(kvGet).not.toHaveBeenCalled();
  expect(kvDel).not.toHaveBeenCalled();
}

describe('organisation server-boundary security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSession.mockResolvedValue(sessionStub());
    currentUser.mockResolvedValue({ externalSub: 'sub', rawClaims: {} });
    listCursorOrganisations.mockResolvedValue([]);
    listDbOrganisationViews.mockResolvedValue([]);
    invalidateMonitoringCache.mockResolvedValue(undefined);
    cookiesGet.mockReturnValue(undefined);
  });

  it('requires a session before organisation-id discovery (no outbound)', async () => {
    requireSession.mockRejectedValue(new Error('Unauthenticated'));
    const fd = new FormData();
    fd.set('orgApiKey', 'crsr_org_key_long_enough_xx');
    fd.set('baseUrl', 'https://api.cursor.com');

    await expect(actionDiscoverOrganizationId(fd)).rejects.toThrow(
      /Unauthenticated/,
    );
    expect(discoverOrganizationId).not.toHaveBeenCalled();
  });

  it('rolls back a new org when first-key attach fails and does not clear cookies', async () => {
    discoverOrganizationId.mockResolvedValue({
      organizationId: null,
      note: 'could not discover',
    });
    upsertCursorOrganisation.mockResolvedValue({
      ok: true,
      value: {
        id: 'new-org-id',
        organizationId: null,
        label: 'Acme',
      },
    });
    addCursorOrganisationApiKey.mockResolvedValue({
      ok: false,
      error: { message: 'duplicate fingerprint' },
    });
    deleteCursorOrganisation.mockResolvedValue({ ok: true, value: undefined });

    const fd = new FormData();
    fd.set('label', 'Acme');
    fd.set('apiKey', 'cursor_team_key_long_enough_x');
    fd.set('baseUrl', 'https://api.cursor.com');

    const result = await actionUpsertCursorOrganisation(fd);
    expect(result).toEqual({ ok: false, error: 'duplicate fingerprint' });
    expect(deleteCursorOrganisation).toHaveBeenCalledWith(
      expect.anything(),
      'new-org-id',
    );
    expect(cookiesDelete).not.toHaveBeenCalled();
    expect(cookiesSet).not.toHaveBeenCalled();
    expectNoKvApis();
  });

  it('clears legacy cookies only after a team key was durably saved (no KV mirror)', async () => {
    discoverOrganizationId.mockResolvedValue({
      organizationId: null,
      note: 'could not discover',
    });
    upsertCursorOrganisation.mockResolvedValue({
      ok: true,
      value: {
        id: 'org-1',
        organizationId: null,
        label: 'Acme',
      },
    });
    addCursorOrganisationApiKey.mockResolvedValue({
      ok: true,
      value: { id: 'key-1', fingerprint: 'fp1' },
    });
    listCursorOrganisations.mockResolvedValue([]);

    const fd = new FormData();
    fd.set('label', 'Acme');
    fd.set('apiKey', 'cursor_team_key_long_enough_x');
    fd.set('baseUrl', 'https://api.cursor.com');

    const result = await actionUpsertCursorOrganisation(fd);
    expect(result.ok).toBe(true);
    expect(cookiesDelete).toHaveBeenCalled();
    expect(cookiesSet).not.toHaveBeenCalled();
    expectNoKvApis();
  });

  it('does not clear cookies when upsert saves metadata without a team key', async () => {
    upsertCursorOrganisation.mockResolvedValue({
      ok: true,
      value: {
        id: 'org-1',
        organizationId: 'org_abc',
        label: 'Acme',
      },
    });
    listCursorOrganisations.mockResolvedValue([]);

    const fd = new FormData();
    fd.set('label', 'Acme');
    fd.set('organizationId', 'org_abc');
    fd.set('baseUrl', 'https://api.cursor.com');

    const result = await actionUpsertCursorOrganisation(fd);
    expect(result.ok).toBe(true);
    expect(addCursorOrganisationApiKey).not.toHaveBeenCalled();
    expect(cookiesDelete).not.toHaveBeenCalled();
    expectNoKvApis();
  });

  it('settings actions never write Admin keys to KV outside the DB', async () => {
    upsertCursorOrganisation.mockResolvedValue({
      ok: true,
      value: {
        id: 'org-1',
        organizationId: 'org_abc',
        label: 'Acme',
      },
    });
    addCursorOrganisationApiKey.mockResolvedValue({
      ok: true,
      value: { id: 'key-1', fingerprint: 'fp1' },
    });
    listCursorOrganisations.mockResolvedValue([]);
    discoverOrganizationId.mockResolvedValue({
      organizationId: null,
      note: null,
    });

    const upsertFd = new FormData();
    upsertFd.set('label', 'Acme');
    upsertFd.set('organizationId', 'org_abc');
    upsertFd.set('orgApiKey', 'crsr_org_admin_key_xxxxxxx');
    upsertFd.set('apiKey', 'cursor_team_key_long_enough_x');
    upsertFd.set('baseUrl', 'https://api.cursor.com');
    expect((await actionUpsertCursorOrganisation(upsertFd)).ok).toBe(true);

    const addFd = new FormData();
    addFd.set('organisationId', 'org-1');
    addFd.set('apiKey', 'cursor_team_key_long_enough_y');
    listDbOrganisationViews.mockResolvedValue([
      {
        id: 'org-1',
        label: 'Acme',
        organizationId: 'org_abc',
        baseUrl: 'https://api.cursor.com',
        hasOrgApiKey: false,
        orgApiKeyHint: null,
        canManage: true,
        canRemove: true,
        keys: [],
      },
    ]);
    expect((await actionAddCursorOrganisationApiKey(addFd)).ok).toBe(true);

    revokeCursorOrganisationApiKey.mockResolvedValue({
      ok: true,
      value: undefined,
    });
    expect((await actionRemoveCursorOrganisationApiKey('key-1')).ok).toBe(true);

    deleteCursorOrganisation.mockResolvedValue({ ok: true, value: undefined });
    expect((await actionRemoveCursorOrganisation('org-1')).ok).toBe(true);

    deleteAllCursorOrganisations.mockResolvedValue({ ok: true, value: 0 });
    expect((await actionRemoveAllCursorOrganisations()).ok).toBe(true);

    expectNoKvApis();
  });

  it('propagates remove/revoke authorization failures without side effects', async () => {
    revokeCursorOrganisationApiKey.mockResolvedValue({
      ok: false,
      error: {
        message: 'Only the member who attached this API key can revoke it',
      },
    });
    deleteCursorOrganisation.mockResolvedValue({
      ok: false,
      error: {
        message:
          'Only the member who created this organisation connection can remove it',
      },
    });
    deleteAllCursorOrganisations.mockResolvedValue({
      ok: false,
      error: {
        message: 'Only signed-in users can manage Cursor credentials',
      },
    });

    expect(await actionRemoveCursorOrganisationApiKey('key-1')).toEqual({
      ok: false,
      error: 'Only the member who attached this API key can revoke it',
    });
    expect(await actionRemoveCursorOrganisation('org-1')).toEqual({
      ok: false,
      error:
        'Only the member who created this organisation connection can remove it',
    });
    expect(await actionRemoveAllCursorOrganisations()).toEqual({
      ok: false,
      error: 'Only signed-in users can manage Cursor credentials',
    });
    expect(invalidateMonitoringCache).not.toHaveBeenCalled();
    expect(cookiesDelete).not.toHaveBeenCalled();
    expectNoKvApis();
  });

  it('invalidates old and new combined caches when a key is revoked', async () => {
    listDbOrganisationViews.mockResolvedValue([
      {
        id: 'org-1',
        label: 'Acme',
        organizationId: 'org_abc',
        baseUrl: 'https://api.cursor.com',
        hasOrgApiKey: false,
        orgApiKeyHint: null,
        canManage: true,
        canRemove: true,
        keys: [
          {
            id: 'key-a',
            fingerprint: 'fp-a',
            label: 'A',
            keyKind: 'user',
            hint: 'a',
            identityLabel: null,
            canRemove: true,
          },
          {
            id: 'key-b',
            fingerprint: 'fp-b',
            label: 'B',
            keyKind: 'user',
            hint: 'b',
            identityLabel: null,
            canRemove: true,
          },
        ],
      },
    ]);
    revokeCursorOrganisationApiKey.mockResolvedValue({
      ok: true,
      value: undefined,
    });

    expect((await actionRemoveCursorOrganisationApiKey('key-b')).ok).toBe(true);
    expect(invalidateMonitoringCache).toHaveBeenCalledWith('fp-b');
    expect(invalidateMonitoringCache).toHaveBeenCalledWith(
      'combined:fp-a|fp-b',
    );
    expect(invalidateMonitoringCache).toHaveBeenCalledWith('fp-a');
  });

  it('fail-closes list views when a current user exists and DB listing throws', async () => {
    currentUser.mockResolvedValue({ externalSub: 'sub', rawClaims: {} });
    requireSession.mockResolvedValue(sessionStub());
    listDbOrganisationViews.mockRejectedValue(new Error('db down'));

    await expect(listCursorOrganisationViews()).rejects.toThrow(/db down/);
  });

  it('cookie-backed list rows do not advertise manage/remove controls', async () => {
    currentUser.mockResolvedValue(null);
    cookiesGet.mockImplementation((name: string) => {
      if (name !== 'nexus_cursor_organisations') return undefined;
      return {
        value: JSON.stringify([
          {
            id: 'cookie-1',
            label: 'Legacy',
            organizationId: null,
            apiKey: 'cursor_legacy_key_xxxxxxxxxx',
            orgApiKey: null,
            baseUrl: 'https://api.cursor.com',
            apiKeys: [
              {
                id: 'cookie-1:primary',
                label: 'Primary',
                keyKind: 'user',
                apiKey: 'cursor_legacy_key_xxxxxxxxxx',
              },
            ],
          },
        ]),
      };
    });

    const views = await listCursorOrganisationViews();
    expect(views).toHaveLength(1);
    expect(views[0]?.source).toBe('cookie');
    expect(views[0]?.canManage).toBe(false);
    expect(views[0]?.canRemove).toBe(false);
    expect(views[0]?.keys.every((k) => k.canRemove === false)).toBe(true);
  });

  it('deprecated connect action returns a safe error and never writes cookies', async () => {
    const fd = new FormData();
    fd.set('apiKey', 'cursor_should_not_be_stored_xx');
    const result = await actionConnectCursorApiKey(fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Settings → Organisations/i);
    }
    expect(cookiesSet).not.toHaveBeenCalled();
  });

  it('clearCursorOrganisations deletes legacy cookies without plaintext writes', async () => {
    await clearCursorOrganisations();
    expect(cookiesDelete).toHaveBeenCalledWith('nexus_cursor_organisations');
    expect(cookiesDelete).toHaveBeenCalledWith('nexus_cursor_user_api_keys');
    expect(cookiesDelete).toHaveBeenCalledWith('nexus_cursor_user_api_key');
    expect(cookiesSet).not.toHaveBeenCalled();
  });

  it('fail-closes readCursorOrganisations when current user exists and DB throws', async () => {
    currentUser.mockResolvedValue({ externalSub: 'sub', rawClaims: {} });
    requireSession.mockResolvedValue(sessionStub());
    listCursorOrganisations.mockRejectedValue(new Error('db unavailable'));

    await expect(readCursorOrganisations()).rejects.toThrow(/db unavailable/);
  });
});
