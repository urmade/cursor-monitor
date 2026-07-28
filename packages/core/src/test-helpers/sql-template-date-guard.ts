/**
 * Drizzle/postgres.js `sql` templates only accept string/Buffer bindings — not Date.
 * See deliverPendingWebhooks claim query and phase 5–7 incidents.
 */

export type SqlDateViolation = {
  expr: string;
  reason: string;
};

const BARE_DATE_IDENTIFIERS = new Set([
  'now',
  'cutoff',
  'then',
  'today',
  'startedAt',
  'endedAt',
  'deadlineAt',
  'runAfter',
  'nextAttemptAt',
]);

export function bannedSqlInterpolation(expr: string): SqlDateViolation | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  if (trimmed.includes('toISOString()')) return null;

  if (trimmed === 'ctx.clock()' || /^ctx\.clock\(\)$/.test(trimmed)) {
    return { expr: trimmed, reason: 'ctx.clock() must be converted before sql binding' };
  }
  if (/^new Date\s*\(/.test(trimmed)) {
    return { expr: trimmed, reason: 'new Date() must use .toISOString() in sql templates' };
  }
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed) && BARE_DATE_IDENTIFIERS.has(trimmed)) {
    return {
      expr: trimmed,
      reason: `bare Date-like identifier "${trimmed}" — bind .toISOString() instead`,
    };
  }
  return null;
}

/** Extract ${...} expressions from a single sql`...` template literal body. */
export function extractSqlTemplateInterpolations(templateBody: string): string[] {
  const exprs: string[] = [];
  let i = 0;
  while (i < templateBody.length) {
    if (templateBody[i] === '$' && templateBody[i + 1] === '{') {
      i += 2;
      let depth = 1;
      let expr = '';
      while (i < templateBody.length && depth > 0) {
        const ch = templateBody[i];
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
        if (depth > 0) expr += ch;
        i += 1;
      }
      exprs.push(expr);
      continue;
    }
    i += 1;
  }
  return exprs;
}

export function scanSourceForSqlDateViolations(source: string): SqlDateViolation[] {
  const violations: SqlDateViolation[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const tagIdx = source.indexOf('sql`', searchFrom);
    if (tagIdx === -1) break;
    let pos = tagIdx + 4;
    let body = '';
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '\\') {
        body += ch + (source[pos + 1] ?? '');
        pos += 2;
        continue;
      }
      if (ch === '`') {
        pos += 1;
        break;
      }
      body += ch;
      pos += 1;
    }
    for (const expr of extractSqlTemplateInterpolations(body)) {
      const ban = bannedSqlInterpolation(expr);
      if (ban) violations.push(ban);
    }
    searchFrom = pos;
  }
  return violations;
}
