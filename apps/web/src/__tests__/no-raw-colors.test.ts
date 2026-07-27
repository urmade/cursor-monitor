import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = join(process.cwd(), 'app');

const forbidden = [
  /border-white\//,
  /bg-white\//,
  /text-white\//,
  /bg-black\//,
  /text-\[var\(--accent\)\]/,
  /bg-\[var\(--accent\)\]/,
  /#0e1412/i,
  /#c4f082/i,
];

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (/\.(tsx|jsx|css)$/.test(e.name)) files.push(p);
  }
  return files;
}

describe('no raw legacy colors in app routes', () => {
  it('apps/web/app has no banned color literals', () => {
    const hits: string[] = [];
    for (const file of walk(appDir)) {
      const text = readFileSync(file, 'utf8');
      for (const re of forbidden) {
        if (re.test(text)) {
          hits.push(`${file}: ${re}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
