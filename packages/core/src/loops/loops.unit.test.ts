import { describe, expect, it } from 'vitest';
import {
  countForLoopBudgetScope,
  resolveLoopBudgetOutcome,
  LoopBudgetConfigSchema,
} from '@nexus/contracts';
import { isReturnEdge } from './record';
import { ensureDefaultEvaluatorsRegistered } from '../gates/evaluators';
import { getEvaluator } from '../gates/registry';
import { emptyGateContext } from '../conditions/context';

ensureDefaultEvaluatorsRegistered();

describe('isReturnEdge', () => {
  it('is true only for backward into a previously visited stage', () => {
    expect(
      isReturnEdge({ direction: 'backward', priorVisitCount: 1 }),
    ).toBe(true);
    expect(
      isReturnEdge({ direction: 'backward', priorVisitCount: 0 }),
    ).toBe(false);
    expect(
      isReturnEdge({ direction: 'forward', priorVisitCount: 5 }),
    ).toBe(false);
    expect(
      isReturnEdge({ direction: 'lateral', priorVisitCount: 1 }),
    ).toBe(false);
  });
});

describe('LoopBudgetConfigSchema', () => {
  it('parses warn/escalate/block thresholds', () => {
    const parsed = LoopBudgetConfigSchema.parse({
      scope: 'stage_pair',
      warnAt: 2,
      escalateAt: 3,
      blockAt: 5,
      message: 'Too many Review→Impl loops',
      fromStageId: '00000000-0000-7000-8000-000000000001',
      toStageId: '00000000-0000-7000-8000-000000000002',
    });
    expect(parsed.warnAt).toBe(2);
    expect(parsed.escalateAt).toBe(3);
    expect(parsed.blockAt).toBe(5);
    expect(parsed.scope).toBe('stage_pair');
  });

  it('rejects warnAt > escalateAt', () => {
    const r = LoopBudgetConfigSchema.safeParse({
      warnAt: 5,
      escalateAt: 2,
    });
    expect(r.success).toBe(false);
  });
});

describe('resolveLoopBudgetOutcome (real evaluator helper)', () => {
  it('uses >= at warnAt — mutating to > must fail this test', () => {
    expect(resolveLoopBudgetOutcome({ count: 1, warnAt: 2, escalateAt: 3 })).toBe(
      'pass',
    );
    expect(resolveLoopBudgetOutcome({ count: 2, warnAt: 2, escalateAt: 3 })).toBe(
      'warn',
    );
    expect(resolveLoopBudgetOutcome({ count: 3, warnAt: 2, escalateAt: 3 })).toBe(
      'escalate',
    );
    expect(
      resolveLoopBudgetOutcome({ count: 5, warnAt: 2, escalateAt: 3, blockAt: 5 }),
    ).toBe('block');
  });

  it('is what loop_budget evaluator imports', async () => {
    const evalFn = getEvaluator('loop_budget');
    expect(evalFn).toBeTruthy();
    const trigger = {
      kind: 'on_transition' as const,
      toStageId: '00000000-0000-7000-8000-000000000099',
    };
    const result = await evalFn!({
      gate: {
        id: '00000000-0000-7000-8000-000000000010',
        projectId: '00000000-0000-7000-8000-000000000002',
        name: 'loops',
        description: '',
        version: 1,
        evaluator: 'loop_budget',
        trigger,
        appliesWhen: null,
        config: { scope: 'item', warnAt: 2, escalateAt: 3, blockAt: 5 },
        onFailure: 'warn',
        enabled: true,
      },
      ctx: emptyGateContext({
        loops: {
          count: 2,
          itemLoopCount: 2,
          countFromStage: 0,
          edges: [],
          prospectiveReturn: null,
        },
      }),
      trigger,
    });
    expect(result.outcome).toBe('warn');
    expect(result.evidence?.escalate).toBe(false);
  });
});

describe('countForLoopBudgetScope', () => {
  const review = '00000000-0000-7000-8000-000000000001';
  const impl = '00000000-0000-7000-8000-000000000002';
  const plan = '00000000-0000-7000-8000-000000000003';
  const edges = [
    { fromStageId: review, toStageId: impl },
    { fromStageId: review, toStageId: impl },
    { fromStageId: plan, toStageId: impl },
  ];

  it('item scope adds +1 only when a prospective return is pending', () => {
    expect(
      countForLoopBudgetScope({
        scope: 'item',
        itemLoopCount: 2,
        edges,
        prospectiveReturn: null,
      }),
    ).toBe(2);
    expect(
      countForLoopBudgetScope({
        scope: 'item',
        itemLoopCount: 2,
        edges,
        prospectiveReturn: { fromStageId: review, toStageId: impl },
      }),
    ).toBe(3);
  });

  it('stage_pair uses configured pair, not the pending transition pair', () => {
    // Configured for plan→impl, but pending return is review→impl.
    expect(
      countForLoopBudgetScope({
        scope: 'stage_pair',
        itemLoopCount: 3,
        edges,
        fromStageId: plan,
        toStageId: impl,
        prospectiveReturn: { fromStageId: review, toStageId: impl },
      }),
    ).toBe(1); // only existing plan→impl edges; pending does not match
  });

  it('stage scope counts edges into the configured stage', () => {
    expect(
      countForLoopBudgetScope({
        scope: 'stage',
        itemLoopCount: 3,
        edges,
        stageId: impl,
        prospectiveReturn: null,
      }),
    ).toBe(3);
  });
});
