import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const webRoot = path.resolve('.');
const fixturePath = path.resolve(webRoot, 'e2e/.acceptance-fixture.json');

type Fixture = {
  acceptanceProjectKey: string;
  coldProjectKey: string | null;
};

function loadFixture(): Fixture {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Acceptance fixture missing at ${fixturePath}. Run pnpm acceptance:setup first.`,
    );
  }
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
}

/**
 * Deterministic portion of the VISION.md §16 acceptance walkthrough.
 * Fails hard when the fixture is absent — no ALPHA fallback (B6).
 */
test.describe('Phase 9 acceptance (deterministic)', () => {
  test.beforeAll(() => {
    execSync('pnpm --dir ../.. acceptance:setup', {
      cwd: webRoot,
      env: process.env,
      stdio: 'pipe',
    });
    if (!existsSync(fixturePath)) {
      throw new Error('acceptance:setup did not write e2e/.acceptance-fixture.json');
    }
  });

  test('projects tab shows coming soon splash', async ({ page }) => {
    const res = await page.goto('/projects');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByTestId('coming-soon-splash')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
    await expect(
      page.getByText(/Projects is deprecated for now and will be revisited later/i),
    ).toBeVisible();
  });

  test('analytics page loads thin metrics for fixture project', async ({ page }) => {
    const fixture = loadFixture();
    await page.goto(`/projects/${fixture.acceptanceProjectKey}/analytics`);
    await expect(page.getByText(/Analytics|Cost per item|Estimate backtest/i).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('board quick-create shows estimate or cold start when complexity chosen', async ({
    page,
  }) => {
    const fixture = loadFixture();
    await page.goto(`/projects/${fixture.acceptanceProjectKey}/board`);
    await expect(page.getByText(/Quick create/i).first()).toBeVisible({
      timeout: 30_000,
    });
    const select = page.locator('form select[name="complexity"]').first();
    await select.selectOption('high');
    await expect(
      page.getByTestId('estimate-range').or(page.getByTestId('estimate-cold-start')).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
