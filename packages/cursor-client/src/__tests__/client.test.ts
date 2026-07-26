import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createCursorClient } from '../client';
import { CursorApiError } from '../errors';
import { postAutomationWebhook } from '../automation-webhook';
import { createCursorAdminClient } from '../admin';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CursorClient', () => {
  it('createAgent sends Basic auth and returns fixture body', async () => {
    const fixture = loadFixture('create-agent.json');
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.cursor.com/v1/agents');
      expect(init?.method).toBe('POST');
      const auth = new Headers(init?.headers).get('Authorization');
      expect(auth).toMatch(/^Basic /);
      const decoded = Buffer.from(auth!.slice(6), 'base64').toString('utf8');
      expect(decoded).toBe('test-key:');
      return jsonResponse(200, fixture);
    });

    const client = createCursorClient({ apiKey: 'test-key', fetchImpl });
    const res = await client.createAgent({
      agentId: 'bc-11111111-1111-1111-1111-111111111111',
      prompt: { text: 'hello' },
      autoCreatePR: false,
    });
    expect(res.agent.id).toBe('bc-11111111-1111-1111-1111-111111111111');
    expect(res.run.id).toBe('run-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('normalises model string to { id } for Cloud Agents API', async () => {
    const fixture = loadFixture('create-agent.json');
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: unknown };
      expect(body.model).toEqual({ id: 'composer-2' });
      return jsonResponse(200, fixture);
    });
    const client = createCursorClient({ apiKey: 'test-key', fetchImpl });
    await client.createAgent({
      prompt: { text: 'hello' },
      model: 'composer-2',
    });
  });

  it('getRun returns finished fixture', async () => {
    const fixture = loadFixture('get-run.json');
    const fetchImpl = vi.fn(async () => jsonResponse(200, fixture));
    const client = createCursorClient({ apiKey: 'k', fetchImpl });
    const run = await client.getRun('bc-1', 'run-1');
    expect(run.status).toBe('FINISHED');
    expect(run.durationMs).toBe(42000);
  });

  it('maps 409 agent_busy', async () => {
    const fixture = loadFixture('agent-busy.json');
    const fetchImpl = vi.fn(async () => jsonResponse(409, fixture));
    const client = createCursorClient({ apiKey: 'k', fetchImpl, maxRetries: 0 });
    await expect(
      client.createRun('bc-1', { prompt: { text: 'x' } }),
    ).rejects.toMatchObject({ code: 'agent_busy', status: 409 });
  });

  it('maps 409 agent_id_conflict', async () => {
    const fixture = loadFixture('agent-id-conflict.json');
    const fetchImpl = vi.fn(async () => jsonResponse(409, fixture));
    const client = createCursorClient({ apiKey: 'k', fetchImpl, maxRetries: 0 });
    await expect(
      client.createAgent({ prompt: { text: 'x' }, agentId: 'bc-dup' }),
    ).rejects.toMatchObject({ code: 'agent_id_conflict', status: 409 });
  });

  it('maps 410 stream_expired', async () => {
    const fixture = loadFixture('stream-expired.json');
    const fetchImpl = vi.fn(async () => jsonResponse(410, fixture));
    const client = createCursorClient({ apiKey: 'k', fetchImpl, maxRetries: 0 });
    await expect(client.getRun('bc-1', 'run-1')).rejects.toMatchObject({
      code: 'stream_expired',
      status: 410,
    });
  });

  it('retries on 429 then succeeds', async () => {
    const fixture = loadFixture('usage.json');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'slow down' }))
      .mockResolvedValueOnce(jsonResponse(200, fixture));

    const client = createCursorClient({
      apiKey: 'k',
      fetchImpl,
      maxRetries: 2,
      initialBackoffMs: 1,
    });
    const usage = await client.getUsage('bc-1', 'run-1');
    expect(usage.inputTokens).toBe(1200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx then surfaces error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { message: 'down' }));
    const client = createCursorClient({
      apiKey: 'k',
      fetchImpl,
      maxRetries: 1,
      initialBackoffMs: 1,
    });
    await expect(client.listModels()).rejects.toBeInstanceOf(CursorApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancelRun and listAgents/listModels paths', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'run-1', status: 'CANCELLED' }))
      .mockResolvedValueOnce(jsonResponse(200, { agents: [{ id: 'bc-1' }] }))
      .mockResolvedValueOnce(jsonResponse(200, { models: [{ id: 'gpt' }] }));

    const client = createCursorClient({ apiKey: 'k', fetchImpl });
    expect((await client.cancelRun('bc-1', 'run-1')).status).toBe('CANCELLED');
    expect(await client.listAgents()).toEqual([{ id: 'bc-1' }]);
    expect(await client.listModels()).toEqual([{ id: 'gpt' }]);
  });
});

describe('admin + automation webhook', () => {
  it('filteredUsageEvents posts to admin path', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/teams/filtered-usage-events');
      return jsonResponse(200, { events: [] });
    });
    const admin = createCursorAdminClient({ apiKey: 'admin-key', fetchImpl });
    const res = await admin.filteredUsageEvents({ cloudAgentId: 'bc-1' });
    expect(res.events).toEqual([]);
  });

  it('postAutomationWebhook uses bearer auth', async () => {
    const fetchImpl = vi.fn(async (_input, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer auto-key',
      );
      return jsonResponse(200, { ok: true });
    });
    const res = await postAutomationWebhook({
      webhookUrl: 'https://example.com/hook',
      automationKey: 'auto-key',
      payload: { ticket_id: 't', nonce: 'n' },
      fetchImpl,
    });
    expect(res).toEqual({ ok: true });
  });
});
