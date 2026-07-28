import { execSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const webRoot = path.resolve('.');

function seedB2FailedRun(): void {
  execSync('pnpm exec tsx e2e/seed-b2-failed-run.ts', {
    cwd: webRoot,
    env: process.env,
    stdio: 'pipe',
  });
}

function seedB3BudgetBlock(): void {
  execSync('pnpm exec tsx e2e/seed-b3-budget-block.ts', {
    cwd: webRoot,
    env: process.env,
    stdio: 'pipe',
  });
}

function seedBlockingQuestion(): void {
  execSync('pnpm exec tsx e2e/seed-blocking-question.ts', {
    cwd: webRoot,
    env: process.env,
    stdio: 'pipe',
  });
}

/**
 * Requires local dev server + seeded DB:
 *   DB_POSTGRES_URL=... pnpm db:exec-migrations && pnpm db:seed -- --demo
 *   pnpm dev
 */
test.describe('Phase 6 inbox journeys', () => {
  test('inbox page renders attention shell', async ({ page }) => {
    const res = await page.goto('/inbox');
    expect(res?.status()).toBeLessThan(500);
    await expect(
      page.getByText(/Inbox|AI working|need you/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('health exposes attention reconciliation metadata', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const json = (await res.json()) as { attention?: { drift: number | null } };
    expect(json.attention).toBeDefined();
  });

  test('board attention swimlanes render after hydration', async ({ page }) => {
    await page.goto('/projects/ALPHA/board');
    await expect(page.getByRole('main').getByText('Needs me', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('main').getByText('AI working', { exact: true })).toBeVisible();
  });

  test('answer blocking question shows affirmative empty state', async ({ page }) => {
    seedBlockingQuestion();
    await page.goto('/inbox');
    await page.waitForSelector('html[data-inbox-client="ready"]', { timeout: 30_000 });
    const row = page.getByTestId(/^inbox-row-/).filter({
      hasText: 'E2E: Which auth provider?',
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId('inbox-option-1').click();
    await expect(page.getByText('AI working — nothing needed from you')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/Inbox · \d+ need you/i)).toHaveCount(0);
  });

  test('keyboard 1 triggers the first inbox action button', async ({ page }) => {
    seedBlockingQuestion();
    await page.goto('/inbox');
    await page.waitForSelector('html[data-inbox-client="ready"]', { timeout: 30_000 });
    const row = page.getByTestId(/^inbox-row-/).filter({
      hasText: 'E2E: Which auth provider?',
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    const firstBtn = row.getByTestId('inbox-option-1');
    const label = (await firstBtn.textContent())?.trim() ?? '';
    await page.keyboard.press('1');
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  });

  test('answer blocking question from inbox resolves the row', async ({ page }) => {
    seedBlockingQuestion();
    await page.goto('/inbox');
    await page.waitForSelector('html[data-inbox-client="ready"]', { timeout: 30_000 });
    const row = page.getByTestId(/^inbox-row-/).filter({
      hasText: 'E2E: Which auth provider?',
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId('inbox-option-1').click();
    await expect(row).toHaveCount(0, { timeout: 20_000 });
  });

  test('B2: retry failed run from inbox removes the row', async ({ page }) => {
    seedB2FailedRun();
    await page.goto('/inbox');
    await page.waitForSelector('html[data-inbox-client="ready"]', { timeout: 30_000 });
    const row = page.getByTestId(/^inbox-row-/).filter({ hasText: /Run failed|e2e_fail/i });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: /Retry stage/i }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  });

  test('B3: raise item budget from inbox resolves budget block', async ({ page }) => {
    seedB3BudgetBlock();
    await page.goto('/inbox');
    await page.waitForSelector('html[data-inbox-client="ready"]', { timeout: 30_000 });
    const row = page.getByTestId(/^inbox-row-/).filter({ hasText: /Budget blocked|E2E budget/i });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: /Raise item budget/i }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  });
});
