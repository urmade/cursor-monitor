import type {
  ConditionAst,
  CountableRef,
  FieldRef,
  JsonPrimitive,
} from '@nexus/contracts';

/**
 * Immutable snapshot of facts a condition evaluates against.
 * Every field is nullable; null semantics are specified in docs/conditions.md.
 */
export type GateContext = {
  ticket: {
    id: string;
    projectId: string;
    title: string;
    complexity: string | null;
    ownerClass: string | null;
    stageKey: string | null;
    stageId: string | null;
    currentStageInstanceId: string | null;
  };
  labels: string[];
  spec: {
    exists: boolean;
    acceptanceCriteriaCount: number;
  };
  latestReport: {
    outcome: string | null;
    confidence: number | null;
    notVerifiedCount: number;
    assumptionsCount: number;
  } | null;
  activeRun: {
    status: string | null;
    countInStage: number;
  };
  warnings: {
    openCount: number;
    openInCurrentStageCount: number;
    openCodes: string[];
  };
  loops: {
    /** Stored item loop_count (no prospective +1). */
    count: number;
    countFromStage: number;
    /** Same as count — kept for older condition refs. */
    itemLoopCount?: number;
    /** Prospective count after a pending return edge (for loop_budget item scope). */
    prospectiveCount?: number;
    /** Deprecated precomputed fields — prefer edges + countForLoopBudgetScope. */
    countForStage?: number;
    countForPair?: number;
    edges?: Array<{ fromStageId: string; toStageId: string }>;
    prospectiveReturn?: { fromStageId: string; toStageId: string } | null;
  };
  budget: {
    itemSpentRatio: number | null;
    projectSpentRatio: number | null;
  };
  project: {
    id: string;
    key: string;
    enforcementMode: 'enforce' | 'observe';
  };
};

export type EvalResult = {
  ok: boolean;
  /** Which leaf/field decided, for evidence. */
  evidence: Record<string, unknown>;
};

function readField(ctx: GateContext, field: FieldRef): JsonPrimitive | undefined {
  switch (field) {
    case 'ticket.complexity':
      return ctx.ticket.complexity;
    case 'ticket.stage.key':
      return ctx.ticket.stageKey;
    case 'ticket.owner_class':
      return ctx.ticket.ownerClass;
    case 'ticket.title':
      return ctx.ticket.title;
    case 'spec.exists':
      return ctx.spec.exists;
    case 'spec.acceptance_criteria.count':
      return ctx.spec.acceptanceCriteriaCount;
    case 'report.outcome':
      return ctx.latestReport?.outcome ?? null;
    case 'report.confidence':
      return ctx.latestReport?.confidence ?? null;
    case 'report.not_verified.count':
      return ctx.latestReport?.notVerifiedCount ?? 0;
    case 'report.assumptions.count':
      return ctx.latestReport?.assumptionsCount ?? 0;
    case 'run.status':
      return ctx.activeRun.status;
    case 'run.count_in_stage':
      return ctx.activeRun.countInStage;
    case 'warnings.open.count':
      return ctx.warnings.openCount;
    case 'warnings.open_in_current_stage.count':
      return ctx.warnings.openInCurrentStageCount;
    case 'loop.count':
      return ctx.loops.count;
    case 'loop.count_from_stage':
      return ctx.loops.countFromStage;
    case 'budget.item.spent_ratio':
      return ctx.budget.itemSpentRatio;
    case 'budget.project.spent_ratio':
      return ctx.budget.projectSpentRatio;
    default: {
      const _exhaustive: never = field;
      void _exhaustive;
      return null;
    }
  }
}

function readCount(ctx: GateContext, field: CountableRef): number {
  const v = readField(ctx, field as FieldRef);
  if (typeof v === 'number') return v;
  return 0;
}

function isMissing(value: JsonPrimitive | undefined): boolean {
  return value === undefined || value === null || value === '';
}

function labelMatches(labels: string[], pattern: string): boolean {
  if (pattern.endsWith(':*')) {
    // `risk:*` matches `risk:high` etc., but NOT the bare key `risk`.
    const prefix = pattern.slice(0, -1); // keep trailing ':'
    return labels.some((l) => l.startsWith(prefix));
  }
  if (pattern.endsWith('*') && pattern.includes(':')) {
    const prefix = pattern.slice(0, -1);
    return labels.some((l) => l.startsWith(prefix));
  }
  return labels.includes(pattern);
}

function compare(
  op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte',
  left: JsonPrimitive | undefined,
  right: JsonPrimitive,
): boolean {
  // Null semantics (docs/conditions.md rule 3): comparisons against a null/missing
  // LHS are false. Use `missing` / `exists` to test absence — never `eq(field, null)`.
  if (isMissing(left) || right === null) {
    if (op === 'eq') return false;
    if (op === 'neq') {
      // missing != X is true when X is a concrete non-null value; missing != null is false
      if (isMissing(left) && (right === null || right === '')) return false;
      if (isMissing(left)) return true;
      // left present, right null
      return true;
    }
    // lt/lte/gt/gte against null → false
    return false;
  }

  if (op === 'eq') return left === right;
  if (op === 'neq') return left !== right;

  // Numeric / lexicographic for strings
  if (typeof left === 'number' && typeof right === 'number') {
    switch (op) {
      case 'lt':
        return left < right;
      case 'lte':
        return left <= right;
      case 'gt':
        return left > right;
      case 'gte':
        return left >= right;
    }
  }
  if (typeof left === 'string' && typeof right === 'string') {
    switch (op) {
      case 'lt':
        return left < right;
      case 'lte':
        return left <= right;
      case 'gt':
        return left > right;
      case 'gte':
        return left >= right;
    }
  }
  return false;
}

/**
 * Pure in-process evaluator. Never throws on a valid AST.
 * Returns `{ ok, evidence }` — ok means the condition is satisfied.
 */
export function evaluateCondition(
  ast: ConditionAst,
  ctx: GateContext,
): EvalResult {
  try {
    return evaluateInner(ast, ctx);
  } catch (e) {
    return {
      ok: false,
      evidence: {
        error: e instanceof Error ? e.message : 'evaluate_error',
      },
    };
  }
}

/** Unwrapped evaluator for fuzz tests — may throw on malformed input. */
export function evaluateInner(ast: ConditionAst, ctx: GateContext): EvalResult {
  switch (ast.op) {
    case 'and': {
      const parts: EvalResult[] = [];
      for (const child of ast.of) {
        const r = evaluateInner(child, ctx);
        parts.push(r);
        if (!r.ok) {
          return {
            ok: false,
            evidence: { op: 'and', failed: r.evidence, parts: parts.map((p) => p.ok) },
          };
        }
      }
      return { ok: true, evidence: { op: 'and', parts: parts.map((p) => p.ok) } };
    }
    case 'or': {
      const parts: EvalResult[] = [];
      for (const child of ast.of) {
        const r = evaluateInner(child, ctx);
        parts.push(r);
        if (r.ok) {
          return {
            ok: true,
            evidence: { op: 'or', matched: r.evidence, parts: parts.map((p) => p.ok) },
          };
        }
      }
      return {
        ok: false,
        evidence: { op: 'or', parts: parts.map((p) => p.evidence) },
      };
    }
    case 'not': {
      const inner = evaluateInner(ast.of, ctx);
      return { ok: !inner.ok, evidence: { op: 'not', of: inner.evidence } };
    }
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const actual = readField(ctx, ast.field);
      const ok = compare(ast.op, actual, ast.value);
      return {
        ok,
        evidence: { op: ast.op, field: ast.field, actual: actual ?? null, expected: ast.value },
      };
    }
    case 'in': {
      const actual = readField(ctx, ast.field);
      if (isMissing(actual)) {
        return {
          ok: false,
          evidence: { op: 'in', field: ast.field, actual: null, values: ast.values },
        };
      }
      const ok = ast.values.some((v) => v === actual);
      return {
        ok,
        evidence: { op: 'in', field: ast.field, actual, values: ast.values },
      };
    }
    case 'not_in': {
      const actual = readField(ctx, ast.field);
      if (isMissing(actual)) {
        // missing is not in the set → true
        return {
          ok: true,
          evidence: { op: 'not_in', field: ast.field, actual: null, values: ast.values },
        };
      }
      const ok = !ast.values.some((v) => v === actual);
      return {
        ok,
        evidence: { op: 'not_in', field: ast.field, actual, values: ast.values },
      };
    }
    case 'has_label': {
      const ok = labelMatches(ctx.labels, ast.value);
      return {
        ok,
        evidence: { op: 'has_label', value: ast.value, labels: ctx.labels },
      };
    }
    case 'lacks_label': {
      const ok = !labelMatches(ctx.labels, ast.value);
      return {
        ok,
        evidence: { op: 'lacks_label', value: ast.value, labels: ctx.labels },
      };
    }
    case 'exists': {
      const actual = readField(ctx, ast.field);
      const ok = !isMissing(actual) && actual !== false;
      return {
        ok,
        evidence: { op: 'exists', field: ast.field, actual: actual ?? null },
      };
    }
    case 'missing': {
      const actual = readField(ctx, ast.field);
      const ok = isMissing(actual) || actual === false;
      // For boolean `spec.exists`, missing means false
      if (ast.field === 'spec.exists') {
        return {
          ok: actual !== true,
          evidence: { op: 'missing', field: ast.field, actual: actual ?? null },
        };
      }
      return {
        ok,
        evidence: { op: 'missing', field: ast.field, actual: actual ?? null },
      };
    }
    case 'count_gte': {
      const count = readCount(ctx, ast.field);
      const ok = count >= ast.value;
      return {
        ok,
        evidence: { op: 'count_gte', field: ast.field, actual: count, expected: ast.value },
      };
    }
    default: {
      const _exhaustive: never = ast;
      void _exhaustive;
      return { ok: false, evidence: { error: 'unknown_op' } };
    }
  }
}

/** Serialisable snapshot for gate_evaluations.context_snapshot. */
export function snapshotContext(ctx: GateContext): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ctx)) as Record<string, unknown>;
}
