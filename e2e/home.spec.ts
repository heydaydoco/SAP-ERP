import { test, expect } from '@playwright/test';

// Example e2e (root CLAUDE.md §2 test stack). Smoke-tests the web scaffold; real flows
// (login, document entry) are added per domain.
test('home page renders the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SAP-ERP' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
});
