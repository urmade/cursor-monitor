import { describe, expect, it } from 'vitest';
import {
  ConditionAstSchema,
  ConditionEnvelopeSchema,
  conditionDepth,
  type ConditionAst,
  wrapCondition,
} from '@nexus/contracts';
import {
  describeCondition,
  emptyGateContext,
  evaluateCondition,
  evaluateInner,
} from './index';

describe('Condition DSL envelope', () => {
  it('wraps with v:1', () => {
    const ast: ConditionAst = { op: 'exists', field: 'ticket.complexity' };
    expect(wrapCondition(ast)).toEqual({ v: 1, ast });
    expect(ConditionEnvelopeSchema.parse(wrapCondition(ast)).v).toBe(1);
  });

  it('rejects unknown fields', () => {
    expect(() =>
      ConditionAstSchema.parse({ op: 'eq', field: 'ticket.unknown', value: 1 }),
    ).toThrow();
  });

  it('measures depth', () => {
    const deep: ConditionAst = {
      op: 'and',
      of: [
        {
          op: 'or',
          of: [
            { op: 'not', of: { op: 'exists', field: 'ticket.complexity' } },
            { op: 'has_label', value: 'x' },
          ],
        },
      ],
    };
    expect(conditionDepth(deep)).toBeGreaterThanOrEqual(3);
  });
});

describe('evaluateCondition — operators', () => {
  const ctx = emptyGateContext({
    ticket: {
      id: '00000000-0000-7000-8000-000000000001',
      projectId: '00000000-0000-7000-8000-000000000002',
      title: 'Hello',
      complexity: 'medium',
      ownerClass: 'ai',
      stageKey: 'scoping',
      stageId: '00000000-0000-7000-8000-000000000003',
      currentStageInstanceId: null,
    },
    labels: ['risk:high', 'area:api'],
    spec: { exists: true, acceptanceCriteriaCount: 2 },
    warnings: { openCount: 1, openInCurrentStageCount: 0, openCodes: ['spec.thin'] },
  });

  it('and / or / not', () => {
    expect(
      evaluateCondition(
        {
          op: 'and',
          of: [
            { op: 'eq', field: 'ticket.complexity', value: 'medium' },
            { op: 'has_label', value: 'risk:high' },
          ],
        },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'or',
          of: [
            { op: 'eq', field: 'ticket.complexity', value: 'low' },
            { op: 'has_label', value: 'risk:high' },
          ],
        },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'not', of: { op: 'has_label', value: 'risk:high' } },
        ctx,
      ).ok,
    ).toBe(false);
  });

  it('eq / neq / comparisons', () => {
    expect(
      evaluateCondition(
        { op: 'eq', field: 'ticket.complexity', value: 'medium' },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'neq', field: 'ticket.complexity', value: 'high' },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'gte', field: 'spec.acceptance_criteria.count', value: 2 },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'lt', field: 'spec.acceptance_criteria.count', value: 2 },
        ctx,
      ).ok,
    ).toBe(false);
  });

  it('in / not_in', () => {
    expect(
      evaluateCondition(
        {
          op: 'in',
          field: 'ticket.complexity',
          values: ['low', 'medium'],
        },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'not_in',
          field: 'ticket.complexity',
          values: ['high'],
        },
        ctx,
      ).ok,
    ).toBe(true);
  });

  it('has_label / lacks_label with prefix', () => {
    expect(
      evaluateCondition({ op: 'has_label', value: 'risk:high' }, ctx).ok,
    ).toBe(true);
    expect(
      evaluateCondition({ op: 'has_label', value: 'risk:*' }, ctx).ok,
    ).toBe(true);
    expect(
      evaluateCondition({ op: 'lacks_label', value: 'risk:low' }, ctx).ok,
    ).toBe(true);
    expect(
      evaluateCondition({ op: 'lacks_label', value: 'risk:high' }, ctx).ok,
    ).toBe(false);
  });

  it('exists / missing', () => {
    expect(
      evaluateCondition({ op: 'exists', field: 'ticket.complexity' }, ctx).ok,
    ).toBe(true);
    expect(
      evaluateCondition({ op: 'missing', field: 'ticket.complexity' }, ctx).ok,
    ).toBe(false);
    expect(
      evaluateCondition({ op: 'exists', field: 'spec.exists' }, ctx).ok,
    ).toBe(true);
  });

  it('count_gte', () => {
    expect(
      evaluateCondition(
        { op: 'count_gte', field: 'warnings.open.count', value: 1 },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'count_gte', field: 'warnings.open.count', value: 5 },
        ctx,
      ).ok,
    ).toBe(false);
  });
});

describe('evaluateCondition — null semantics', () => {
  const nullCtx = emptyGateContext({
    ticket: {
      id: '00000000-0000-7000-8000-000000000001',
      projectId: '00000000-0000-7000-8000-000000000002',
      title: '',
      complexity: null,
      ownerClass: null,
      stageKey: null,
      stageId: null,
      currentStageInstanceId: null,
    },
    latestReport: null,
    budget: { itemSpentRatio: null, projectSpentRatio: null },
  });

  it('missing is true for null complexity', () => {
    expect(
      evaluateCondition(
        { op: 'missing', field: 'ticket.complexity' },
        nullCtx,
      ).ok,
    ).toBe(true);
  });

  it('exists is false for null complexity', () => {
    expect(
      evaluateCondition(
        { op: 'exists', field: 'ticket.complexity' },
        nullCtx,
      ).ok,
    ).toBe(false);
  });

  it('eq against null complexity with concrete value is false', () => {
    expect(
      evaluateCondition(
        { op: 'eq', field: 'ticket.complexity', value: 'low' },
        nullCtx,
      ).ok,
    ).toBe(false);
  });

  it('eq(field, null) on missing field is false (use missing op)', () => {
    expect(
      evaluateCondition(
        { op: 'eq', field: 'ticket.complexity', value: null },
        nullCtx,
      ).ok,
    ).toBe(false);
  });

  it('has_label risk:* does not match bare risk', () => {
    const bare = emptyGateContext({ labels: ['risk'] });
    expect(
      evaluateCondition({ op: 'has_label', value: 'risk:*' }, bare).ok,
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'has_label', value: 'risk:*' },
        emptyGateContext({ labels: ['risk:high'] }),
      ).ok,
    ).toBe(true);
  });

  it('lt/gt against null are false', () => {
    expect(
      evaluateCondition(
        { op: 'gt', field: 'budget.item.spent_ratio', value: 0.5 },
        nullCtx,
      ).ok,
    ).toBe(false);
  });

  it('count_* on absent report is zero', () => {
    expect(
      evaluateCondition(
        { op: 'count_gte', field: 'report.assumptions.count', value: 0 },
        nullCtx,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'eq', field: 'report.assumptions.count', value: 0 },
        nullCtx,
      ).ok,
    ).toBe(true);
  });

  it('in on null field is false; not_in on null is true', () => {
    expect(
      evaluateCondition(
        { op: 'in', field: 'ticket.complexity', values: ['low'] },
        nullCtx,
      ).ok,
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: 'not_in', field: 'ticket.complexity', values: ['low'] },
        nullCtx,
      ).ok,
    ).toBe(true);
  });

  it('report.outcome is null when no report', () => {
    expect(
      evaluateCondition(
        { op: 'missing', field: 'report.outcome' },
        nullCtx,
      ).ok,
    ).toBe(true);
  });
});

describe('describeCondition', () => {
  it('renders readable text', () => {
    const text = describeCondition({
      op: 'and',
      of: [
        { op: 'exists', field: 'ticket.complexity' },
        { op: 'lacks_label', value: 'risk:high' },
      ],
    });
    expect(text).toBe('complexity is set AND has no label risk:high');
  });

  it('round-trips snapshot for common shapes', () => {
    const cases: ConditionAst[] = [
      { op: 'eq', field: 'ticket.stage.key', value: 'deploy' },
      { op: 'has_label', value: 'risk:*' },
      {
        op: 'or',
        of: [
          { op: 'count_gte', field: 'warnings.open.count', value: 2 },
          { op: 'missing', field: 'spec.exists' },
        ],
      },
    ];
    for (const c of cases) {
      const d = describeCondition(c);
      expect(d.length).toBeGreaterThan(3);
      expect(d).toMatchSnapshot();
    }
  });
});

describe('fuzz — evaluateInner never throws on valid ASTs', () => {
  const fields = [
    'ticket.complexity',
    'ticket.stage.key',
    'ticket.owner_class',
    'ticket.title',
    'spec.exists',
    'spec.acceptance_criteria.count',
    'report.outcome',
    'report.confidence',
    'report.not_verified.count',
    'report.assumptions.count',
    'run.status',
    'run.count_in_stage',
    'warnings.open.count',
    'warnings.open_in_current_stage.count',
    'loop.count',
    'budget.item.spent_ratio',
    'budget.project.spent_ratio',
  ] as const;

  /** Mulberry32 — seeded PRNG so failures are reproducible. */
  function mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomAst(rand: () => number, depth: number): ConditionAst {
    if (depth <= 0) {
      const field = fields[Math.floor(rand() * fields.length)]!;
      const leaf = Math.floor(rand() * 13);
      switch (leaf) {
        case 0:
          return { op: 'exists', field };
        case 1:
          return { op: 'missing', field };
        case 2:
          return { op: 'has_label', value: rand() > 0.5 ? 'risk:*' : 'risk:high' };
        case 3:
          return { op: 'lacks_label', value: 'area:api' };
        case 4:
          return { op: 'eq', field, value: rand() > 0.5 ? 'low' : null };
        case 5:
          return { op: 'neq', field, value: 'high' };
        case 6:
          return { op: 'lt', field, value: 1 };
        case 7:
          return { op: 'lte', field, value: 2 };
        case 8:
          return { op: 'gt', field, value: 0 };
        case 9:
          return { op: 'gte', field, value: 1 };
        case 10:
          return { op: 'in', field, values: ['low', 'medium', null] };
        case 11:
          return { op: 'not_in', field, values: ['high'] };
        default:
          return {
            op: 'count_gte',
            field: 'warnings.open.count',
            value: Math.floor(rand() * 5),
          };
      }
    }
    const kind = Math.floor(rand() * 3);
    if (kind === 0)
      return { op: 'and', of: [randomAst(rand, depth - 1), randomAst(rand, depth - 1)] };
    if (kind === 1)
      return { op: 'or', of: [randomAst(rand, depth - 1), randomAst(rand, depth - 1)] };
    return { op: 'not', of: randomAst(rand, depth - 1) };
  }

  it('survives 200 random valid ASTs via evaluateInner (seed=42)', () => {
    const seed = 42;
    const rand = mulberry32(seed);
    const ctx = emptyGateContext();
    for (let i = 0; i < 200; i++) {
      const ast = randomAst(rand, 3);
      expect(() => evaluateInner(ast, ctx), `seed=${seed} i=${i}`).not.toThrow();
      const r = evaluateInner(ast, ctx);
      expect(typeof r.ok).toBe('boolean');
    }
  });
});
