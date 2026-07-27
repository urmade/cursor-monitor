import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

/** Default template keys — must not appear as string literals outside seed/templates. */
const FORBIDDEN = [
  "'intake'",
  '"intake"',
  "'scoping'",
  '"scoping"',
  "'implementation'",
  '"implementation"',
  "'deploy'",
  '"deploy"',
];

const ALLOW_PATH_FRAGMENTS = [
  '/projects/templates.ts',
  '/seed.ts',
  '/__tests__/',
  '.test.ts',
  '/migrations/',
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') {
        continue;
      }
      files.push(...(await walk(full)));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('no hardcoded stage keys in application logic', () => {
  it('does not embed default pipeline keys outside templates/seed', async () => {
    const dirs = [
      path.join(ROOT, 'packages/core/src'),
      path.join(ROOT, 'packages/contracts/src'),
      path.join(ROOT, 'apps/web'),
    ];
    const offenders: string[] = [];
    for (const dir of dirs) {
      let files: string[] = [];
      try {
        files = await walk(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (ALLOW_PATH_FRAGMENTS.some((frag) => file.includes(frag))) continue;
        const body = await readFile(file, 'utf8');
        for (const token of FORBIDDEN) {
          if (body.includes(token)) {
            offenders.push(`${path.relative(ROOT, file)} contains ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
