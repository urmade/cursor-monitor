import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeDb,
  cursorOrganisationApiKeys,
  cursorOrganisations,
  getDb,
  newId,
  orgs,
  users,
} from '@nexus/db';
import {
  addCursorOrganisationApiKey,
  createContext,
  decryptCursorApiKey,
  deleteAllCursorOrganisations,
  deleteCursorOrganisation,
  listActiveCursorApiKeys,
  listCursorOrganisations,
  listCursorOrganisationViews,
  revokeCursorOrganisationApiKey,
  updateCursorOrganisationApiKey,
  upsertCursorOrganisation,
} from '../index';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('cursor organisation API keys', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);

  afterAll(async () => {
    await closeDb();
  });

  async function createIsolatedOrg(slug: string) {
    const orgId = newId();
    await db.insert(orgs).values({ id: orgId, name: slug, slug });
    const userId = newId();
    await db.insert(users).values({
      id: userId,
      orgId,
      externalSub: `cursor-creds-${slug}-${Date.now()}`,
      email: `${slug}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return {
      orgId,
      userId,
      ctx: createContext({
        db,
        orgId,
        actor: { kind: 'human', userId },
        flags: { isEnabled: async () => true },
      }),
    };
  }

  async function addSecondHuman(orgId: string, slug: string) {
    const userId = newId();
    await db.insert(users).values({
      id: userId,
      orgId,
      externalSub: `cursor-creds-${slug}-${Date.now()}`,
      email: `${slug}@example.com`,
      displayName: slug,
      lastSeenAt: new Date(),
    });
    return {
      userId,
      ctx: createContext({
        db,
        orgId,
        actor: { kind: 'human', userId },
        flags: { isEnabled: async () => true },
      }),
    };
  }

  it('stores multiple encrypted team keys per organisation and scopes by nexus org', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'integration-test-cursor-key';

    const a = await createIsolatedOrg(`ck-a-${Date.now().toString(36)}`);
    const b = await createIsolatedOrg(`ck-b-${Date.now().toString(36)}`);

    const orgA = await upsertCursorOrganisation(a.ctx, {
      label: 'Acme',
      organizationId: 'org_Acme_Test123',
      baseUrl: 'https://api.cursor.com',
      orgApiKey: 'org_admin_key_abcdefghijklmnopqrst',
    });
    expect(orgA.ok).toBe(true);
    if (!orgA.ok) throw new Error(orgA.error.message);

    const userKey = await addCursorOrganisationApiKey(a.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'Alice',
      keyKind: 'user',
      apiKey: 'cursor_user_key_aaaaaaaaaaaaaaaa',
      identityLabel: 'Alice · personal',
    });
    expect(userKey.ok).toBe(true);
    if (!userKey.ok) throw new Error(userKey.error.message);

    const saKey = await addCursorOrganisationApiKey(a.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'cloud-agent',
      keyKind: 'service_account',
      apiKey: 'cursor_service_key_bbbbbbbbbbbbbbbb',
      identityLabel: 'cloud-agent (service account)',
    });
    expect(saKey.ok).toBe(true);
    if (!saKey.ok) throw new Error(saKey.error.message);

    const dup = await addCursorOrganisationApiKey(a.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'Alice again',
      keyKind: 'user',
      apiKey: 'cursor_user_key_aaaaaaaaaaaaaaaa',
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error('expected duplicate rejection');
    expect(dup.error.code).toBe('conflict');

    const views = await listCursorOrganisationViews(a.ctx);
    expect(views).toHaveLength(1);
    expect(views[0]?.keys).toHaveLength(2);
    expect(views[0]?.hasOrgApiKey).toBe(true);
    expect(views[0]?.canManage).toBe(true);
    expect(views[0]?.canRemove).toBe(true);
    expect(views[0]?.keys.every((k) => k.canRemove)).toBe(true);
    expect(views[0]?.keys.every((k) => k.hint.includes('…'))).toBe(true);
    // Views must never include plaintext.
    expect(JSON.stringify(views)).not.toContain('cursor_user_key_aaaaaaaaaaaaaaaa');
    expect(JSON.stringify(views)).not.toContain('org_admin_key_abcdefghijklmnopqrst');

    const active = await listActiveCursorApiKeys(a.ctx);
    expect(active).toHaveLength(2);
    expect(active.map((k) => k.apiKey).sort()).toEqual([
      'cursor_service_key_bbbbbbbbbbbbbbbb',
      'cursor_user_key_aaaaaaaaaaaaaaaa',
    ]);

    // Org B cannot see Org A's credentials.
    expect(await listCursorOrganisationViews(b.ctx)).toEqual([]);
    expect(await listActiveCursorApiKeys(b.ctx)).toEqual([]);

    const revoked = await revokeCursorOrganisationApiKey(a.ctx, userKey.value.id);
    expect(revoked.ok).toBe(true);
    expect(await listActiveCursorApiKeys(a.ctx)).toHaveLength(1);

    const deleted = await deleteCursorOrganisation(a.ctx, orgA.value.id);
    expect(deleted.ok).toBe(true);
    expect(await listCursorOrganisationViews(a.ctx)).toEqual([]);
  });

  it('denies non-human actors for credential mutations', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'integration-test-cursor-key';
    const human = await createIsolatedOrg(`ck-nh-${Date.now().toString(36)}`);
    const systemCtx = createContext({
      db,
      orgId: human.orgId,
      actor: { kind: 'system', reason: 'test' },
      flags: { isEnabled: async () => true },
    });

    const created = await upsertCursorOrganisation(systemCtx, {
      label: 'Nope',
      baseUrl: 'https://api.cursor.com',
    });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error('expected forbidden');
    expect(created.error.code).toBe('forbidden');

    const owned = await upsertCursorOrganisation(human.ctx, {
      label: 'Human org',
      baseUrl: 'https://api.cursor.com',
    });
    expect(owned.ok).toBe(true);
    if (!owned.ok) throw new Error(owned.error.message);

    const addDenied = await addCursorOrganisationApiKey(systemCtx, {
      cursorOrganisationId: owned.value.id,
      label: 'x',
      keyKind: 'user',
      apiKey: 'cursor_system_denied_key_xxxxx',
    });
    expect(addDenied.ok).toBe(false);
    if (addDenied.ok) throw new Error('expected forbidden');
    expect(addDenied.error.code).toBe('forbidden');

    const deleteDenied = await deleteCursorOrganisation(systemCtx, owned.value.id);
    expect(deleteDenied.ok).toBe(false);
    if (deleteDenied.ok) throw new Error('expected forbidden');
    expect(deleteDenied.error.code).toBe('forbidden');

    const deleteAllDenied = await deleteAllCursorOrganisations(systemCtx);
    expect(deleteAllDenied.ok).toBe(false);
    if (deleteAllDenied.ok) throw new Error('expected forbidden');
    expect(deleteAllDenied.error.code).toBe('forbidden');
  });

  it('enforces same-org ownership while allowing any member to attach keys', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'integration-test-cursor-key';
    const stamp = Date.now().toString(36);
    const owner = await createIsolatedOrg(`ck-own-${stamp}`);
    const peer = await addSecondHuman(owner.orgId, `ck-peer-${stamp}`);
    const otherOrg = await createIsolatedOrg(`ck-xorg-${stamp}`);

    const org = await upsertCursorOrganisation(owner.ctx, {
      label: 'Shared Acme',
      organizationId: `org_Shared${stamp}`,
      baseUrl: 'https://api.cursor.com',
    });
    expect(org.ok).toBe(true);
    if (!org.ok) throw new Error(org.error.message);

    const ownerKey = await addCursorOrganisationApiKey(owner.ctx, {
      cursorOrganisationId: org.value.id,
      label: 'Owner key',
      keyKind: 'user',
      apiKey: 'cursor_owner_key_aaaaaaaaaaaaaaa',
    });
    expect(ownerKey.ok).toBe(true);
    if (!ownerKey.ok) throw new Error(ownerKey.error.message);

    // Peer may attach their own token to the existing organisation.
    const peerKey = await addCursorOrganisationApiKey(peer.ctx, {
      cursorOrganisationId: org.value.id,
      label: 'Peer key',
      keyKind: 'user',
      apiKey: 'cursor_peer_key_bbbbbbbbbbbbbbbb',
    });
    expect(peerKey.ok).toBe(true);
    if (!peerKey.ok) throw new Error(peerKey.error.message);

    const peerViews = await listCursorOrganisationViews(peer.ctx);
    expect(peerViews).toHaveLength(1);
    expect(peerViews[0]?.canManage).toBe(false);
    expect(peerViews[0]?.canRemove).toBe(false);
    const peerKeyView = peerViews[0]?.keys.find((k) => k.id === peerKey.value.id);
    const ownerKeyView = peerViews[0]?.keys.find((k) => k.id === ownerKey.value.id);
    expect(peerKeyView?.canRemove).toBe(true);
    expect(ownerKeyView?.canRemove).toBe(false);

    const updateDenied = await upsertCursorOrganisation(peer.ctx, {
      id: org.value.id,
      label: 'Hijacked',
      baseUrl: 'https://api.cursor.com',
    });
    expect(updateDenied.ok).toBe(false);
    if (updateDenied.ok) throw new Error('expected forbidden');
    expect(updateDenied.error.code).toBe('forbidden');

    const deleteDenied = await deleteCursorOrganisation(peer.ctx, org.value.id);
    expect(deleteDenied.ok).toBe(false);
    if (deleteDenied.ok) throw new Error('expected forbidden');
    expect(deleteDenied.error.code).toBe('forbidden');

    const revokeOwnerDenied = await revokeCursorOrganisationApiKey(
      peer.ctx,
      ownerKey.value.id,
    );
    expect(revokeOwnerDenied.ok).toBe(false);
    if (revokeOwnerDenied.ok) throw new Error('expected forbidden');
    expect(revokeOwnerDenied.error.code).toBe('forbidden');

    // deleteAll only removes organisations owned by the current human.
    const peerOwned = await upsertCursorOrganisation(peer.ctx, {
      label: 'Peer-owned',
      baseUrl: 'https://api.cursor.com',
    });
    expect(peerOwned.ok).toBe(true);
    if (!peerOwned.ok) throw new Error(peerOwned.error.message);

    const deletedCount = await deleteAllCursorOrganisations(peer.ctx);
    expect(deletedCount.ok).toBe(true);
    if (!deletedCount.ok) throw new Error(deletedCount.error.message);
    expect(deletedCount.value).toBe(1);

    const remaining = await listCursorOrganisationViews(owner.ctx);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(org.value.id);
    expect(remaining[0]?.canManage).toBe(true);

    // Cross-org actor cannot mutate or attach.
    const crossUpdate = await upsertCursorOrganisation(otherOrg.ctx, {
      id: org.value.id,
      label: 'Cross',
      baseUrl: 'https://api.cursor.com',
    });
    expect(crossUpdate.ok).toBe(false);
    if (crossUpdate.ok) throw new Error('expected not_found');
    expect(crossUpdate.error.code).toBe('not_found');

    const crossAdd = await addCursorOrganisationApiKey(otherOrg.ctx, {
      cursorOrganisationId: org.value.id,
      label: 'Cross key',
      keyKind: 'user',
      apiKey: 'cursor_cross_key_cccccccccccccccc',
    });
    expect(crossAdd.ok).toBe(false);
    if (crossAdd.ok) throw new Error('expected not_found');
    expect(crossAdd.error.code).toBe('not_found');
  });

  it('rejects inconsistent tenant inserts and supports revoke→reattach', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'integration-test-cursor-key';
    const stamp = Date.now().toString(36);
    const a = await createIsolatedOrg(`ck-fk-a-${stamp}`);
    const b = await createIsolatedOrg(`ck-fk-b-${stamp}`);

    const orgA = await upsertCursorOrganisation(a.ctx, {
      label: 'Tenant A',
      baseUrl: 'https://api.cursor.com',
    });
    expect(orgA.ok).toBe(true);
    if (!orgA.ok) throw new Error(orgA.error.message);

    // Mismatched org_id vs parent cursor organisation must fail the composite FK.
    await expect(
      db.insert(cursorOrganisationApiKeys).values({
        id: newId(),
        cursorOrganisationId: orgA.value.id,
        orgId: b.orgId,
        label: 'bad',
        keyKind: 'user',
        apiKeyEncrypted: 'k2:deadbeef',
        apiKeyFingerprint: 'fp-bad-tenant',
        apiKeyHint: 'bad…key',
        createdByUserId: a.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();

    // created_by_user_id from another nexus org must fail.
    await expect(
      db.insert(cursorOrganisations).values({
        id: newId(),
        orgId: a.orgId,
        label: 'bad-creator',
        baseUrl: 'https://api.cursor.com',
        createdByUserId: b.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();

    const attached = await addCursorOrganisationApiKey(a.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'Reusable',
      keyKind: 'user',
      apiKey: 'cursor_reattach_key_dddddddddddd',
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error(attached.error.message);

    const revoked = await revokeCursorOrganisationApiKey(a.ctx, attached.value.id);
    expect(revoked.ok).toBe(true);
    expect(await listActiveCursorApiKeys(a.ctx)).toHaveLength(0);
    const [revokedRow] = await db
      .select()
      .from(cursorOrganisationApiKeys)
      .where(eq(cursorOrganisationApiKeys.id, attached.value.id));
    expect(
      decryptCursorApiKey(revokedRow!.apiKeyEncrypted, {
        purpose: 'team-api-key',
        orgId: a.orgId,
        recordId: attached.value.id,
      }),
    ).toBe('');

    const reattached = await addCursorOrganisationApiKey(a.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'Reusable again',
      keyKind: 'user',
      apiKey: 'cursor_reattach_key_dddddddddddd',
      identityLabel: 'reattached',
    });
    expect(reattached.ok).toBe(true);
    if (!reattached.ok) throw new Error(reattached.error.message);
    // Prefer reactivating the same row.
    expect(reattached.value.id).toBe(attached.value.id);
    expect(reattached.value.identityLabel).toBe('reattached');

    const active = await listActiveCursorApiKeys(a.ctx);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(attached.value.id);

    // Active duplicate still conflicts without leaking raw DB errors.
    const stillDup = await addCursorOrganisationApiKey(a.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'Dup',
      keyKind: 'user',
      apiKey: 'cursor_reattach_key_dddddddddddd',
    });
    expect(stillDup.ok).toBe(false);
    if (stillDup.ok) throw new Error('expected conflict');
    expect(stillDup.error.code).toBe('conflict');
    expect(stillDup.error.message).not.toMatch(/duplicate key|23505|unique/i);
  });

  it('rejects a non-allowlisted base URL read directly from the DB', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY =
      'integration-test-cursor-key';
    const tenant = await createIsolatedOrg(
      `ck-bad-url-${Date.now().toString(36)}`,
    );
    await db.insert(cursorOrganisations).values({
      id: newId(),
      orgId: tenant.orgId,
      label: 'Injected endpoint',
      baseUrl: 'https://attacker.example',
      createdByUserId: tenant.userId,
    });

    await expect(listCursorOrganisations(tenant.ctx)).rejects.toThrow(
      /base URL is not allowed/i,
    );
    await expect(listActiveCursorApiKeys(tenant.ctx)).rejects.toThrow(
      /base URL is not allowed/i,
    );
    await expect(listCursorOrganisationViews(tenant.ctx)).rejects.toThrow(
      /base URL is not allowed/i,
    );
  });

  it('rejects DB ciphertext swaps across rows during list/decrypt', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'integration-test-cursor-key';
    const stamp = Date.now().toString(36);
    const tenant = await createIsolatedOrg(`ck-swap-${stamp}`);

    const orgA = await upsertCursorOrganisation(tenant.ctx, {
      label: 'Swap A',
      baseUrl: 'https://api.cursor.com',
      orgApiKey: 'org_admin_swap_aaaaaaaaaaaaaaa',
    });
    expect(orgA.ok).toBe(true);
    if (!orgA.ok) throw new Error(orgA.error.message);

    const orgB = await upsertCursorOrganisation(tenant.ctx, {
      label: 'Swap B',
      baseUrl: 'https://api.cursor.com',
      orgApiKey: 'org_admin_swap_bbbbbbbbbbbbbbb',
    });
    expect(orgB.ok).toBe(true);
    if (!orgB.ok) throw new Error(orgB.error.message);

    const keyA = await addCursorOrganisationApiKey(tenant.ctx, {
      cursorOrganisationId: orgA.value.id,
      label: 'Team A',
      keyKind: 'user',
      apiKey: 'cursor_team_swap_aaaaaaaaaaaaaaaa',
    });
    expect(keyA.ok).toBe(true);
    if (!keyA.ok) throw new Error(keyA.error.message);

    const keyB = await addCursorOrganisationApiKey(tenant.ctx, {
      cursorOrganisationId: orgB.value.id,
      label: 'Team B',
      keyKind: 'user',
      apiKey: 'cursor_team_swap_bbbbbbbbbbbbbbbb',
    });
    expect(keyB.ok).toBe(true);
    if (!keyB.ok) throw new Error(keyB.error.message);

    // Sanity: decrypt succeeds before any swap.
    expect(await listActiveCursorApiKeys(tenant.ctx)).toHaveLength(2);

    const [rowA] = await db
      .select()
      .from(cursorOrganisationApiKeys)
      .where(eq(cursorOrganisationApiKeys.id, keyA.value.id));
    const [rowB] = await db
      .select()
      .from(cursorOrganisationApiKeys)
      .where(eq(cursorOrganisationApiKeys.id, keyB.value.id));
    expect(rowA?.apiKeyEncrypted).toBeTruthy();
    expect(rowB?.apiKeyEncrypted).toBeTruthy();

    // Swap team-key ciphertexts between API-key rows.
    await db
      .update(cursorOrganisationApiKeys)
      .set({ apiKeyEncrypted: rowB!.apiKeyEncrypted })
      .where(eq(cursorOrganisationApiKeys.id, keyA.value.id));
    await db
      .update(cursorOrganisationApiKeys)
      .set({ apiKeyEncrypted: rowA!.apiKeyEncrypted })
      .where(eq(cursorOrganisationApiKeys.id, keyB.value.id));

    await expect(listActiveCursorApiKeys(tenant.ctx)).rejects.toThrow();
    // Metadata-only settings views deliberately do not decrypt ciphertext.
    await expect(listCursorOrganisationViews(tenant.ctx)).resolves.toHaveLength(
      2,
    );

    // Restore team keys, then swap org-admin ciphertexts across organisation rows.
    await db
      .update(cursorOrganisationApiKeys)
      .set({ apiKeyEncrypted: rowA!.apiKeyEncrypted })
      .where(eq(cursorOrganisationApiKeys.id, keyA.value.id));
    await db
      .update(cursorOrganisationApiKeys)
      .set({ apiKeyEncrypted: rowB!.apiKeyEncrypted })
      .where(eq(cursorOrganisationApiKeys.id, keyB.value.id));

    const [orgRowA] = await db
      .select()
      .from(cursorOrganisations)
      .where(eq(cursorOrganisations.id, orgA.value.id));
    const [orgRowB] = await db
      .select()
      .from(cursorOrganisations)
      .where(eq(cursorOrganisations.id, orgB.value.id));
    expect(orgRowA?.orgApiKeyEncrypted).toBeTruthy();
    expect(orgRowB?.orgApiKeyEncrypted).toBeTruthy();

    await db
      .update(cursorOrganisations)
      .set({ orgApiKeyEncrypted: orgRowB!.orgApiKeyEncrypted })
      .where(eq(cursorOrganisations.id, orgA.value.id));
    await db
      .update(cursorOrganisations)
      .set({ orgApiKeyEncrypted: orgRowA!.orgApiKeyEncrypted })
      .where(eq(cursorOrganisations.id, orgB.value.id));

    await expect(listCursorOrganisations(tenant.ctx)).rejects.toThrow();
  });

  it('updates label/kind and can replace an attached team key secret', async () => {
    process.env.CURSOR_CREDENTIALS_ENCRYPTION_KEY = 'integration-test-cursor-key';

    const tenant = await createIsolatedOrg(`ck-upd-${Date.now().toString(36)}`);
    const org = await upsertCursorOrganisation(tenant.ctx, {
      label: 'Editable',
      organizationId: 'org_Edit_Key',
      baseUrl: 'https://api.cursor.com',
    });
    expect(org.ok).toBe(true);
    if (!org.ok) throw new Error(org.error.message);

    const attached = await addCursorOrganisationApiKey(tenant.ctx, {
      cursorOrganisationId: org.value.id,
      label: 'Before',
      keyKind: 'user',
      apiKey: 'cursor_before_key_aaaaaaaaaaaa',
      identityLabel: 'before',
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error(attached.error.message);

    const renamed = await updateCursorOrganisationApiKey(tenant.ctx, {
      apiKeyId: attached.value.id,
      label: 'After',
      keyKind: 'service_account',
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) throw new Error(renamed.error.message);
    expect(renamed.value.label).toBe('After');
    expect(renamed.value.keyKind).toBe('service_account');
    expect(renamed.value.apiKey).toBe('cursor_before_key_aaaaaaaaaaaa');

    const replaced = await updateCursorOrganisationApiKey(tenant.ctx, {
      apiKeyId: attached.value.id,
      label: 'After',
      apiKey: 'cursor_after_key_bbbbbbbbbbbb',
      identityLabel: 'after',
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw new Error(replaced.error.message);
    expect(replaced.value.apiKey).toBe('cursor_after_key_bbbbbbbbbbbb');
    expect(replaced.value.identityLabel).toBe('after');
    expect(replaced.value.lastValidatedAt).not.toBeNull();

    const peer = await addSecondHuman(tenant.orgId, `ck-upd-peer`);
    const peerDenied = await updateCursorOrganisationApiKey(peer.ctx, {
      apiKeyId: attached.value.id,
      label: 'Hijack',
    });
    expect(peerDenied.ok).toBe(false);
    if (peerDenied.ok) throw new Error('expected forbidden');
    expect(peerDenied.error.code).toBe('forbidden');
  });
});
