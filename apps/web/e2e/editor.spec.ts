import { expect, type Page, test } from '@playwright/test';
import { closeHelpers, deleteTestUsers, eraseAllProjects, signUp, testPhone } from './auth-helpers';

const created: string[] = [];

test.afterAll(async () => {
  await deleteTestUsers(created);
  await closeHelpers();
});

const INTRO = '\\section{Introduction}\\label{sec:intro}\nLe bassin du Nakanbé.\n';
const BIB = '@article{ouedraogo2021,\n  title = {Hydrologie du Nakanbé},\n}\n';

async function newAccount(page: Page, index: number) {
  const phone = testPhone(test.info().project.name, 70 + index);
  created.push(phone.e164);
  await signUp(page, phone);
}

const writeHeaders = (page: Page, type = 'application/json') => ({
  origin: new URL(page.url()).origin,
  'content-type': type,
});

/** Project with main.tex, a chapter with a label and a bibliography, created through the API. */
async function createProject(page: Page): Promise<string> {
  const response = await page.request.post('/api/projects', {
    headers: writeHeaders(page),
    data: { name: 'Mémoire éditeur' },
  });
  const { id } = (await response.json()) as { id: string };
  for (const [path, content] of [
    ['chapitres/introduction.tex', INTRO],
    ['refs.bib', BIB],
  ] as const) {
    const upload = await page.request.put(
      `/api/projects/${id}/files/upload?path=${encodeURIComponent(path)}`,
      { headers: writeHeaders(page, 'application/octet-stream'), data: Buffer.from(content) },
    );
    expect(upload.ok()).toBe(true);
  }
  return id;
}

/** The CodeMirror content of the open file. */
const code = (page: Page, path: string) => page.getByRole('textbox', { name: `Code de ${path}` });

/** Shows a pane: on phones and tablets, one pane at a time behind the bottom tabs. */
async function showPane(page: Page, name: 'Fichiers' | 'Code') {
  const tabs = page.getByRole('navigation', { name: "Zones de l'éditeur" });
  if (await tabs.isVisible()) await tabs.getByRole('button', { name }).click();
}

async function typeAtEnd(page: Page, path: string, text: string) {
  await showPane(page, 'Code');
  // A line, not the whole content: on phones it is taller than the screen.
  await code(page, path).locator('.cm-line').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  // Enter pressed as a key: typed "\n" is unreliable with the Android emulation of phones.
  for (const [index, line] of text.split('\n').entries()) {
    if (index > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
}

const saved = (page: Page) => expect(page.getByText('Enregistré', { exact: true })).toBeVisible();

test('opens a file from the project page, edits it and saves it to storage', async ({ page }) => {
  test.setTimeout(120_000);
  await newAccount(page, 1);
  const id = await createProject(page);

  // "Ouvrir" on the project page opens the main file.
  await page.goto(`/fr/app/projects/${id}`);
  await page.getByRole('link', { name: 'Ouvrir', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/fr/app/projects/${id}/edit`));
  await expect(code(page, 'main.tex')).toContainText('\\begin{document}');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mémoire éditeur');

  // Phones: editing is possible but not optimized, said once.
  const notice = page.getByText(/Sur téléphone, l'édition du code est possible/);
  if (test.info().project.name === 'mobile') {
    await expect(notice).toBeVisible();
    await page.getByRole('button', { name: 'Fermer ce message' }).click();
  }
  await expect(notice).toHaveCount(0);

  // Only Plus Jakarta Sans and JetBrains Mono on the editor page.
  const families = await page.evaluate(() => [...document.fonts].map((font) => font.family));
  expect(families.some((family) => /jakarta/i.test(family))).toBe(true);
  expect(families.some((family) => /serif/i.test(family))).toBe(false);

  // Typing is saved 2 s later; the outline follows.
  await typeAtEnd(page, 'main.tex', '\n\\section{Résultats}\nTexte ajouté.');
  await expect(page.getByText('Non enregistré', { exact: true })).toBeVisible();
  await saved(page);
  await page.reload();
  await expect(code(page, 'main.tex')).toContainText('Texte ajouté.');
  await showPane(page, 'Fichiers');
  await page.getByRole('tab', { name: 'Plan' }).click();
  await expect(page.getByRole('button', { name: /Résultats/ })).toBeVisible();

  // Environments complete with their \end; labels and citations come from the other files.
  await typeAtEnd(page, 'main.tex', '\n\\begin{itemi');
  await page.getByRole('option', { name: /itemize/ }).click();
  await expect(code(page, 'main.tex')).toContainText('\\end{itemize}');
  await page.keyboard.type('\\item Voir \\ref{');
  // The other files are read on this first \ref; the labels show as soon as they are.
  await page.getByRole('option', { name: /sec:intro/ }).click();
  await expect(code(page, 'main.tex')).toContainText('\\ref{sec:intro}');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' et \\cite{oue');
  await expect(page.getByRole('option', { name: /ouedraogo2021/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Search in the file.
  await page.getByRole('button', { name: 'Rechercher dans le fichier' }).click();
  await expect(page.getByRole('textbox', { name: 'Rechercher', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await saved(page);

  // A text file opens from the project page; the .bib keeps its own content.
  await page.goto(`/fr/app/projects/${id}`);
  await page.getByRole('link', { name: 'refs.bib' }).click();
  await expect(page).toHaveURL(/\/edit\?file=/);
  await expect(code(page, 'refs.bib')).toContainText('@article{ouedraogo2021');

  // Search in the whole project opens the file at the match.
  await showPane(page, 'Fichiers');
  await page.getByRole('tab', { name: 'Rechercher' }).click();
  await page.getByLabel('Rechercher dans tout le projet').fill('Nakanbé');
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await expect(page.getByText('2 résultats dans 2 fichiers.')).toBeVisible();
  await page.getByRole('button', { name: /Le bassin du/ }).click();
  await expect(code(page, 'chapitres/introduction.tex')).toBeVisible();

  await eraseAllProjects(page);
});

test('keeps changes while offline and asks before overwriting a newer version', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await newAccount(page, 2);
  const id = await createProject(page);
  await page.goto(`/fr/app/projects/${id}/edit`);
  await expect(code(page, 'main.tex')).toContainText('\\begin{document}');

  // Network lost: the text stays in memory and is sent when the network is back.
  await context.setOffline(true);
  await typeAtEnd(page, 'main.tex', '\nHors ligne.');
  await expect(
    page.getByText(/Hors connexion — vos modifications seront enregistrées/),
  ).toBeVisible({
    timeout: 10_000,
  });
  await context.setOffline(false);
  await saved(page);
  await expect(page.getByText(/Hors connexion — vos modifications/)).toHaveCount(0);

  // Another tab saves first: nothing is overwritten without a choice.
  const files = (await (await page.request.get(`/api/projects/${id}`)).json()) as {
    files: { id: string; path: string }[];
  };
  const main = files.files.find((file) => file.path === 'main.tex')!;
  const stored = await page.request.get(`/api/projects/${id}/files/${main.id}/content`);
  const other = await page.request.put(`/api/projects/${id}/files/${main.id}/content`, {
    headers: {
      ...writeHeaders(page, 'application/octet-stream'),
      'if-match': stored.headers().etag!,
    },
    data: Buffer.from('Version de l’autre onglet\n'),
  });
  expect(other.ok()).toBe(true);
  await typeAtEnd(page, 'main.tex', '\nMa version.');
  const dialog = page.getByRole('dialog', { name: 'Ce fichier a été modifié ailleurs' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Charger la version enregistrée' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(code(page, 'main.tex')).toHaveText('Version de l’autre onglet');
  await saved(page);

  await eraseAllProjects(page);
});

test('completes citations and labels of a project made from the "Mémoire" template', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await newAccount(page, 3);
  const templates = (await (await page.request.get('/api/templates')).json()) as {
    id: string;
    name: string;
  }[];
  const memoire = templates.find((template) => template.name === 'Mémoire')!;
  const response = await page.request.post('/api/projects', {
    headers: writeHeaders(page),
    data: { name: 'MémoireTest', templateId: memoire.id },
  });
  const { id } = (await response.json()) as { id: string };
  // A second bibliography in a sub-folder is read too.
  await page.request.put(`/api/projects/${id}/files/upload?path=biblio/terrain.bib`, {
    headers: writeHeaders(page, 'application/octet-stream'),
    data: Buffer.from(BIB),
  });

  await page.goto(`/fr/app/projects/${id}`);
  await page.getByRole('link', { name: 'Ouvrir', exact: true }).click();
  await expect(code(page, 'main.tex')).toContainText('\\documentclass');
  const notice = page.getByRole('button', { name: 'Fermer ce message' });
  if (await notice.isVisible()) await notice.click();

  // The keys are offered as soon as the brace is typed, for every citation command.
  for (const command of ['\\cite{', '\\citep{', '\\citet{', '\\autocite{']) {
    await typeAtEnd(page, 'main.tex', `\n${command}`);
    for (const key of ['knuth1984', 'lamport1994', 'ouedraogo2021']) {
      await expect(page.getByRole('option', { name: new RegExp(key) })).toBeVisible();
    }
    await page.keyboard.press('Escape');
  }
  await typeAtEnd(page, 'main.tex', '\n\\ref{');
  await expect(page.getByRole('option', { name: /chap:revue/ })).toBeVisible();
  await page.getByRole('option', { name: /chap:revue/ }).click();
  await expect(code(page, 'main.tex')).toContainText('\\ref{chap:revue}');
  await saved(page);

  await eraseAllProjects(page);
});

test('files, code and PDF share the width and keep the size chosen', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'One pane at a time on phones.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await newAccount(page, 4);
  const id = await createProject(page);
  await page.goto(`/fr/app/projects/${id}/edit`);
  await expect(code(page, 'main.tex')).toContainText('\\begin{document}');

  const width = async (pane: string) =>
    (await page.locator(`#editor-pane-${pane}`).boundingBox())!.width;
  const total = (await width('files')) + (await width('code')) + (await width('pdf'));
  // About 20 % / 45 % / 35 %.
  expect((await width('files')) / total).toBeCloseTo(0.2, 1);
  expect((await width('code')) / total).toBeCloseTo(0.45, 1);
  expect((await width('pdf')) / total).toBeCloseTo(0.35, 1);

  // Nothing of the files column is cut on its left edge.
  const files = page.locator('#editor-pane-files');
  const left = (await files.boundingBox())!.x;
  await page.getByRole('link', { name: 'Gérer les fichiers' }).focus();
  expect(
    (await page.getByRole('link', { name: 'Gérer les fichiers' }).boundingBox())!.x,
  ).toBeGreaterThan(left);
  expect((await page.getByRole('tab', { name: 'Fichiers' }).boundingBox())!.x).toBeGreaterThan(
    left,
  );

  // Drag the splitter between files and code.
  const splitter = page.getByRole('separator', { name: 'Redimensionner la zone des fichiers' });
  const box = (await splitter.boundingBox())!;
  const before = await width('files');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(await width('files')).toBeGreaterThan(before + 100);

  // The keyboard widens the PDF.
  const pdfSplitter = page.getByRole('separator', { name: 'Redimensionner la zone du PDF' });
  const pdfBefore = await width('pdf');
  await pdfSplitter.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await width('pdf')).toBeGreaterThan(pdfBefore + 40);

  // The widths are remembered.
  const chosen = { files: await width('files'), pdf: await width('pdf') };
  await page.reload();
  await expect(code(page, 'main.tex')).toContainText('\\begin{document}');
  expect(await width('files')).toBeCloseTo(chosen.files, -1);
  expect(await width('pdf')).toBeCloseTo(chosen.pdf, -1);

  await eraseAllProjects(page);
});
