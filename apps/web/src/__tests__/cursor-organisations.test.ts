import { describe, expect, it } from 'vitest';
import {
  isStoredCursorOrganisation,
  migrateKeysToOrganisations,
  normalizeBaseUrl,
} from '../server/cursor-org-store';
import { normalizeOrganizationId } from '@nexus/cursor-client';

describe('cursor organisation store helpers', () => {
  it('normalizes and validates API endpoints (reject, do not rewrite)', () => {
    expect(normalizeBaseUrl('https://api.cursor.com/')).toEqual({
      ok: true,
      value: 'https://api.cursor.com',
    });
    expect(normalizeBaseUrl('')).toEqual({
      ok: true,
      value: 'https://api.cursor.com',
    });
    expect(normalizeBaseUrl('https://custom.example/v1').ok).toBe(false);
    expect(normalizeBaseUrl('https://evil.example').ok).toBe(false);
    expect(normalizeBaseUrl('not a url').ok).toBe(false);
    expect(normalizeBaseUrl('ftp://bad').ok).toBe(false);
    expect(normalizeBaseUrl('http://api.cursor.com').ok).toBe(false);
  });

  it('validates stored organisation shape (legacy single-key + multi-key)', () => {
    expect(
      isStoredCursorOrganisation({
        id: '1',
        label: 'Acme',
        organizationId: 'org_abc',
        apiKey: 'cursor_xxxxxxxxxxxxxxxxxxxx',
        orgApiKey: null,
        baseUrl: 'https://api.cursor.com',
      }),
    ).toBe(true);
    expect(
      isStoredCursorOrganisation({
        id: '1',
        label: 'Acme',
        organizationId: 'org_abc',
        apiKey: '',
        orgApiKey: null,
        baseUrl: 'https://api.cursor.com',
        apiKeys: [
          {
            id: 'k1',
            label: 'Alice',
            keyKind: 'user',
            apiKey: 'cursor_xxxxxxxxxxxxxxxxxxxx',
          },
        ],
        source: 'db',
      }),
    ).toBe(true);
    expect(isStoredCursorOrganisation({ id: '1', label: 'Acme' })).toBe(false);
  });

  it('migrates legacy API keys into organisation rows with apiKeys[]', () => {
    const rows = migrateKeysToOrganisations([
      'cursor_aaaaaaaaaaaaaaaaaaaa',
      'cursor_bbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe('Organisation 1');
    expect(rows[1]?.apiKey).toBe('cursor_bbbbbbbbbbbbbbbbbbbb');
    expect(rows[0]?.baseUrl).toBe('https://api.cursor.com');
    expect(rows[0]?.apiKeys).toHaveLength(1);
    expect(rows[0]?.source).toBe('cookie');
  });

  it('normalizes organisation ids from dashboard URLs', () => {
    expect(
      normalizeOrganizationId('https://cursor.com/dashboard?org=org_abc123'),
    ).toBe('org_abc123');
  });
});
