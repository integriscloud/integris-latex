import { expect, type Page, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  closeHelpers,
  enterCode,
  forgetMessages,
  lastSmsCode,
  resetLimits,
  signInKept,
  testPhone,
} from './auth-helpers';

// Back-office and notifications (step 14). The super-administrator is a kept account (index 63
// per Playwright project): back-office actions write append-only audit and credit entries. Its
// role is given by the command-line script, as on a server. Credit added is refunded at once, so
// the balance goes back to zero on every run.

const superadmin = fileURLToPath(new URL('../../api/scripts/superadmin.mjs', import.meta.url));

test.afterAll(async () => {
  await closeHelpers();
});

/** Confirms the back-office SMS code when the dialog asks for it. */
async function confirmByCode(page: Page, e164: string) {
  const dialog = page.getByRole('dialog', { name: 'Confirmer par SMS' });
  await expect(dialog).toBeVisible();
  await forgetMessages(e164);
  await resetLimits([e164]);
  await dialog.getByRole('button', { name: 'Recevoir le code' }).click();
  await enterCode(page, await lastSmsCode(e164));
  await dialog.getByRole('button', { name: 'Confirmer' }).click();
  await expect(dialog).toBeHidden();
}

test('back-office: SMS code, credit and refund, notification centre; plan price (desktop)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const phone = testPhone(test.info().project.name, 63);
  await signInKept(page, phone);
  const run = promisify(execFile);
  await run('node', [superadmin, 'grant', phone.e164, '--reason', 'e2e back-office']);

  // Nobody else sees the back-office; the super-administrator gets its link in the menu.
  await page.goto('/fr/app');
  // On phones the side menu overlays the content and opens first.
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Back-office' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tableau de bord');
  await expect(page.getByText('Comptes inscrits')).toBeVisible();

  // Own account: 100 FCFA of credit, then refunded (SMS code asked once, valid a few minutes).
  await page.goto('/fr/admin/users');
  await page.getByLabel('Nom, téléphone ou e-mail').fill(phone.e164.slice(-8));
  await page.getByRole('button', { name: 'Rechercher' }).click();
  await page.getByRole('row').nth(1).getByRole('link').click();
  await expect(page.getByText('Solde de crédit : 0 FCFA')).toBeVisible();
  const creditForm = page.locator('form').filter({ hasText: 'Ajouter le crédit' });
  await creditForm.getByLabel('Montant (FCFA)').fill('100');
  await creditForm.getByLabel('Motif').fill('Test de bout en bout');
  await creditForm.getByRole('button', { name: 'Ajouter le crédit' }).click();
  await confirmByCode(page, phone.e164);
  await expect(page.getByText('Crédit ajouté.')).toBeVisible();
  await expect(page.getByText('Solde de crédit : 100 FCFA')).toBeVisible();

  const refund = page.locator('form').filter({ hasText: 'Enregistrer le remboursement' });
  await refund.getByLabel('Montant (FCFA)').fill('100');
  await refund.getByLabel('Référence du versement').fill('E2E-OM-1');
  await refund.getByLabel('Motif').fill('Remboursement de test');
  await refund.getByRole('button', { name: 'Enregistrer le remboursement' }).click();
  await expect(page.getByText('Remboursement enregistré.')).toBeVisible();
  await expect(page.getByText('Solde de crédit : 0 FCFA')).toBeVisible();

  // Both notices are in the notification centre, unread, and the bell counts them.
  await page.goto('/fr/app/notifications');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications');
  await expect(
    page.getByText('100 FCFA ont été ajoutés à votre solde de crédit.').first(),
  ).toBeVisible();
  await expect(
    page.getByText('100 FCFA de votre solde de crédit vous ont été remboursés.').first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tout marquer comme lu' }).click();
  await expect(page.getByText('Tout est lu.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();

  // Plans and prices without code (desktop only: each change is a kept version).
  if (test.info().project.name !== 'desktop') return;
  await page.goto('/fr/admin/plans');
  const standard = page.locator('section').filter({ hasText: 'Standard (STANDARD)' });
  const price = standard.getByLabel('Prix mensuel (FCFA)');
  const before = await price.inputValue();
  const setPrice = async (value: string) => {
    await price.fill(value);
    await standard.getByLabel('Motif de la modification').fill(`e2e : prix ${value}`);
    await standard.getByRole('button', { name: 'Enregistrer une nouvelle version' }).click();
    await expect(standard.getByText('Nouvelle version enregistrée.')).toBeVisible();
  };
  await setPrice(String(Number(before) + 100));
  const plans = await (await page.request.get('/api/plans')).json();
  expect(plans.find((plan: { code: string }) => plan.code === 'STANDARD').priceMonthlyXof).toBe(
    Number(before) + 100,
  );
  await expect(standard.getByText('Modifié : Prix mensuel (FCFA)').first()).toBeVisible();
  await setPrice(before);
});
