import { expect, type Page, test } from '@playwright/test';
import { crc32, deflateRawSync } from 'node:zlib';
import { closeHelpers, deleteTestUsers, eraseAllProjects, signUp, testPhone } from './auth-helpers';

const created: string[] = [];

test.afterAll(async () => {
  await deleteTestUsers(created);
  await closeHelpers();
});

const MAIN = '\\documentclass{article}\n\\begin{document}\nBonjour\n\\end{document}\n';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** Minimal ZIP writer (deflate), enough to build test archives. */
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflateRawSync(data);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, packed);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function newAccount(page: Page, index: number) {
  const phone = testPhone(test.info().project.name, 50 + index);
  created.push(phone.e164);
  await signUp(page, phone);
}

/**
 * Types the project name once the form is interactive: on a loaded development server, a value
 * typed before hydration is lost and the submit button stays disabled.
 */
async function fillName(page: Page, name: string) {
  const submit = page.getByRole('button', { name: /^(Créer le projet|Importer)$/ });
  await expect(async () => {
    await page.getByLabel('Nom du projet').fill(name);
    await expect(page.getByLabel('Nom du projet')).toHaveValue(name, { timeout: 500 });
    if (name) await expect(submit).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

/** Opens the side menu on phones, where it is hidden. */
async function openMenu(page: Page) {
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' });
  if (await menu.isVisible()) await menu.click();
}

test('create a project, upload files, import a ZIP, use the trash', async ({ page }) => {
  // A long journey: more than the default 30 s when every suite runs in parallel.
  test.setTimeout(90_000);
  await newAccount(page, 1);
  await expect(page.getByText("Aucun projet pour l'instant")).toBeVisible();

  // Empty project.
  await page.getByRole('link', { name: 'Nouveau projet' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nouveau projet');
  await fillName(page, 'Mémoire de test');
  await page.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mémoire de test');
  await expect(page.getByText('Fichier principal : main.tex')).toBeVisible();

  // Upload: an accepted image, then a refused type.
  const picker = page.getByLabel(/Choisir des fichiers/);
  await picker.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  // The tree row (the progress line also names the file).
  await expect(page.getByRole('button', { name: 'Actions de logo.png' })).toBeVisible();
  // The result is shown under the drop zone and scrolled into view.
  await expect(page.getByText('1 fichier téléversé.')).toBeInViewport();
  await picker.setInputFiles({
    name: 'dessin.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(
    page.getByText("dessin.svg : Ce type de fichier n'est pas accepté."),
  ).toBeInViewport();
  await expect(page.getByText('1 fichier téléversé.')).toHaveCount(0);
  await picker.setInputFiles({
    name: 'faux.png',
    mimeType: 'image/png',
    buffer: Buffer.from('pas une image'),
  });
  await expect(page.getByText(/faux\.png : Le contenu du fichier ne correspond pas/)).toBeVisible();

  // New folder, then a new text file in it, by name only: it opens in the editor.
  await page.getByRole('button', { name: 'Nouveau dossier', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Nom').fill('chapitres');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'chapitres', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nouveau fichier', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Dans le dossier')).toHaveValue('chapitres');
  await page.getByRole('dialog').getByLabel('Nom').fill('introduction');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\?file=/);
  await expect(
    page.getByRole('textbox', { name: 'Code de chapitres/introduction.tex' }),
  ).toBeVisible();

  // ZIP import with a file left out.
  await page.goto('/fr/app/new?tab=zip');
  await page.getByLabel(/Choisir une archive ZIP/).setInputFiles({
    name: 'export-overleaf.zip',
    mimeType: 'application/zip',
    buffer: zip({ 'these/main.tex': MAIN, 'these/fig.png': PNG, 'these/latexmkrc': 'x' }),
  });
  await expect(page.getByLabel('Nom du projet')).toHaveValue('export-overleaf');
  await page.getByRole('button', { name: 'Importer' }).click();
  await expect(page.getByText('2 fichiers importés.')).toBeVisible();
  await expect(page.getByText('latexmkrc')).toBeVisible();
  await page.getByRole('link', { name: 'Ouvrir le projet' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('export-overleaf');

  // An unsafe archive is refused as a whole.
  await page.goto('/fr/app/new?tab=zip');
  await page.getByLabel(/Choisir une archive ZIP/).setInputFiles({
    name: 'piege.zip',
    mimeType: 'application/zip',
    buffer: zip({ 'main.tex': MAIN, '../../etc/x.tex': MAIN }),
  });
  await page.getByRole('button', { name: 'Importer' }).click();
  await expect(page.getByText(/Cette archive a été refusée/)).toBeVisible();

  // Trash: move, restore, move again, erase for good.
  await page.goto('/fr/app');
  await expect(page.getByRole('link', { name: 'Mémoire de test' })).toBeVisible();
  await page.getByRole('button', { name: 'Mettre « Mémoire de test » à la corbeille' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mettre à la corbeille' }).click();
  await expect(page.getByRole('link', { name: 'Mémoire de test' })).toHaveCount(0);

  await openMenu(page);
  await page.getByRole('link', { name: 'Corbeille' }).click();
  await expect(page.getByText('Mémoire de test')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restaurer' }).click();
  await expect(page.getByText('La corbeille est vide')).toBeVisible();

  await page.goto('/fr/app');
  await page.getByRole('button', { name: 'Mettre « Mémoire de test » à la corbeille' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mettre à la corbeille' }).click();
  await page.goto('/fr/app/trash');
  await page.getByRole('button', { name: 'Supprimer définitivement' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer définitivement' }).click();
  await expect(page.getByText('La corbeille est vide')).toBeVisible();

  await eraseAllProjects(page);
});

test('the FREE plan blocks a 4th project with an upgrade offer', async ({ page }) => {
  await newAccount(page, 2);
  for (const name of ['Un', 'Deux', 'Trois']) {
    await page.goto('/fr/app/new');
    await fillName(page, name);
    await page.getByRole('button', { name: 'Créer le projet' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  }
  await page.goto('/fr/app');
  await expect(page.getByText(/Vous avez atteint la limite de 3 projets/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Voir les offres' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nouveau projet' })).toHaveCount(0);
  await page.goto('/fr/app/new');
  await expect(page.getByRole('button', { name: 'Créer le projet' })).toHaveCount(0);

  // Templates are offered once a slot is free again.
  await page.goto('/fr/app');
  await page.getByRole('button', { name: 'Mettre « Trois » à la corbeille' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mettre à la corbeille' }).click();
  await page.goto('/fr/app/new?tab=template');
  await page.getByText('Mémoire', { exact: true }).click();
  await expect(page.getByLabel('Nom du projet')).toHaveValue('Mémoire');
  await page.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page.getByRole('button', { name: 'chapitres', exact: true })).toBeVisible();

  await eraseAllProjects(page);
});

test('a project of another user is not reachable', async ({ page }) => {
  await newAccount(page, 3);
  const response = await page.request.get('/api/projects/does-not-exist');
  expect(response.status()).toBe(404);
  await page.goto('/fr/app/projects/does-not-exist');
  await expect(page.getByText(/404|introuvable|could not be found/i).first()).toBeVisible();
});
