import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  createBareProject,
  creditForBusiness,
  E2E_ORG_PREFIX,
  lastSmsLink,
  resetBillingAccount,
  resetOrganizationAccounts,
  signInKept,
  testPhone,
} from './auth-helpers';

// Step 12 end to end: a BUSINESS of 10 seats bought by its owner (paid from a credit balance, so
// without LigdiCash), members invited by SMS and by CSV import, a teacher's join request
// confirmed, an admin named, a supervisor assigned, a project opened to them and shown on their
// dashboard, a member removed (their seat waits 30 days). Kept accounts 45 to 49: seats, roles
// and links are audited (append-only), so the accounts are reset, never deleted.

test.afterAll(async () => {
  await closeHelpers();
});

async function newPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR' });
  return context.newPage();
}

/** Opens the link of an SMS on the origin of the test (the SMS carries the public address). */
async function openSmsLink(page: Page, e164: string) {
  const link = new URL(await lastSmsLink(e164));
  await page.goto(`${link.pathname}${link.hash}`);
}

/** Opens a space of the signed-in account from "Choisir son espace". */
async function chooseSpace(page: Page, name: string | RegExp) {
  await page.goto('/fr/spaces');
  await page.getByRole('button', { name }).click();
  await expect(page).toHaveURL(/\/fr\/app$/);
}

test('a BUSINESS of 10 seats works end to end', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  const project = test.info().project.name;
  const owner = testPhone(project, 45);
  const student = testPhone(project, 46);
  const teacher = testPhone(project, 47);
  const imported = testPhone(project, 48);
  const pending = testPhone(project, 49);
  const names = {
    owner: 'Titulaire E2E',
    student: 'Étudiante E2E',
    teacher: 'Enseignant E2E',
    imported: 'Importé E2E',
    pending: 'Enseignante Attente',
  };
  const organizationName = `${E2E_ORG_PREFIX}Université ${project}`;
  const email = `org-owner-${project}@integris.test`;

  // Everyone signs in first (created on first use): a sign-in SMS would hide an invitation SMS.
  await signInKept(page, owner);
  const studentPage = await newPage(browser, baseURL);
  await signInKept(studentPage, student);
  const teacherPage = await newPage(browser, baseURL);
  await signInKept(teacherPage, teacher);
  const importedPage = await newPage(browser, baseURL);
  await signInKept(importedPage, imported);
  await importedPage.context().close();
  const pendingPage = await newPage(browser, baseURL);
  await signInKept(pendingPage, pending);
  await resetOrganizationAccounts([
    { e164: owner.e164, name: names.owner },
    { e164: student.e164, name: names.student },
    { e164: teacher.e164, name: names.teacher },
    { e164: imported.e164, name: names.imported },
    { e164: pending.e164, name: names.pending },
  ]);
  await resetBillingAccount(owner.e164, email);
  await creditForBusiness(owner.e164, 10);

  // The owner buys a BUSINESS of 10 seats.
  await page.goto('/fr/app/billing/checkout?plan=BUSINESS&period=MONTHLY');
  await page.getByLabel('Nombre de sièges').fill('10');
  await page.getByLabel("Nom de l'organisation").fill(organizationName);
  const activate = page.getByRole('button', { name: 'Activer sans payer' });
  await expect(activate).toBeEnabled({ timeout: 30_000 });
  await activate.click();
  await expect(page).toHaveURL(/\/fr\/app\/billing\/payments\//, { timeout: 30_000 });

  // Its administration space: the owner holds one of the 10 seats.
  await chooseSpace(page, /Espace administration/);
  await page.goto('/fr/app/org');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(organizationName);
  await expect(page.getByText('1 sur 10')).toBeVisible();
  const joinCode = (await page.getByText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/).textContent())!;

  // Invitation by SMS: a seat is reserved.
  await page.goto('/fr/app/org/members');
  await page.getByLabel('Numéro de téléphone').fill(student.local);
  await page.getByRole('button', { name: "Envoyer l'invitation" }).click();
  await expect(page.getByText('Invitation envoyée.', { exact: false })).toBeVisible();
  await expect(page.getByText('1 réservé par une invitation', { exact: false })).toBeVisible();

  // CSV import: two valid lines (a teacher, a student), one in error.
  const csv = [
    'nom;telephone;email;profil;classe',
    `${names.teacher};${teacher.local};;enseignant;`,
    `${names.imported};${imported.local};;etudiant;`,
    'Sans contact;;;etudiant;',
  ].join('\n');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'membres.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(
    page.getByText('Import terminé : 2 invitations envoyées, 1 ligne en erreur.'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Ligne 4 (—) : ni téléphone ni e-mail')).toBeVisible();

  // The student and the teacher accept their invitations.
  await openSmsLink(studentPage, student.e164);
  await studentPage.getByRole('button', { name: 'Accepter et rejoindre' }).click();
  await expect(studentPage).toHaveURL(/\/fr\/app\/org$/, { timeout: 30_000 });
  await expect(studentPage.getByRole('heading', { level: 1 })).toHaveText(organizationName);

  await openSmsLink(teacherPage, teacher.e164);
  await teacherPage.getByRole('button', { name: 'Accepter et rejoindre' }).click();
  await expect(teacherPage).toHaveURL(/\/fr\/app\/org$/, { timeout: 30_000 });

  // A teacher declares themself with the institution code: pending until an admin confirms.
  await pendingPage.goto('/fr/app/join-organization');
  await pendingPage.getByLabel("Code d'établissement").fill(joinCode.toLowerCase());
  await pendingPage.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(pendingPage.getByText('Demande envoyée', { exact: false })).toBeVisible();

  await page.goto('/fr/app/org/members');
  await expect(page.getByText('1 rattachement à confirmer')).toBeVisible();
  await page.getByRole('button', { name: 'Rattacher comme enseignant' }).click();
  await expect(page.getByText('1 rattachement à confirmer')).toBeHidden();
  // Owner, student, teacher, confirmed teacher; the imported student's seat stays reserved.
  await expect(
    page.getByText('4 sièges occupés sur 10 · 1 réservé par une invitation · 5 libres.'),
  ).toBeVisible();

  // The owner names the teacher admin.
  const teacherRow = page.getByRole('listitem').filter({ hasText: names.teacher }).last();
  await teacherRow.getByRole('button', { name: 'Nommer administrateur' }).click();
  await expect(teacherRow.getByText('Administrateur', { exact: true })).toBeVisible();

  // The admin assigns the teacher to the student.
  await page.goto('/fr/app/org/supervision');
  // A choice made before hydration is lost (first compilation of the page in dev): until it holds.
  const supervisor = page.getByLabel('Encadreur');
  await expect(async () => {
    await supervisor.selectOption({ label: `${names.teacher} (0/30 étudiants)` });
    await page.getByLabel('Étudiant').selectOption({ label: names.student });
    await expect(supervisor).not.toHaveValue('', { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Affecter' }).click();
  await expect(page.getByText(`${names.teacher} encadre ${names.student}`)).toBeVisible();

  // The student opens a project to the supervisor.
  await createBareProject(student.e164, 'Mémoire E2E');
  await studentPage.goto('/fr/app/supervisors');
  const projectChoice = studentPage.getByLabel(`Projet à ouvrir à ${names.teacher}`);
  await expect(async () => {
    await projectChoice.selectOption({ label: 'Mémoire E2E' });
    await expect(studentPage.getByRole('button', { name: "Ouvrir à l'encadreur" })).toBeEnabled({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  await studentPage.getByRole('button', { name: "Ouvrir à l'encadreur" }).click();
  await expect(studentPage.getByText('Projets ouverts à cet encadreur :')).toBeVisible();

  // The supervisor's dashboard shows the student and the project.
  await teacherPage.goto('/fr/app/students');
  const row = teacherPage.getByRole('list', { name: 'Étudiants suivis, par urgence' });
  await expect(row.getByText(names.student)).toBeVisible();
  await expect(row.getByText('Mémoire E2E', { exact: false })).toBeVisible();

  // The owner sees consumption, never the projects.
  await page.goto('/fr/app/org/members');
  await expect(page.getByText(names.student).first()).toBeVisible();
  await expect(page.getByText('Mémoire E2E')).toHaveCount(0);

  // Removing a member: their seat waits 30 days before it can be given again.
  const pendingRow = page.getByRole('listitem').filter({ hasText: names.pending }).last();
  await pendingRow.getByRole('button', { name: 'Retirer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Retirer' }).click();
  await expect(page.getByText('1 siège libéré redevient', { exact: false })).toBeVisible();
  await expect(
    page.getByText('3 sièges occupés sur 10 · 1 réservé par une invitation · 5 libres.', {
      exact: false,
    }),
  ).toBeVisible();

  for (const other of [studentPage, teacherPage, pendingPage]) await other.context().close();
});
