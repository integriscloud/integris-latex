import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  deleteTestUsers,
  eraseAllProjects,
  shareProject,
  signUp,
  testPhone,
} from './auth-helpers';

// Restoration is covered by the API tests: it writes an append-only audit entry, which the
// shared development database must not receive from tests.

const created: string[] = [];

test.afterAll(async () => {
  await deleteTestUsers(created);
  await closeHelpers();
});

const code = (page: Page) => page.getByRole('textbox', { name: 'Code de main.tex' });

async function account(page: Page, index: number) {
  const phone = testPhone(test.info().project.name, 90 + index);
  created.push(phone.e164);
  await signUp(page, phone);
  return phone;
}

/** Text of the editor without the cursors of the others (their name labels). */
const plainText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-line')]
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('.cm-ySelectionCaret').forEach((caret) => caret.remove());
        return copy.textContent;
      })
      .join('\n'),
  );

async function typeAtEnd(page: Page, text: string) {
  await code(page).locator('.cm-line').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

async function secondPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR' });
  return context.newPage();
}

test('two people edit the same file live; a reader cannot write; versions are named', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Two browsers side by side: desktop only');
  test.setTimeout(180_000);
  const other = await secondPage(browser, baseURL);
  await account(page, 1);
  const second = await account(other, 2);

  const response = await page.request.post('/api/projects', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { name: 'Mémoire à deux' },
  });
  const { id } = (await response.json()) as { id: string };
  await shareProject(id, second.e164, 'EDITOR');

  await page.goto(`/fr/app/projects/${id}/edit`);
  await other.goto(`/fr/app/projects/${id}/edit`);
  await expect(code(page)).toContainText('\\begin{document}');
  await expect(code(other)).toContainText('\\begin{document}');

  // Each one sees the other's text as it is typed, and where the other is.
  await typeAtEnd(page, 'Texte de la première personne.');
  await expect(code(other)).toContainText('Texte de la première personne.');
  await typeAtEnd(other, 'Texte de la seconde personne.');
  await expect(code(page)).toContainText('Texte de la seconde personne.');
  await expect(page.getByRole('list', { name: 'Personnes en ligne sur ce projet' })).toContainText(
    'Awa Kaboré (main.tex)',
  );
  await expect(page.locator('.cm-ySelectionCaret')).toHaveCount(1);
  // The other's name always shows on their cursor, not only on hover.
  const label = page.locator('.cm-ySelectionInfo');
  await expect(label).toHaveText('Awa Kaboré');
  await expect(label).toHaveCSS('opacity', '1');
  await page.screenshot({ path: test.info().outputPath('cursors.png') });
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await expect.poll(() => plainText(other)).toBe(await plainText(page));

  // Made a reader: the server refuses the changes, whatever the page does.
  await shareProject(id, second.e164, 'VIEWER');
  await other.reload();
  await expect(code(other)).toContainText('Texte de la seconde personne.');
  await expect(other.getByText('Lecture seule', { exact: true })).toBeVisible();
  await expect(code(other)).toHaveAttribute('contenteditable', 'false');
  await other.evaluate(() => {
    // Even a forced edit of the page stays local: the server never takes it.
    const content = document.querySelector('.cm-content') as HTMLElement;
    content.setAttribute('contenteditable', 'true');
  });
  await code(other).locator('.cm-line').first().click();
  await other.keyboard.type('Interdit');
  await typeAtEnd(page, 'Dernière ligne.');
  await expect(code(other)).toContainText('Dernière ligne.');
  await expect(code(page)).not.toContainText('Interdit');

  // A named version, then a change: the version shows what changed since.
  await page.getByRole('button', { name: /Afficher les commentaires/ }).click();
  await page.getByRole('tab', { name: 'Historique' }).click();
  await page.getByRole('button', { name: 'Nommer cette version' }).click();
  await page.getByLabel('Nom de la version').fill('Chapitre 1 terminé');
  await page.getByRole('button', { name: 'Enregistrer la version' }).click();
  await expect(page.getByRole('button', { name: /Chapitre 1 terminé/ })).toBeVisible();
  await typeAtEnd(page, 'Après la version.');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Chapitre 1 terminé/ }).click();
  await expect(page.getByRole('button', { name: 'Restaurer tout le projet' })).toBeVisible();
  await expect(
    page
      .getByRole('tabpanel', { name: 'Historique' })
      .getByRole('listitem')
      .filter({ hasText: 'main.tex' }),
  ).toContainText('Modifié depuis');
  await page.getByRole('button', { name: 'main.tex', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'main.tex dans cette version' });
  await expect(preview).toContainText('Dernière ligne.');
  await expect(preview).not.toContainText('Après la version.');
  await preview.getByRole('button', { name: 'Fermer' }).first().click();

  // The reader sees the history but neither names nor restores.
  await other.getByRole('button', { name: /Afficher les commentaires/ }).click();
  await other.getByRole('tab', { name: 'Historique' }).click();
  await expect(other.getByRole('button', { name: /Chapitre 1 terminé/ })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Nommer cette version' })).toHaveCount(0);

  await eraseAllProjects(page);
  await other.context().close();
});
