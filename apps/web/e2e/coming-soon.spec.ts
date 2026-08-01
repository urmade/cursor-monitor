import { test, expect } from '@playwright/test';

test.describe('Deprecated tab coming soon splash', () => {
  test('inbox tab route shows coming soon', async ({ page }) => {
    const res = await page.goto('/inbox');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByTestId('coming-soon-splash')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
    await expect(
      page.getByText(/Inbox is deprecated for now and will be revisited later/i),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Monitoring' })).toHaveAttribute(
      'href',
      '/monitoring',
    );
  });

  test('projects tab route shows coming soon', async ({ page }) => {
    const res = await page.goto('/projects');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByTestId('coming-soon-splash')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
    await expect(
      page.getByText(/Projects is deprecated for now and will be revisited later/i),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Monitoring' })).toHaveAttribute(
      'href',
      '/monitoring',
    );
  });
});
