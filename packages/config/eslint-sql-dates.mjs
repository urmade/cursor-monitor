/**
 * ESLint: forbid Date / ctx.clock() bindings inside drizzle sql` templates.
 */
export const sqlNoRawDateBindings = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Date values in drizzle sql tagged templates (use .toISOString())',
    },
    messages: {
      rawDate:
        'sql` template must not interpolate {{expr}} — use .toISOString() (or ::timestamptz) for timestamps.',
    },
    schema: [],
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        if (
          node.tag.type !== 'Identifier' ||
          node.tag.name !== 'sql' ||
          node.quasi.expressions.length === 0
        ) {
          return;
        }
        for (const expr of node.quasi.expressions) {
          const source = context.sourceCode.getText(expr);
          const trimmed = source.trim();
          if (trimmed.includes('toISOString()')) continue;
          if (
            trimmed === 'ctx.clock()' ||
            /^new Date\s*\(/.test(trimmed) ||
            /^(now|cutoff)$/.test(trimmed)
          ) {
            context.report({ node: expr, messageId: 'rawDate', data: { expr: trimmed } });
          }
        }
      },
    };
  },
};

export const sqlDateGuardPlugin = {
  rules: {
    'no-raw-date-bindings': sqlNoRawDateBindings,
  },
};
