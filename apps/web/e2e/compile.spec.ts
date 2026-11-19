import { expect, type Page, test } from '@playwright/test';
import { closeHelpers, deleteTestUsers, signUp, testPhone } from './auth-helpers';

// Needs a compilation worker (apps/worker) running with the TeX Live image.
const created: string[] = [];

test.afterAll(async () => {
  await deleteTestUsers(created);
  await closeHelpers();
});

const MAIN = `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
Le bassin du Nakanbé, voir la section~\\ref{sec:intro}.

Deuxième paragraphe du mémoire.
\\end{document}
`;
const BROKEN = `\\documentclass{article}
\\begin{document}
La \\fgure du bassin.
\\end{document}
`;

const writeHeaders = (page: Page, type = 'application/json') => ({
  origin: new URL(page.url()).origin,
  'content-type': type,
});

async function createProject(page: Page): Promise<string> {
  const response = await page.request.post('/api/projects', {
    headers: writeHeaders(page),
    data: { name: 'Mémoire compilé' },
  });
  const { id } = (await response.json()) as { id: string };
  for (const [path, content] of [
    ['main.tex', MAIN],
    ['erreur.tex', BROKEN],
  ] as const) {
    const upload = await page.request.put(
      `/api/projects/${id}/files/upload?path=${encodeURIComponent(path)}&replace=true`,
      { headers: writeHeaders(page, 'application/octet-stream'), data: Buffer.from(content) },
    );
    expect(upload.ok()).toBe(true);
  }
  return id;
}

async function showPane(page: Page, name: 'Code' | 'PDF') {
  const tabs = page.getByRole('navigation', { name: "Zones de l'éditeur" });
  if (await tabs.isVisible()) await tabs.getByRole('button', { name }).click();
}

const compileButton = (page: Page) => page.getByRole('button', { name: /^Compiler/ });

test('compiles in the sandbox, shows the PDF, the translated errors and SyncTeX', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const phone = testPhone(test.info().project.name, 90);
  created.push(phone.e164);
  // A browser older than the default PDF.js build expects (Firefox 143, Chrome 144): no page
  // error may be raised by PDF.js.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    for (const type of [Map, WeakMap]) {
      delete (type.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed;
      delete (type.prototype as { getOrInsert?: unknown }).getOrInsert;
    }
    delete (Math as { sumPrecise?: unknown }).sumPrecise;
  });
  await signUp(page, phone);
  const id = await createProject(page);

  await page.goto(`/fr/app/projects/${id}/edit`);
  const code = page.getByRole('textbox', { name: 'Code de main.tex' });
  await expect(code).toBeVisible();
  // The browser's spell checker would underline every command: off unless the user turns it on
  // in the editor settings, kept on the account.
  await expect(code).toHaveAttribute('spellcheck', 'false');
  const settings = page.getByRole('button', { name: "Réglages de l'éditeur" });
  const spellcheck = page.getByRole('checkbox', { name: 'Correcteur orthographique' });
  await settings.click();
  await spellcheck.check();
  await expect(code).toHaveAttribute('spellcheck', 'true');
  await page.reload();
  await expect(code).toHaveAttribute('spellcheck', 'true');
  await settings.click();
  await expect(spellcheck).toBeChecked();
  await spellcheck.uncheck();
  await expect(code).toHaveAttribute('spellcheck', 'false');
  await page.keyboard.press('Escape');
  await showPane(page, 'PDF');
  await expect(page.getByText('Pas encore de PDF')).toBeVisible();

  // Compile: queued, running, then the PDF from the files domain.
  await compileButton(page).click();
  await expect(page.getByText(/Compilation réussie en/)).toBeVisible({ timeout: 90_000 });
  const firstPage = page.getByLabel('Page 1 du PDF');
  await expect(firstPage).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Page 1 sur 1')).toBeVisible();
  expect(pageErrors).toEqual([]);
  const download = page.getByRole('link', { name: 'Télécharger le PDF' });
  await expect(download).toHaveAttribute(
    'href',
    /^https?:\/\/[^/]+\/pdf\/[^/]+\/Memoire-compile\.pdf$/,
  );

  // PDF → code: a double-click on the text opens main.tex at its line.
  await firstPage.dblclick({ position: { x: 160, y: 140 } });
  await expect(page).toHaveURL(/[?&]file=/);

  // Code → PDF.
  await showPane(page, 'Code');
  await page.getByRole('textbox', { name: 'Code de main.tex' }).locator('.cm-line').nth(3).click();
  await page.getByRole('button', { name: 'Voir dans le PDF' }).click();
  await expect(page.getByText("Cette ligne n'apparaît pas dans le PDF.")).toHaveCount(0);

  // A broken main file: the first error is translated and opens its line.
  const patch = await page.request.patch(`/api/projects/${id}`, {
    headers: writeHeaders(page),
    data: { mainFilePath: 'erreur.tex' },
  });
  expect(patch.ok()).toBe(true);
  await page.goto(`/fr/app/projects/${id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Code de erreur.tex' })).toBeVisible();
  await compileButton(page).click();
  await showPane(page, 'PDF');
  await expect(page.getByRole('heading', { name: 'Commande inconnue' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText(/La commande \\fgure n'existe pas/)).toBeVisible();
  await expect(compileButton(page)).toHaveAccessibleName('Compiler (1 erreur)');
  await page.getByRole('button', { name: 'erreur.tex · ligne 3' }).click();
  await expect(page.getByRole('textbox', { name: 'Code de erreur.tex' })).toBeVisible();

  // The raw log is one click away.
  await showPane(page, 'PDF');
  await page.getByRole('button', { name: 'Journal brut' }).click();
  await expect(page.getByRole('dialog', { name: 'Journal de compilation' })).toContainText(
    'Undefined control sequence',
  );
});
