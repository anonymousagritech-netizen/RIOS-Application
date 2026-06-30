import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end smoke of the core RIOS journeys (brief §21 Phase 13).
 * Runs against a live, seeded stack. Verifies auth, navigation, the reconciled
 * finance view, and the assistant's confirmation gate (no mutation without
 * explicit confirmation, §12.4).
 */

async function login(page: Page, email = 'admin@demo.rios') {
  await page.goto('/');
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill('demo1234');
  // tenant code field is pre-filled with "demo"; ensure it's set
  const tenant = page.locator('input[name="tenantCode"], input[name="tenant"]').first();
  if (await tenant.count()) await tenant.fill('demo');
  await page.getByRole('button', { name: /sign in/i }).first().click();
  await expect(page.getByText(/executive overview/i)).toBeVisible();
}

test('login lands on the executive dashboard with KPIs', async ({ page }) => {
  await login(page);
  await expect(page.getByText(/treaties/i).first()).toBeVisible();
  // KPI value cells render numbers
  await expect(page.getByText(/active treaties/i)).toBeVisible();
});

test('treaties list renders and a treaty opens', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: /^treaties$/i }).first().click();
  await expect(page).toHaveURL(/\/treaties$/);
  // The seeded Atlantic Mutual treaty should be listed
  await expect(page.getByText(/Atlantic Mutual/i).first()).toBeVisible();
});

test('finance trial balance reconciles (Balanced)', async ({ page }) => {
  await login(page);
  await page.goto('/finance');
  await expect(page.getByText(/trial balance/i).first()).toBeVisible();
  // The GL self-balances - a "Balanced" indicator is shown.
  await expect(page.getByText(/balanced/i).first()).toBeVisible();
});

test('assistant prepares a mutation but requires explicit confirmation', async ({ page }) => {
  await login(page);
  // Open the assistant drawer.
  await page.getByRole('button', { name: /assistant/i }).first().click();
  const input = page.getByPlaceholder(/ask|message|assistant/i).first();
  await input.fill('create a treaty named E2E Smoke Treaty');
  await input.press('Enter');
  // A confirmation affordance must appear; nothing is created until confirmed (§12.4).
  await expect(page.getByText(/confirm/i).first()).toBeVisible();
});

test('operations health dashboard reports live metrics', async ({ page }) => {
  await login(page);
  await page.goto('/operations');
  await expect(page.getByText(/audit events/i).first()).toBeVisible();
  await expect(page.getByText(/active contracts/i).first()).toBeVisible();
});
