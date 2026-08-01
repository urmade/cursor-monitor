import { afterEach, describe, expect, it } from 'vitest';
import {
  CURSOR_API_BASE_URL_ALLOWLIST_ENV,
  DEFAULT_CURSOR_API_BASE_URL,
  allowedCursorApiBaseUrls,
  normalizeCursorBaseUrl,
} from './base-url';

describe('normalizeCursorBaseUrl', () => {
  const prev = {
    [CURSOR_API_BASE_URL_ALLOWLIST_ENV]:
      process.env[CURSOR_API_BASE_URL_ALLOWLIST_ENV],
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function expectOk(raw: string | null | undefined, expected: string) {
    const result = normalizeCursorBaseUrl(raw, { isProduction: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  }

  function expectReject(raw: string | null | undefined, opts?: { isProduction?: boolean }) {
    const result = normalizeCursorBaseUrl(raw, {
      isProduction: opts?.isProduction ?? true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  }

  it('defaults empty / missing / whitespace to api.cursor.com', () => {
    expectOk(null, DEFAULT_CURSOR_API_BASE_URL);
    expectOk(undefined, DEFAULT_CURSOR_API_BASE_URL);
    expectOk('', DEFAULT_CURSOR_API_BASE_URL);
    expectOk('   ', DEFAULT_CURSOR_API_BASE_URL);
  });

  it('accepts the default origin and strips a trailing slash', () => {
    expectOk('https://api.cursor.com', 'https://api.cursor.com');
    expectOk('https://api.cursor.com/', 'https://api.cursor.com');
    expectOk('  https://api.cursor.com/  ', 'https://api.cursor.com');
  });

  it('accepts case-normalized hostnames for the default origin', () => {
    expectOk('https://API.CURSOR.COM', 'https://api.cursor.com');
  });

  it('rejects attacker-controlled HTTPS hosts (SSRF / key exfil)', () => {
    expectReject('https://evil.example');
    expectReject('https://attacker.example/steal');
    expectReject('https://httpbin.org');
  });

  it('rejects suffix and subdomain tricks against api.cursor.com', () => {
    expectReject('https://api.cursor.com.evil.com');
    expectReject('https://evil-api.cursor.com');
    expectReject('https://evil.api.cursor.com');
    expectReject('https://api.cursor.com.attacker.net');
    expectReject('https://notapi.cursor.com');
    expectReject('https://api.cursor.com.');
  });

  it('rejects paths, query strings, and fragments', () => {
    expectReject('https://api.cursor.com/v1');
    expectReject('https://api.cursor.com/v0/agents');
    expectReject('https://api.cursor.com/?q=1');
    expectReject('https://api.cursor.com?x=1');
    expectReject('https://api.cursor.com/#frag');
    expectReject('https://api.cursor.com#frag');
    expectReject('https://api.cursor.com///');
  });

  it('rejects userinfo and non-default ports', () => {
    expectReject('https://user:pass@api.cursor.com');
    expectReject('https://user@api.cursor.com');
    expectReject('https://api.cursor.com:8443');
    expectReject('https://api.cursor.com:4430');
    expectReject('http://api.cursor.com:8080');
  });

  it('rejects non-https schemes in production', () => {
    expectReject('http://api.cursor.com');
    expectReject('ftp://api.cursor.com');
    expectReject('file:///etc/passwd');
    expectReject('javascript:alert(1)');
    expectReject('not a url');
  });

  it('rejects private and loopback hosts in production', () => {
    expectReject('http://127.0.0.1');
    expectReject('https://127.0.0.1');
    expectReject('http://localhost');
    expectReject('https://localhost');
    expectReject('http://192.168.1.1');
    expectReject('https://10.0.0.1');
    expectReject('http://[::1]');
  });

  it('permits exact localhost only in non-production', () => {
    const httpLocal = normalizeCursorBaseUrl('http://localhost', {
      isProduction: false,
    });
    expect(httpLocal).toEqual({ ok: true, value: 'http://localhost' });

    const httpsLocal = normalizeCursorBaseUrl('https://127.0.0.1/', {
      isProduction: false,
    });
    expect(httpsLocal).toEqual({ ok: true, value: 'https://127.0.0.1' });

    // Still reject non-localhost HTTP and private LAN hosts off-prod.
    expectReject('http://evil.example', { isProduction: false });
    expectReject('http://192.168.0.1', { isProduction: false });
    expectReject('http://localhost:3000', { isProduction: false });
    expectReject('http://localhost/v1', { isProduction: false });
  });

  it('permits additional exact HTTPS origins from options allowlist', () => {
    const result = normalizeCursorBaseUrl('https://cursor-api.corp.example', {
      isProduction: true,
      allowlist: ['https://cursor-api.corp.example'],
    });
    expect(result).toEqual({
      ok: true,
      value: 'https://cursor-api.corp.example',
    });

    // Path on an allowlisted host is still rejected.
    expect(
      normalizeCursorBaseUrl('https://cursor-api.corp.example/v1', {
        isProduction: true,
        allowlist: ['https://cursor-api.corp.example'],
      }).ok,
    ).toBe(false);
  });

  it('reads CURSOR_API_BASE_URL_ALLOWLIST and ignores malformed entries', () => {
    process.env[CURSOR_API_BASE_URL_ALLOWLIST_ENV] =
      'https://staging-api.example.com, http://insecure.example, https://ok.example/path, not-a-url, https://good.example/';

    const allowed = allowedCursorApiBaseUrls({ isProduction: true });
    expect(allowed.has('https://api.cursor.com')).toBe(true);
    expect(allowed.has('https://staging-api.example.com')).toBe(true);
    expect(allowed.has('https://good.example')).toBe(true);
    expect(allowed.has('http://insecure.example')).toBe(false);
    expect(allowed.has('https://ok.example/path')).toBe(false);

    expect(
      normalizeCursorBaseUrl('https://staging-api.example.com', {
        isProduction: true,
      }),
    ).toEqual({ ok: true, value: 'https://staging-api.example.com' });

    expect(
      normalizeCursorBaseUrl('https://good.example', { isProduction: true }),
    ).toEqual({ ok: true, value: 'https://good.example' });

    expect(
      normalizeCursorBaseUrl('http://insecure.example', { isProduction: true })
        .ok,
    ).toBe(false);
  });

  it('does not silently rewrite malicious URLs to the default', () => {
    const result = normalizeCursorBaseUrl('https://evil.example', {
      isProduction: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).not.toEqual({
        ok: true,
        value: DEFAULT_CURSOR_API_BASE_URL,
      });
    }
  });

  it('treats Vercel production markers as production (no localhost)', () => {
    process.env.NODE_ENV = 'development';
    process.env.VERCEL = '1';
    delete process.env.VERCEL_ENV;

    const result = normalizeCursorBaseUrl('http://localhost');
    expect(result.ok).toBe(false);
  });
});
