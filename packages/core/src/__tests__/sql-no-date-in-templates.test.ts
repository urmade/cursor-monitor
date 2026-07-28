import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bannedSqlInterpolation,
  scanSourceForSqlDateViolations,
} from '../test-helpers/sql-template-date-guard';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

describe('sql template Date guard', () => {
  it('detects deliberate ctx.clock() interpolation', () => {
    const bad = bannedSqlInterpolation('ctx.clock()');
    expect(bad?.reason).toMatch(/ctx\.clock/);
  });

  it('detects deliberate bare now identifier', () => {
    expect(bannedSqlInterpolation('now')?.reason).toMatch(/bare Date-like/);
  });

  it('allows ISO string binding', () => {
    expect(bannedSqlInterpolation('now.toISOString()')).toBeNull();
    expect(bannedSqlInterpolation('cutoff.toISOString()')).toBeNull();
  });

  it('flags a synthetic violation snippet', () => {
    const snippet = `
      const now = ctx.clock();
      await db.execute(sql\`
        select 1 where t <= \${now}
      \`);
    `;
    expect(scanSourceForSqlDateViolations(snippet).length).toBeGreaterThan(0);
  });

  it('repo has no forbidden Date bindings inside sql templates', () => {
    const roots = [join(repoRoot, 'packages'), join(repoRoot, 'apps')];
    const files = [...new Set(roots.flatMap((r) => walkTsFiles(r)))].filter(
      (f) => !f.includes('sql-template-date-guard'),
    );

    const hits: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const violations = scanSourceForSqlDateViolations(source);
      if (violations.length > 0) {
        hits.push(
          `${relative(repoRoot, file)}: ${violations.map((v) => `${v.expr} (${v.reason})`).join('; ')}`,
        );
      }
    }
    expect(hits).toEqual([]);
  });
});
