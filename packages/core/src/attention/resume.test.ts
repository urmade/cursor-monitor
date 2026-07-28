import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeAfterQuestion } from './resume';

const launchRun = vi.fn();

vi.mock('../runs/lifecycle', () => ({
  launchRun: (...args: unknown[]) => launchRun(...args),
}));

function ctx(overrides?: {
  runs?: { id: string; bindingId: string; providerAgentId: string | null; status: string };
}) {
  const runRow = {
    id: 'run-old',
    bindingId: 'bind-1',
    providerAgentId: 'agent-1',
    status: 'completed',
    ...overrides?.runs,
  };
  return {
    db: {
      query: {
        questions: {
          findFirst: vi.fn(async () => ({
            id: 'q1',
            runId: 'run-old',
            status: 'answered',
          })),
        },
        runs: {
          findFirst: vi.fn(async () => runRow),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(async () => undefined),
        })),
      })),
    },
    orgId: 'org',
    actor: { kind: 'human', userId: 'u1' },
    clock: () => new Date(),
  } as never;
}

describe('resumeAfterQuestion', () => {
  beforeEach(() => {
    launchRun.mockReset();
  });

  it('follow_up passes resumeAgentId to launchRun', async () => {
    launchRun.mockResolvedValueOnce({ ok: true, value: { id: 'run-new' } });
    await resumeAfterQuestion(ctx(), {
      questionId: 'q1',
      answer: 'Okta',
      workItemId: 'item-1',
    });
    expect(launchRun.mock.calls[0]?.[1]).toMatchObject({
      resumeAgentId: 'agent-1',
      forceFreshAgent: false,
    });
  });

  it('fresh_launch when no provider agent', async () => {
    launchRun.mockResolvedValueOnce({ ok: true, value: { id: 'run-fresh' } });
    const result = await resumeAfterQuestion(
      ctx({
        runs: { id: 'run-old', bindingId: 'bind-1', providerAgentId: null, status: 'completed' },
      }),
      {
      questionId: 'q1',
      answer: 'new',
      workItemId: 'item-1',
    },
    );
    expect(result.status).toBe('resumed');
    if (result.status === 'resumed') expect(result.branch).toBe('fresh_launch');
  });

  it('provider_busy enqueues retrying without blocking sleep', async () => {
    launchRun.mockResolvedValueOnce({
      ok: false,
      error: { code: 'provider_busy', message: 'busy' },
    });
    const result = await resumeAfterQuestion(ctx(), {
      questionId: 'q1',
      answer: 'slow',
      workItemId: 'item-1',
    });
    expect(result.status).toBe('retrying');
    expect(result.branch).toBe('agent_busy');
  });
});
