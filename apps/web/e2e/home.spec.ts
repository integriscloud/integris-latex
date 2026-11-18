import { expect, test } from '@playwright/test';

test.describe('visitor whose browser language is not supported', () => {
  // The test browser defaults to en-US, which would open the English page.
  test.use({ locale: 'de-DE' });

  test('home page is in French by default', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/fr$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Vos idées méritent un document impeccable.',
    );
  });
});

test('language switcher opens the English home page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/fr');
  await page.getByRole('link', { name: 'English' }).first().click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Your ideas deserve a flawless document.',
  );
});

test('pricing shows the plans served by the API', async ({ page, request }) => {
  const plans = (await (await request.get('http://127.0.0.1:4000/api/plans')).json()) as {
    nameEn: string;
  }[];
  await page.goto('/en#pricing');
  const pricing = page.locator('#pricing');
  for (const plan of plans) {
    await expect(pricing.getByRole('heading', { level: 3, name: plan.nameEn })).toBeVisible();
  }
  await pricing.getByRole('button', { name: 'Monthly' }).click();
  await expect(pricing.getByRole('button', { name: 'Monthly' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('sign-up call to action leads to its placeholder page', async ({ page }) => {
  await page.goto('/fr');
  await page.getByRole('link', { name: 'Commencer gratuitement' }).first().click();
  await expect(page).toHaveURL(/\/fr\/signup$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Créer un compte');
});
