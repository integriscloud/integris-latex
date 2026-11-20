import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  eraseAllProjects,
  shareProject,
  signInKept,
  testPhone,
} from './auth-helpers';

// End of step 9 (docs/spec.md, "Plan de développement"): a full cycle from draft to validated.
// Needs a compilation worker with the TeX Live image (each sending is compiled). Kept accounts:
// sendings and validations write audit entries and a validation trace (append-only).

const MAIN = `\\documentclass{article}
\\begin{document}
\\section{Méthodologie}
Les débits baissent.
\\end{document}
`;
const CORRECTED = MAIN.replace('Les débits baissent.', 'Les débits baissent de 38 %.');
const CHAPTER = 'chapitresprincipaux/introduction.tex';

const code = (page: Page) => page.getByRole('textbox', { name: 'Code de main.tex' });

function api(page: Page) {
  const headers = (type = 'application/json') => ({
    origin: new URL(page.url()).origin,
    'content-type': type,
  });
  return {
    post: (path: string, data: object = {}) =>
      page.request.post(`/api/${path}`, { headers: headers(), data }),
    upload: (projectId: string, path: string, content: string) =>
      page.request.put(
        `/api/projects/${projectId}/files/upload?path=${encodeURIComponent(path)}&replace=true`,
        { headers: headers('application/octet-stream'), data: Buffer.from(content) },
      ),
  };
}

async function newPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR' });
  return context.newPage();
}

async function openSubmissions(page: Page, projectId: string) {
  await page.goto(`/fr/app/projects/${projectId}/edit`);
  // The side panel (comments, submissions, history) may be closed: opened once the editor shows.
  const show = page.getByRole('button', {
    name: "Afficher les commentaires, les soumissions et l'historique",
  });
  const hide = page.getByRole('button', {
    name: "Masquer les commentaires, les soumissions et l'historique",
  });
  await expect(show.or(hide)).toBeVisible({ timeout: 30_000 });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: 'Soumissions' }).click();
}

test.afterAll(async () => {
  await closeHelpers();
});

test('a submission goes from draft to validated, with a corrected version', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Two accounts side by side: desktop only');
  test.setTimeout(240_000);
  const studentPhone = testPhone('desktop', 40);
  const supervisorPhone = testPhone('desktop', 41);
  const supervisor = await newPage(browser, baseURL);
  await signInKept(page, studentPhone);
  await signInKept(supervisor, supervisorPhone);
  await eraseAllProjects(page);
  await eraseAllProjects(supervisor);

  const created = await api(page).post('projects', { name: 'Mémoire soumis' });
  const { id: projectId } = (await created.json()) as { id: string };
  expect((await api(page).upload(projectId, 'main.tex', MAIN)).ok()).toBe(true);
  expect((await api(page).upload(projectId, CHAPTER, 'Introduction.\n')).ok()).toBe(true);
  await shareProject(projectId, supervisorPhone.e164, 'SUPERVISOR');

  // The student prepares a draft and sends it: the version sent is frozen and compiled.
  await openSubmissions(page, projectId);
  await page.getByRole('button', { name: 'Nouvelle soumission' }).click();
  await page.getByLabel(/^Titre/).fill('Chapitre 2 — Méthodologie');
  // One file per line with its whole path, its box on the same line.
  const chapter = page.getByRole('checkbox', { name: CHAPTER, exact: true });
  await expect(chapter).toBeVisible();
  const box = (await chapter.boundingBox())!;
  const label = (await page.getByText(CHAPTER, { exact: true }).boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (label.y + label.height / 2))).toBeLessThan(4);
  await page.getByRole('checkbox', { name: 'main.tex', exact: true }).check();
  await page.getByRole('checkbox', { name: /Kaboré/ }).check();
  // The deadline is typed as in French (jj/mm/aaaa), and shown at the time typed.
  await page.getByRole('textbox', { name: 'Date', exact: true }).fill('31/02/2027');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(page.getByText(/Date ou heure invalide/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Date', exact: true }).fill('20/12/2027');
  await page.getByRole('textbox', { name: 'Heure', exact: true }).fill('17:00');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(page.getByText('Brouillon', { exact: true })).toBeVisible();
  await expect(page.getByText('À rendre le 20 déc. 2027, 17:00')).toBeVisible();
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await page.getByRole('textbox', { name: /^Message/ }).fill('Pouvez-vous relire ?');
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.getByText('Soumis', { exact: true })).toBeVisible({ timeout: 120_000 });

  // The supervisor finds it to review, reads the frozen PDF and sends feedback.
  await supervisor.goto('/fr/app');
  await expect(supervisor.getByRole('heading', { name: 'Soumissions à relire' })).toBeVisible();
  const row = supervisor.getByRole('row', { name: /Chapitre 2 — Méthodologie/ });
  await row.getByRole('link', { name: 'Relire « Chapitre 2 — Méthodologie »' }).click();
  await expect(supervisor.getByRole('heading', { level: 1 })).toHaveText(
    'Chapitre 2 — Méthodologie',
  );
  await expect(supervisor.getByText('En relecture', { exact: true })).toBeVisible();
  await expect(supervisor.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // The PDF takes the width of its card (zoom fitted to the width).
  const card = (await supervisor
    .getByRole('region', { name: 'PDF de la version 1' })
    .boundingBox())!;
  const pdfPage = (await supervisor.locator('canvas').first().boundingBox())!;
  expect(pdfPage.width).toBeGreaterThan(card.width * 0.8);
  // The fingerprints are technical details, folded.
  await expect(supervisor.getByText(/Empreinte SHA-256/).first()).toBeHidden();
  await supervisor.getByText('Détails techniques', { exact: true }).click();
  await expect(supervisor.getByText(/Empreinte SHA-256/).first()).toBeVisible();
  await supervisor.getByRole('button', { name: 'Envoyer les retours' }).click();
  await supervisor.getByRole('dialog').getByRole('button', { name: 'Envoyer les retours' }).click();
  await expect(supervisor.getByText('Retours envoyés', { exact: true }).first()).toBeVisible();

  // The student corrects and sends version 2.
  expect((await api(page).upload(projectId, 'main.tex', CORRECTED)).ok()).toBe(true);
  await openSubmissions(page, projectId);
  await page.getByRole('button', { name: /Chapitre 2 — Méthodologie/ }).click();
  await page.getByRole('button', { name: 'Envoyer une version corrigée' }).click();
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.getByText('Corrigé', { exact: true })).toBeVisible({ timeout: 120_000 });

  // The student goes on writing in the editor while the supervisor validates.
  await code(page).locator('.cm-line').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Suite écrite après l’envoi.');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();

  // The supervisor compares the two versions, then validates version 2.
  await supervisor.reload();
  await expect(supervisor.getByText('En relecture', { exact: true })).toBeVisible();
  await supervisor.getByRole('link', { name: 'Comparer avec la version précédente' }).click();
  await expect(supervisor.getByText('Les débits baissent de 38 %.')).toBeVisible();
  // The words changed inside the line are marked.
  await expect(supervisor.locator('mark', { hasText: 'de 38 %' })).toBeVisible();
  await supervisor.getByRole('link', { name: 'Retour à la soumission' }).click();
  await supervisor.getByRole('button', { name: 'Valider la version 2' }).click();
  await supervisor
    .getByRole('dialog')
    .getByRole('button', { name: 'Valider la version 2' })
    .click();
  await expect(supervisor.getByText(/Version 2 validée le/)).toBeVisible();

  // The student's editor drops what follows the validated version, says where it is kept, and
  // never shows a failed save.
  await expect(
    page.getByText(/Les fichiers validés ont été remis dans leur état validé/),
  ).toBeVisible({ timeout: 20_000 });
  await expect(code(page)).not.toContainText('Suite écrite après l’envoi.');
  await expect(code(page)).toContainText('Les débits baissent de 38 %.');
  await expect(page.getByText("Échec de l'enregistrement")).toHaveCount(0);
  await page.getByRole('button', { name: 'Voir la version « Avant validation »' }).click();
  await expect(page.getByRole('heading', { name: 'Avant validation' })).toBeVisible();

  // Locked: the API refuses any change of the validated file.
  const refused = await api(page).upload(projectId, 'main.tex', MAIN);
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ code: 'file_locked' });

  await eraseAllProjects(page);
  await supervisor.context().close();
});
