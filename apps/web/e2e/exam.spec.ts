import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  reachPrintDate,
  resetExamFixture,
  signInKept,
  testPhone,
} from './auth-helpers';

// Step 13 end to end ("Terminée quand" : un sujet reste inaccessible avant sa date ; chaque accès
// apparaît au journal). A teacher writes an exam paper and sends it to the secretariat of a
// class; before the availability date, the server refuses it to everyone (secretariat, owner of
// the organization); once the date is reached, the secretariat opens the watermarked preview,
// downloads the print file through its one-time link (a second use is refused), confirms the
// printing and the handover; each access is in the journal of the secretariat and of the
// teacher. Kept accounts 60 to 62 (the journal is append-only).

test.afterAll(async () => {
  await closeHelpers();
});

async function newPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR', acceptDownloads: true });
  return context.newPage();
}

async function chooseSpace(page: Page, name: RegExp) {
  await page.goto('/fr/spaces');
  await page.getByRole('button', { name }).click();
  await expect(page).toHaveURL(/\/fr\/app$/);
}

/** jj/mm/aaaa of a day from now, in the browser's time zone (the test machine's). */
function day(offset: number): string {
  const date = new Date(Date.now() + offset * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** POST from the page (same origin, session cookie), as the app does. */
const post = (page: Page, path: string) =>
  page.request.post(`/api/${path}`, {
    data: {},
    headers: { origin: new URL(page.url()).origin },
  });

test('an exam subject stays locked before its date and every access is journaled', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const project = test.info().project.name;
  const owner = testPhone(project, 60);
  const teacher = testPhone(project, 61);
  const secretary = testPhone(project, 62);
  const title = `Hydrologie — Examen ${project}`;

  // Accounts first (created on first use), then the organization written to the database.
  const ownerPage = await newPage(browser, baseURL);
  const secretaryPage = await newPage(browser, baseURL);
  await signInKept(page, teacher);
  await signInKept(ownerPage, owner);
  await signInKept(secretaryPage, secretary);
  await resetExamFixture(project, {
    owner: owner.e164,
    teacher: teacher.e164,
    secretary: secretary.e164,
  });

  // ── The teacher writes an exam paper and sends it ──
  await chooseSpace(page, /Espace enseignant/);
  // The side menu folds away on phones: "Mes devoirs" is reached by its address there.
  await page.goto('/fr/app/exams');
  await expect(page.getByRole('heading', { name: 'Mes devoirs' })).toBeVisible();
  await page.getByLabel('Nom du devoir').fill('Hydrologie générale');
  await page.getByRole('button', { name: 'Créer et rédiger' }).click();
  await expect(page).toHaveURL(/\/edit/);
  await expect(page.getByRole('button', { name: 'Corrigé' })).toBeVisible();
  const projectId = /projects\/([^/]+)\/edit/.exec(page.url())![1]!;

  await page.goto(`/fr/app/exams/${projectId}`);
  await page.getByRole('button', { name: 'Envoyer au secrétariat' }).click();
  await page.getByLabel('Titre affiché au secrétariat').fill(title);
  await page.getByLabel('Classe').selectOption({ label: 'UFR SVT › L3 Hydrologie' });
  await page.getByLabel('Exemplaires', { exact: true }).fill('30');
  await page.getByLabel('Réserve').fill('2');
  const available = page.getByRole('group', { name: 'Prêt pour le (mise à disposition)' });
  await available.getByLabel('Date').fill(day(1));
  await available.getByLabel('Heure').fill('08:00');
  const exam = page.getByRole('group', { name: "Date de l'épreuve" });
  await exam.getByLabel('Date').fill(day(3));
  await exam.getByLabel('Heure').fill('08:00');
  await page.getByRole('button', { name: "Envoyer la demande d'impression" }).click();
  // The subject is compiled alone, then the request is created, locked until its date.
  await expect(page.getByText('Programmé (verrouillé)')).toBeVisible({ timeout: 120_000 });

  // ── Before the date: nobody opens it ──
  await chooseSpace(secretaryPage, /Espace secrétariat/);
  await secretaryPage.goto('/fr/app/print');
  await secretaryPage.getByRole('tab', { name: /Programmés/ }).click();
  await secretaryPage.getByRole('link', { name: 'Voir' }).first().click();
  await expect(secretaryPage.getByText(/Sujet verrouillé jusqu'au/)).toBeVisible();
  await expect(secretaryPage.getByRole('button', { name: 'Ouvrir le sujet' })).toHaveCount(0);
  const requestId = /print\/([^/?]+)$/.exec(secretaryPage.url())![1]!;
  for (const [who, path] of [
    [secretaryPage, `print-requests/${requestId}/preview`],
    [secretaryPage, `print-requests/${requestId}/print-link`],
    [ownerPage, `print-requests/${requestId}/preview`],
    [page, `print-requests/${requestId}/preview`],
  ] as const) {
    const refused = await post(who, path);
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('print_locked');
  }

  // ── The date is reached: open, print once, confirm, hand over ──
  await reachPrintDate(title, teacher.e164);
  await secretaryPage.reload();
  await secretaryPage.getByRole('button', { name: 'Ouvrir le sujet' }).click();
  await expect(secretaryPage.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // The owner of the organization never sees the subject.
  expect((await post(ownerPage, `print-requests/${requestId}/preview`)).status()).toBe(403);

  const download = secretaryPage.waitForEvent('download');
  await secretaryPage.getByRole('button', { name: 'Télécharger le fichier à imprimer' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  // The one-time link is spent.
  const again = await secretaryPage.request.get(file.url());
  expect(again.status()).toBe(404);

  await secretaryPage.getByLabel('Exemplaires imprimés').fill('32');
  await secretaryPage.getByRole('button', { name: 'Confirmer', exact: true }).click();
  await expect(secretaryPage.getByText(/32 exemplaires imprimés le/)).toBeVisible();
  await secretaryPage.getByLabel('Remis à').fill('Pr. Surveillant');
  await secretaryPage.getByRole('button', { name: 'Confirmer la remise' }).click();
  await expect(secretaryPage.getByText(/Remis à Pr\. Surveillant le/)).toBeVisible();

  // ── Every access is in the journal ──
  await secretaryPage.goto('/fr/app/print/journal');
  for (const line of [
    'Vous : sujet ouvert',
    "Vous : fichier d'impression téléchargé",
    'Vous : impression confirmée (32 exemplaires)',
    'Vous : copies remises à Pr. Surveillant',
    /: demande envoyée, sujet figé/,
  ]) {
    await expect(secretaryPage.getByText(line).first()).toBeVisible();
  }
  await page.goto(`/fr/app/exams/${projectId}`);
  const journal = page.getByRole('list', { name: "Journal d'accès" });
  // One opening, one line: the viewer fetching the preview twice (React strict mode in
  // development) is the same opening.
  await expect(journal.getByText(/: sujet ouvert/)).toHaveCount(1);
  await expect(journal.getByText(/: fichier d'impression téléchargé/).first()).toBeVisible();
  await expect(journal.getByText(/^Vous : demande envoyée/).first()).toBeVisible();
});
