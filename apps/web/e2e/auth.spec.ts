import { expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  deleteTestUsers,
  forgetMessages,
  lastMailLink,
  lastSmsCode,
  resetLimits,
  testPhone,
} from './auth-helpers';

const created: string[] = [];

test.afterAll(async () => {
  await deleteTestUsers(created);
  await closeHelpers();
});

/** Types a code in the digit boxes (paste spreads it across the boxes). */
async function enterCode(page: Page, code: string) {
  await page.getByRole('textbox', { name: 'Chiffre 1 sur 6' }).fill(code);
}

async function signUp(page: Page, phone: { local: string; e164: string }, email?: string) {
  created.push(phone.e164);
  await deleteTestUsers([phone.e164]);
  await forgetMessages(phone.e164);
  await resetLimits([phone.e164]);

  await page.goto('/fr/signup');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Créer un compte');
  await page.getByLabel('Prénom').fill('Awa');
  await page.getByLabel('Nom', { exact: true }).fill('Kaboré');
  await page.getByLabel('Numéro de téléphone').fill(phone.local);
  if (email) await page.getByLabel('E-mail').fill(email);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Recevoir le code par SMS' }).click();

  await expect(page.getByText('Étape 2 sur 3 · Vérification du numéro')).toBeVisible();
  await enterCode(page, await lastSmsCode(phone.e164));
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByText('Votre compte est créé.')).toBeVisible();
  await page.getByRole('link', { name: 'Ouvrir mon espace' }).click();
  // A new account only has the personal space: the space chooser is skipped.
  await expect(page).toHaveURL(/\/fr\/app$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bonjour Awa Kaboré');
}

async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Se déconnecter' }).first().click();
  await expect(page).toHaveURL(/\/fr\/login$/);
}

test('sign up by SMS code, log out, log in again with a new code', async ({ page, context }) => {
  const phone = testPhone(test.info().project.name, 1);
  await signUp(page, phone);

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === '__Host-session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

  await logOut(page);
  await page.goto('/fr/app');
  await expect(page).toHaveURL(/\/fr\/login$/);

  await resetLimits([phone.e164]);
  await forgetMessages(phone.e164);
  await page.getByLabel('Numéro de téléphone').fill(phone.local);
  await page.getByRole('button', { name: 'Recevoir le code' }).click();
  await expect(page.getByText(`Code envoyé par SMS au +226 ${phone.local}.`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Renvoyer le code dans \d+ s/ })).toBeDisabled();
  await enterCode(page, await lastSmsCode(phone.e164));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(/\/fr\/app$/);
});

test('an unknown number is told to sign up only after entering the code', async ({ page }) => {
  const phone = testPhone(test.info().project.name, 2);
  await deleteTestUsers([phone.e164]);
  await resetLimits([phone.e164]);
  await forgetMessages(phone.e164);

  await page.goto('/fr/login');
  await page.getByLabel('Numéro de téléphone').fill(phone.local);
  await page.getByRole('button', { name: 'Recevoir le code' }).click();
  await enterCode(page, await lastSmsCode(phone.e164));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByText("Aucun compte n'existe pour ce numéro.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Créer un compte avec ce numéro' })).toBeVisible();
});

test('wrong codes lead to the anti-robot check', async ({ page }) => {
  const phone = testPhone(test.info().project.name, 3);
  await signUp(page, phone);
  await logOut(page);
  await resetLimits([phone.e164]);
  await forgetMessages(phone.e164);

  await page.getByLabel('Numéro de téléphone').fill(phone.local);
  await page.getByRole('button', { name: 'Recevoir le code' }).click();
  const code = await lastSmsCode(phone.e164);
  const wrong = code === '000000' ? '111111' : '000000';
  const submit = page.getByRole('button', { name: 'Se connecter', exact: true });

  for (let i = 0; i < 3; i++) {
    await enterCode(page, wrong);
    await submit.click();
    await expect(page.getByText("Ce code n'est pas le bon")).toBeVisible();
  }
  // The 4th attempt needs the CAPTCHA: the browser solves it and the request goes through.
  await enterCode(page, code);
  await submit.click();
  await expect(page.getByText('Vérification anti-robot')).toBeVisible();
  await expect(page).toHaveURL(/\/fr\/app$/);
  await resetLimits([phone.e164]);
});

test('confirm an e-mail, set a password, log in with it', async ({ page }) => {
  const project = test.info().project.name;
  const phone = testPhone(project, 4);
  const email = `e2e-${project}@example.com`;
  await forgetMessages(phone.e164, email);
  await signUp(page, phone, email);

  const link = new URL(await lastMailLink(email));
  await page.goto(`${link.pathname}${link.hash}`);
  await expect(page.getByText('Votre adresse e-mail est confirmée.')).toBeVisible();
  // The token is removed from the address bar.
  expect(new URL(page.url()).hash).toBe('');

  await page.goto('/fr/account');
  await expect(page.getByText(`Adresse confirmée : ${email}`)).toBeVisible();
  await page.getByLabel('Nouveau mot de passe').fill('ma-these-en-geologie');
  await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
  await expect(page.getByText('Mot de passe enregistré.', { exact: false })).toBeVisible();

  await page.goto('/fr/app');
  await logOut(page);
  await resetLimits([`email:${email}`]);
  await page.getByRole('tab', { name: 'E-mail' }).click();
  await page.getByRole('textbox', { name: 'E-mail' }).fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill('mauvais-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByText('E-mail ou mot de passe incorrect.')).toBeVisible();
  await page.getByLabel('Mot de passe', { exact: true }).fill('ma-these-en-geologie');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(/\/fr\/app$/);
});

test('signed-out visitors are sent to the sign-in page', async ({ page }) => {
  for (const path of ['/fr/app', '/fr/spaces', '/fr/account']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/fr\/login$/);
  }
});
