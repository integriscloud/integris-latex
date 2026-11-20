import { expect, type Page, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { closeHelpers, eraseAllProjects, signInKept, testPhone } from './auth-helpers';

// Moves and downloads write audit entries (append-only, the actor cannot be deleted): these
// tests use kept accounts (number 42 of each Playwright project) and erase only their projects.
test.afterAll(async () => {
  await closeHelpers();
});

const MAIN = [
  '\\documentclass{article}',
  '\\title{Titre non compté}',
  '\\begin{document}',
  'Deux mots. % commentaire',
  '\\input{chapitres/introduction}',
  '\\end{document}',
  '',
].join('\n');
const INTRO = '\\section{Introduction}\\label{sec:intro}\nLe bassin du Nakanbé $Q$.\n';

const writeHeaders = (page: Page, type = 'application/json') => ({
  origin: new URL(page.url()).origin,
  'content-type': type,
});

async function signIn(page: Page) {
  await signInKept(page, testPhone(test.info().project.name, 42));
  await eraseAllProjects(page);
}

/** Project with main.tex including chapitres/introduction.tex, created through the API. */
async function createProject(page: Page): Promise<string> {
  const response = await page.request.post('/api/projects', {
    headers: writeHeaders(page),
    data: { name: 'Mémoire fichiers' },
  });
  const { id } = (await response.json()) as { id: string };
  for (const [path, content, replace] of [
    ['main.tex', MAIN, true],
    ['chapitres/introduction.tex', INTRO, false],
  ] as const) {
    const upload = await page.request.put(
      `/api/projects/${id}/files/upload?path=${encodeURIComponent(path)}&replace=${replace}`,
      { headers: writeHeaders(page, 'application/octet-stream'), data: Buffer.from(content) },
    );
    expect(upload.ok()).toBe(true);
  }
  return id;
}

/** Shows a pane: on phones and tablets, one pane at a time behind the bottom tabs. */
async function showFiles(page: Page) {
  const tabs = page.getByRole('navigation', { name: "Zones de l'éditeur" });
  if (await tabs.isVisible()) await tabs.getByRole('button', { name: 'Fichiers' }).click();
}

/** Opens the "…" menu of a row of the tree and chooses an action. */
async function rowAction(page: Page, row: string, action: string) {
  await page.getByRole('button', { name: `Actions de ${row}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

/** Chooses a folder in "Move to…" (from the "…" menu of the row) and confirms. */
async function moveWithDialog(page: Page, name: string, folder: string) {
  await rowAction(page, name, 'Déplacer vers…');
  const dialog = page.getByRole('dialog', { name: `Déplacer ${name}` });
  await dialog.getByRole('radio', { name: folder }).check();
  await dialog.getByRole('button', { name: 'Déplacer', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Fills the name dialog (new file, new folder, rename) and submits it. */
async function submitName(page: Page, title: string | RegExp, name: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByLabel('Nom').fill(name);
  await dialog.getByRole('button', { name: /^(Créer|Enregistrer)$/ }).click();
  return dialog;
}

test('project page: new folder in the current folder, move to a folder, download', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'chromium-120', 'Project page: desktop and mobile');
  test.setTimeout(120_000);
  await signIn(page);
  const id = await createProject(page);
  await page.goto(`/fr/app/projects/${id}`);
  const tree = page.getByRole('group', { name: 'Fichiers du projet' });

  // A folder at the root, then a folder inside it: the selected folder is the current one.
  await page.getByRole('button', { name: 'Nouveau dossier', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Dans le dossier')).toHaveValue('');
  await expect(await submitName(page, 'Nouveau dossier', 'annexes')).toBeHidden();
  await tree.getByRole('button', { name: 'annexes', exact: true }).click();
  await expect(page.getByText('Dossier courant : annexes/')).toBeVisible();
  await page.getByRole('button', { name: 'Nouveau dossier', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Dans le dossier')).toHaveValue('annexes');
  await expect(await submitName(page, 'Nouveau dossier', 'vide')).toBeHidden();
  await expect(tree.getByRole('button', { name: 'vide', exact: true })).toBeVisible();

  // "Move to…" works without drag and drop (keyboard, touch screens).
  await moveWithDialog(page, 'chapitres/introduction.tex', 'annexes/vide/');
  await expect(page.getByText('introduction.tex a été déplacé dans annexes/vide/.')).toBeVisible();
  await expect(tree.getByText('introduction.tex')).toBeVisible();
  // Its old folder is kept, empty.
  await expect(tree.getByRole('button', { name: 'chapitres', exact: true })).toBeVisible();

  // The whole project as a ZIP archive, empty folder included.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Télécharger le projet (ZIP)' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Mémoire fichiers.zip');
  const archive = await readFile((await download.path())!);
  expect(archive.subarray(0, 2).toString()).toBe('PK');
  for (const name of ['main.tex', 'annexes/vide/introduction.tex', 'chapitres/']) {
    expect(archive.includes(Buffer.from(name))).toBe(true);
  }

  await eraseAllProjects(page);
});

test('editor: new file in the folder of the open file by name, precise errors, folder menu', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const phone = test.info().project.name === 'mobile';
  await signIn(page);
  const id = await createProject(page);
  await page.goto(`/fr/app/projects/${id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Code de main.tex' })).toBeVisible();
  if (phone) await page.getByRole('button', { name: 'Fermer ce message' }).click();
  await showFiles(page);
  const tree = page.getByRole('group', { name: 'Fichiers du projet' });

  // The folder of the open file is the current folder.
  await tree.getByRole('link', { name: 'introduction.tex' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Code de chapitres/introduction.tex' }),
  ).toBeVisible();
  await showFiles(page);
  await page.getByRole('button', { name: 'Nouveau fichier', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau fichier' });
  await expect(dialog.getByLabel('Dans le dossier')).toHaveValue('chapitres');
  await expect(
    dialog.getByText('Sans extension, .tex est ajouté.', { exact: false }),
  ).toBeVisible();

  // Each refusal says why.
  await submitName(page, 'Nouveau fichier', 'notes.docx');
  await expect(
    dialog.getByText(
      /L'extension « \.docx » n'est pas acceptée\. Extensions permises : \.tex \.bib/,
    ),
  ).toBeVisible();
  await submitName(page, 'Nouveau fichier', 'cours%1');
  await expect(
    dialog.getByText("Le caractère « % » n'est pas autorisé dans un nom."),
  ).toBeVisible();
  await submitName(page, 'Nouveau fichier', 'introduction');
  await expect(dialog.getByText('« introduction.tex » existe déjà dans chapitres/.')).toBeVisible();
  await submitName(page, 'Nouveau fichier', `${'a'.repeat(121)}`);
  await expect(dialog.getByText('Ce nom est trop long : 120 caractères au plus.')).toBeVisible();

  // A name without extension gets .tex; the new file opens at once.
  await submitName(page, 'Nouveau fichier', 'conclusion');
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('textbox', { name: 'Code de chapitres/conclusion.tex' }),
  ).toBeVisible();

  // The "…" menu of a folder: new folder here (right click opens it too on a computer).
  await showFiles(page);
  if (!phone) {
    await tree.getByRole('button', { name: 'chapitres', exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Renommer' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
  }
  await rowAction(page, 'chapitres', 'Nouveau dossier ici');
  await expect(page.getByRole('dialog').getByLabel('Dans le dossier')).toHaveValue('chapitres');
  await expect(await submitName(page, 'Nouveau dossier', 'figures')).toBeHidden();
  await expect(tree.getByRole('button', { name: 'figures', exact: true })).toBeVisible();

  // Rename keeps the folder and the extension.
  await rowAction(page, 'chapitres/conclusion.tex', 'Renommer');
  await expect(await submitName(page, /^Renommer/, 'fin')).toBeHidden();
  await expect(tree.getByRole('link', { name: 'fin.tex' })).toBeVisible();

  // Folds are remembered.
  await tree.getByRole('button', { name: 'chapitres', exact: true }).click();
  await expect(tree.getByRole('button', { name: 'figures', exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Code de / })).toBeAttached();
  await showFiles(page);
  await expect(tree.getByRole('button', { name: 'chapitres', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  await eraseAllProjects(page);
});

test('editor: new folder, drag and drop or "Move to…", word count, seen by another tab', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const phone = test.info().project.name === 'mobile';
  await signIn(page);
  const id = await createProject(page);
  await page.goto(`/fr/app/projects/${id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Code de main.tex' })).toContainText(
    '\\begin{document}',
  );
  if (phone) await page.getByRole('button', { name: 'Fermer ce message' }).click();

  // Another tab of the editor, open on the same project.
  const other = await context.newPage();
  await other.goto(`/fr/app/projects/${id}/edit`);
  await expect(other.getByRole('textbox', { name: 'Code de main.tex' })).toBeVisible();
  // The notice for phones was closed in the first tab (remembered in this browser).
  await showFiles(other);

  // Word count of the document: body of main.tex and the included chapter, no commands.
  await page.getByRole('button', { name: "Réglages de l'éditeur" }).click();
  await expect(page.getByText('7 mots')).toBeVisible();
  await expect(page.getByText('2 fichiers lus · 1 formule non comptée')).toBeVisible();
  await page.keyboard.press('Escape');

  await showFiles(page);
  await page.getByRole('button', { name: 'Nouveau dossier', exact: true }).click();
  await expect(await submitName(page, 'Nouveau dossier', 'parties')).toBeHidden();
  const tree = page.getByRole('group', { name: 'Fichiers du projet' });
  const folder = tree.getByRole('button', { name: 'parties', exact: true });
  await expect(folder).toBeVisible();

  if (phone) {
    await moveWithDialog(page, 'chapitres/introduction.tex', 'parties/');
  } else {
    // Drag and drop of the file onto the folder, then back onto the root row.
    await tree.getByRole('link', { name: 'introduction.tex' }).dragTo(folder);
  }
  await expect(page.getByText('introduction.tex a été déplacé dans parties/.')).toBeVisible();

  // The other tab sees the move without reloading.
  const otherTree = other.getByRole('group', { name: 'Fichiers du projet' });
  await expect(otherTree.getByRole('button', { name: 'parties', exact: true })).toBeVisible();
  await expect(otherTree.getByRole('link', { name: 'introduction.tex' })).toBeVisible();
  await expect(otherTree.getByRole('button', { name: 'chapitres', exact: true })).toBeVisible();

  // \input{chapitres/introduction} no longer finds the chapter: the count says so.
  await page.getByRole('button', { name: "Réglages de l'éditeur" }).click();
  await expect(page.getByText('2 mots')).toBeVisible();
  await expect(
    page.getByText('Fichiers inclus introuvables : chapitres/introduction'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  if (!phone) {
    await tree
      .getByRole('link', { name: 'introduction.tex' })
      .dragTo(tree.getByRole('button', { name: 'Racine du projet', exact: true }));
    await expect(
      page.getByText('introduction.tex a été déplacé à la racine du projet.'),
    ).toBeVisible();
  }

  await other.close();
  await eraseAllProjects(page);
});

test('history on the database: a restoration puts back files whose paths were swapped', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'API journey: desktop only');
  await signIn(page);
  const id = await createProject(page);
  const api = `/api/projects/${id}`;
  const detail = async () =>
    (await (await page.request.get(api)).json()) as { files: { id: string; path: string }[] };
  const fileAt = async (path: string) => (await detail()).files.find((f) => f.path === path)!;
  const move = async (fileId: string, path: string) =>
    expect(
      (
        await page.request.patch(`${api}/files/${fileId}`, {
          headers: writeHeaders(page),
          data: { path },
        })
      ).status(),
    ).toBe(200);

  const version = await page.request.post(`${api}/versions`, {
    headers: writeHeaders(page),
    data: { label: 'Avant échange' },
  });
  expect(version.status()).toBe(201);
  const { id: versionId } = (await version.json()) as { id: string };
  const main = await fileAt('main.tex');
  const intro = await fileAt('chapitres/introduction.tex');
  await move(main.id, 'tmp.tex');
  await move(intro.id, 'main.tex');
  await move(main.id, 'chapitres/introduction.tex');

  const restored = await page.request.post(`${api}/versions/${versionId}/restore`, {
    headers: writeHeaders(page),
    data: {},
  });
  expect(restored.status()).toBe(201);
  expect(await restored.json()).toEqual({ restored: 2, removed: 0, kept: [] });
  expect((await fileAt('main.tex')).id).toBe(main.id);
  expect((await fileAt('chapitres/introduction.tex')).id).toBe(intro.id);

  await eraseAllProjects(page);
});
