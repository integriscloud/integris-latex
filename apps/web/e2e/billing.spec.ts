import { expect, test } from '@playwright/test';
import {
  closeHelpers,
  lastMailAttachments,
  resetBillingAccount,
  signInKept,
  testPhone,
} from './auth-helpers';

// Payments (step 11) with the simulated LigdiCash of latex-dev (PAYMENT_PROVIDER=simulated):
// the simulated page calls the real callback endpoint, and the API checks the payment status
// before activating, as with LigdiCash. Kept accounts 43 and 44 (payments are never erased).

test.skip(
  process.env.PAYMENT_PROVIDER !== 'simulated',
  'Needs PAYMENT_PROVIDER=simulated in .env and pnpm dev restarted',
);

test.afterAll(async () => {
  await closeHelpers();
});

test('Standard yearly paid on the simulated LigdiCash: active plan and receipt by e-mail', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = test.info().project.name;
  const phone = testPhone(project, 43);
  const email = `billing-${project}@integris.test`;
  await signInKept(page, phone);
  await resetBillingAccount(phone.e164, email);
  // LigdiCash (here simulated) pages and return addresses are built on PUBLIC_WEB_URL; the test
  // session lives on the origin of the test: the same paths are opened there.
  const publicUrl = process.env.PUBLIC_WEB_URL;
  const origin = new URL(page.url()).origin;
  if (publicUrl && new URL(publicUrl).origin !== origin) {
    await page.route(`${new URL(publicUrl).origin}/**`, (route) => {
      const target = new URL(route.request().url());
      return route.fulfill({
        status: 302,
        headers: { location: `${origin}${target.pathname}${target.search}` },
      });
    });
  }

  await page.goto('/fr/app/billing');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Abonnement');
  await page.getByRole('link', { name: 'Choisir une offre' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choisir et payer une offre');
  // Yearly is chosen first; the price comes from the Plan table through the API.
  await expect(page.getByText('À payer (TTC)')).toBeVisible();
  const pay = page.getByRole('button', { name: /^Payer / });
  await expect(pay).toBeEnabled();
  await pay.click();

  await expect(page).toHaveURL(/\/fr\/dev\/pay\/sim_/);
  await expect(page.getByText('aucun paiement réel', { exact: false })).toBeVisible();
  // A click before hydration is lost (first compilation of the page in dev): until it takes.
  const simulatedPay = page.getByRole('button', { name: 'Payer', exact: true });
  await expect(async () => {
    if (page.url().includes('/dev/pay/')) await simulatedPay.click({ timeout: 2000 });
    await expect(page).toHaveURL(/\/fr\/app\/billing\/payments\//, { timeout: 5000 });
  }).toPass({ timeout: 60_000 });

  await expect(page).toHaveURL(/\/fr\/app\/billing\/payments\//);
  await expect(page.getByText('Paiement vérifié.', { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('envoyé par e-mail', { exact: false })).toBeVisible();
  await expect
    .poll(async () => (await lastMailAttachments(email)).map((file) => file.filename))
    .toEqual([expect.stringMatching(/^integris-latex-\d{6}\.pdf$/)]);

  await page.getByRole('link', { name: "Retour à l'abonnement" }).click();
  await expect(page.getByText('Actif', { exact: true })).toBeVisible();
  await expect(page.getByText('Payé', { exact: true }).first()).toBeVisible();
});

test('free Standard trial: offered on both pages, once per account, paid period after it', async ({
  page,
}) => {
  const project = test.info().project.name;
  const phone = testPhone(project, 44);
  await signInKept(page, phone);
  await resetBillingAccount(phone.e164, `trial-${project}@integris.test`);

  // Subscription page: the trial and its rule.
  await page.goto('/fr/app/billing');
  await expect(page.getByRole('heading', { name: 'Essai Standard gratuit' })).toBeVisible();
  await expect(
    page.getByText('la période payée commence à la fin de l', { exact: false }),
  ).toBeVisible();

  // Plan choice: Standard offers the trial instead of paying; starting it goes back to the page.
  await page.goto('/fr/app/billing/checkout?plan=STANDARD&period=MONTHLY');
  await expect(
    page.getByRole('heading', { name: "Ou essayez d'abord gratuitement" }),
  ).toBeVisible();
  const start = page.getByRole('button', { name: "Commencer l'essai" });
  await expect(async () => {
    if (page.url().includes('/checkout')) await start.click({ timeout: 2000 });
    await expect(page).toHaveURL(/\/fr\/app\/billing$/, { timeout: 5000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText('Essai gratuit', { exact: true })).toBeVisible();
  await expect(page.getByText('Essai Standard en cours jusqu', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: "Commencer l'essai" })).toHaveCount(0);

  // During the trial, paying Standard starts the paid period at the end of the trial.
  await page.goto('/fr/app/billing/checkout?plan=STANDARD&period=MONTHLY');
  await expect(
    page.getByText('la période payée commencera à la fin de l', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: "Ou essayez d'abord gratuitement" })).toHaveCount(
    0,
  );
});
