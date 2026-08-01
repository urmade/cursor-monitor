import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../app');

function readAppFile(rel: string): string {
  return readFileSync(join(appDir, rel), 'utf8');
}

describe('coming soon tab routes', () => {
  it('inbox tab page renders the coming soon splash', () => {
    const src = readAppFile('(app)/inbox/page.tsx');
    expect(src).toContain('ComingSoonSplash');
    expect(src).toContain('feature="inbox"');
    expect(src).not.toContain('InboxClient');
    expect(src).not.toContain('listInbox');
  });

  it('projects tab page renders the coming soon splash', () => {
    const src = readAppFile('(app)/projects/page.tsx');
    expect(src).toContain('ComingSoonSplash');
    expect(src).toContain('feature="projects"');
    expect(src).not.toContain('listProjects');
    expect(src).not.toContain('CreateProjectDialog');
  });

  it('home redirects to monitoring instead of deprecated tabs', () => {
    const src = readAppFile('page.tsx');
    expect(src).toContain("redirect('/monitoring')");
    expect(src).not.toContain("redirect('/inbox')");
    expect(src).not.toContain("redirect('/projects')");
  });
});
