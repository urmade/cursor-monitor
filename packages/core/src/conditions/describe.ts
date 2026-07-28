import type { ConditionAst, FieldRef } from '@nexus/contracts';

const FIELD_LABELS: Record<FieldRef, string> = {
  'ticket.complexity': 'complexity',
  'ticket.stage.key': 'stage',
  'ticket.owner_class': 'owner class',
  'ticket.title': 'title',
  'spec.exists': 'spec',
  'spec.acceptance_criteria.count': 'acceptance criteria count',
  'report.outcome': 'report outcome',
  'report.confidence': 'report confidence',
  'report.not_verified.count': 'not-verified count',
  'report.assumptions.count': 'assumptions count',
  'run.status': 'run status',
  'run.count_in_stage': 'runs in stage',
  'warnings.open.count': 'open warnings',
  'warnings.open_in_current_stage.count': 'open warnings in current stage',
  'loop.count': 'loop count',
  'loop.count_from_stage': 'loops from stage',
  'budget.item.spent_ratio': 'item budget spent ratio',
  'budget.project.spent_ratio': 'project budget spent ratio',
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field as FieldRef] ?? field;
}

function fmt(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

/**
 * Human-readable rendering of a condition AST for UI and gate reasons.
 * Example: `complexity is set AND has no label risk:high`
 */
export function describeCondition(ast: ConditionAst): string {
  switch (ast.op) {
    case 'and':
      return ast.of.map(describeCondition).join(' AND ');
    case 'or':
      return '(' + ast.of.map(describeCondition).join(' OR ') + ')';
    case 'not':
      return `NOT (${describeCondition(ast.of)})`;
    case 'eq':
      return `${fieldLabel(ast.field)} equals ${fmt(ast.value)}`;
    case 'neq':
      return `${fieldLabel(ast.field)} is not ${fmt(ast.value)}`;
    case 'lt':
      return `${fieldLabel(ast.field)} < ${fmt(ast.value)}`;
    case 'lte':
      return `${fieldLabel(ast.field)} ≤ ${fmt(ast.value)}`;
    case 'gt':
      return `${fieldLabel(ast.field)} > ${fmt(ast.value)}`;
    case 'gte':
      return `${fieldLabel(ast.field)} ≥ ${fmt(ast.value)}`;
    case 'in':
      return `${fieldLabel(ast.field)} in [${ast.values.map(fmt).join(', ')}]`;
    case 'not_in':
      return `${fieldLabel(ast.field)} not in [${ast.values.map(fmt).join(', ')}]`;
    case 'has_label':
      return `has label ${ast.value}`;
    case 'lacks_label':
      return `has no label ${ast.value}`;
    case 'has_warning_code':
      return `has open warning code ${ast.value}`;
    case 'lacks_warning_code':
      return `has no open warning code ${ast.value}`;
    case 'exists':
      if (ast.field === 'ticket.complexity') return 'complexity is set';
      if (ast.field === 'spec.exists') return 'spec exists';
      return `${fieldLabel(ast.field)} is set`;
    case 'missing':
      if (ast.field === 'ticket.complexity') return 'complexity is not set';
      if (ast.field === 'spec.exists') return 'spec is missing';
      return `${fieldLabel(ast.field)} is missing`;
    case 'count_gte':
      return `${fieldLabel(ast.field)} ≥ ${ast.value}`;
    default: {
      const _exhaustive: never = ast;
      void _exhaustive;
      return 'unknown condition';
    }
  }
}
