import { execSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const webRoot = path.resolve('.');

function seedWebhookFailedDelivery(): void {
  execSync('pnpm exec tsx e2e/seed-webhook-journey.ts', {
    cwd: webRoot,
    env: process.env,
    stdio: 'pipe',
  });
}

/**
 * Webhook settings + §9 journey (requires seeded DB + p8.webhooks).
 *   DB_POSTGRES_URL=... pnpm db:exec-migrations && pnpm db:seed -- --demo
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PORT=3001 pnpm --filter @nexus/web start
 *   pnpm --filter @nexus/web exec playwright test e2e/webhooks-settings.spec.ts
 */
test.describe('Phase 8 webhook settings', () => {
  test('settings page shows webhook panel', async ({ page }) => {
    const res = await page.goto('/projects/ALPHA/settings');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByRole('button', { name: 'Register endpoint' })).toBeVisible({
      timeout: 45_000,
    });
  });

  test('openapi.json is served from API v1', async ({ request }) => {
    const res = await request.get('/api/v1/openapi.json');
    expect(res.ok()).toBeTruthy();
    const doc = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths?.['/api/v1/work-items/{itemKey}/transition']).toBeDefined();
  });

  test('register endpoint, observe failed delivery, replay', async ({ page }) => {
    test.setTimeout(90_000);
    seedWebhookFailedDelivery();
    const res = await page.goto('/projects/ALPHA/settings');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByText('https://httpbin.org/status/404')).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByRole('cell', { name: 'failed' }).first()).toBeVisible({
      timeout: 45_000,
    });
    await page.getByRole('button', { name: 'Replay' }).first().click();
    // Server action revalidate can lag past the default 30s test timeout; wait for
    // the new pending row (reload once if soft-nav has not painted yet).
    const pending = page.getByRole('cell', { name: 'pending' }).first();
    try {
      await expect(pending).toBeVisible({ timeout: 15_000 });
    } catch {
      await page.reload();
      await expect(pending).toBeVisible({ timeout: 45_000 });
    }
  });
});
