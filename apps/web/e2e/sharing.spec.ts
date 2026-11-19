import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  eraseAllProjects,
  forgetInvitations,
  forgetMessages,
  lastSmsLink,
  signInKept,
  testPhone,
} from './auth-helpers';

// Sharing from the project page, invitation accepted by SMS link, anchored comments with a
// replacement proposal applied in one click, public links. Kept accounts (audit entries).

async function newPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR' });
  return context.newPage();
}

const code = (page: Page) => page.getByRole('textbox', { name: 'Code de main.tex' });
const dialog = (page: Page) => page.getByRole('dialog');

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

test.afterAll(async () => {
  await closeHelpers();
});

test('share by phone with a role, accept, comment with a proposal, apply it; public link', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Several accounts side by side: desktop only');
  test.setTimeout(300_000);
  const ownerPhone = testPhone('desktop', 36);
  const reviewerPhone = testPhone('desktop', 37);
  const thirdPhone = testPhone('desktop', 38);
  const reviewer = await newPage(browser, baseURL);
  await signInKept(page, ownerPhone);
  await signInKept(reviewer, reviewerPhone);
  await eraseAllProjects(page);
  await eraseAllProjects(reviewer);
  await forgetInvitations([reviewerPhone.e164, thirdPhone.e164]);
  await forgetMessages(reviewerPhone.e164);

  const response = await page.request.post('/api/projects', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { name: 'Mémoire partagé' },
  });
  const { id } = (await response.json()) as { id: string };

  // ── The owner shares from the project page (Gratuit: one collaborator, supervisors free).
  await page.goto(`/fr/app/projects/${id}`);
  await page.getByRole('button', { name: 'Partager' }).click();
  await expect(
    dialog(page).getByRole('heading', { name: 'Partager « Mémoire partagé »' }),
  ).toBeVisible();
  await dialog(page).getByLabel('Numéro de téléphone').fill(reviewerPhone.local);
  await dialog(page)
    .getByRole('radio', { name: /Relecteur/ })
    .check();
  await dialog(page).getByLabel('Message').fill('Bonjour, voici le chapitre 2.');
  await dialog(page).getByRole('button', { name: "Envoyer l'invitation par SMS" }).click();
  await expect(dialog(page).getByText("Invitation envoyée. L'accès sera donné")).toBeVisible();
  await expect(dialog(page).getByText(/Invitation en attente · Relecteur/)).toBeVisible();
  await expect(dialog(page).getByText('Collaborateurs : 1 sur 1', { exact: false })).toBeVisible();

  await dialog(page).getByLabel('Numéro de téléphone').fill(thirdPhone.local);
  await dialog(page)
    .getByRole('radio', { name: /Éditeur/ })
    .check();
  await dialog(page).getByRole('button', { name: "Envoyer l'invitation par SMS" }).click();
  await expect(
    dialog(page).getByText(/Votre offre permet 1 collaborateur par projet/),
  ).toBeVisible();
  await expect(dialog(page).getByRole('link', { name: 'Voir les offres' })).toBeVisible();
  await dialog(page)
    .getByRole('radio', { name: /Encadrant/ })
    .check();
  await dialog(page).getByRole('button', { name: "Envoyer l'invitation par SMS" }).click();
  await expect(dialog(page).getByText(/Invitation en attente · Encadrant/)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Fermer' }).first().click();

  // ── The invitee opens the SMS link: the message is shown, never in the SMS itself.
  const link = new URL(await lastSmsLink(reviewerPhone.e164));
  await reviewer.goto(`${link.pathname}${link.hash}`);
  await expect(
    reviewer.getByText('vous invite à collaborer sur « Mémoire partagé »'),
  ).toBeVisible();
  await expect(reviewer.getByText('Bonjour, voici le chapitre 2.')).toBeVisible();
  await reviewer.getByRole('button', { name: 'Accepter et ouvrir le projet' }).click();
  await expect(reviewer).toHaveURL(new RegExp(`/fr/app/projects/${id}$`));
  await expect(reviewer.getByText('Relecteur', { exact: true }).first()).toBeVisible();

  // ── Both open the editor; the reviewer comments a selection with a proposal.
  await page.goto(`/fr/app/projects/${id}/edit`);
  await reviewer.goto(`/fr/app/projects/${id}/edit`);
  await expect(code(page)).toContainText('\\begin{document}');
  await code(page).locator('.cm-line').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Les débits mesurés baissent.');
  await expect(code(reviewer)).toContainText('Les débits mesurés baissent.');

  await code(reviewer).locator('.cm-line', { hasText: 'Les débits mesurés baissent.' }).click();
  await reviewer.keyboard.press('Home');
  await reviewer.keyboard.press('Shift+End');
  await reviewer.getByRole('button', { name: 'Commenter la sélection' }).first().click();
  await reviewer.getByLabel('Votre commentaire').fill('Précisez la station.');
  await reviewer.getByRole('checkbox', { name: 'Proposer un remplacement' }).check();
  await reviewer.getByLabel('Texte proposé').fill('Les débits mesurés à Wayen baissent.');
  await reviewer.getByRole('button', { name: 'Publier' }).click();
  await expect(reviewer.locator('.cm-comment')).toHaveText('Les débits mesurés baissent.');

  // The owner sees it at once, highlighted; text typed around does not move it.
  await page
    .getByRole('button', { name: "Afficher les commentaires, les soumissions et l'historique" })
    .click();
  await expect(page.getByText('Précisez la station.')).toBeVisible();
  await expect(page.locator('.cm-comment')).toHaveText('Les débits mesurés baissent.');
  await code(page).locator('.cm-line', { hasText: 'Les débits mesurés baissent.' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('En 2025, ');
  // Last line of the file (End would stop at the name label of the other cursor).
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Source : DGRE.');
  await expect(code(reviewer)).toContainText(
    'En 2025, Les débits mesurés baissent. Source : DGRE.',
  );
  await expect(reviewer.locator('.cm-comment')).toHaveText('Les débits mesurés baissent.');
  await expect(page.locator('.cm-comment')).toHaveText('Les débits mesurés baissent.');

  // The reviewer cannot apply; the owner applies in one click, everyone sees the new text.
  await expect(reviewer.getByRole('button', { name: 'Appliquer', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Appliquer', exact: true }).click();
  await expect(page.getByText(/Appliquée par/)).toBeVisible();
  await expect
    .poll(() => plainText(reviewer))
    .toContain('En 2025, Les débits mesurés à Wayen baissent. Source : DGRE.');
  await expect(reviewer.getByText(/Appliquée par/)).toBeVisible();

  // ── Comment in one click: the "+" in the margin comments the whole line; dated "à l'instant".
  await code(reviewer).locator('.cm-line', { hasText: '\\maketitle' }).hover();
  await reviewer.locator('.cm-commentLine').click();
  await expect(reviewer.getByText('« \\maketitle »')).toBeVisible();
  await reviewer.getByLabel('Votre commentaire').fill('Ajoutez la date de soutenance.');
  await reviewer.getByRole('button', { name: 'Publier' }).click();
  const card = reviewer.getByRole('article').filter({ hasText: 'Ajoutez la date de soutenance.' });
  await expect(card.getByText("· à l'instant")).toBeVisible();
  await expect(reviewer.locator('.cm-comment', { hasText: '\\maketitle' })).toBeVisible();

  // ── Public link: PDF only by default, then with the sources; revoked at once.
  const visitor = await newPage(browser, baseURL);
  await page.getByRole('button', { name: 'Partager' }).click();
  await dialog(page).getByRole('button', { name: 'Créer le lien public' }).click();
  const address = dialog(page).getByLabel('Adresse du lien');
  await expect(address).toHaveValue(/\/fr\/p\/[\w-]{43}$/);
  const publicUrl = new URL(await address.inputValue());
  await visitor.goto(publicUrl.pathname);
  await expect(visitor.getByRole('heading', { name: 'Mémoire partagé' })).toBeVisible();
  await expect(visitor.getByText('Pas encore de PDF')).toBeVisible();
  await expect(visitor.getByText('Fichiers source')).toHaveCount(0);
  await expect(visitor.getByText('Précisez la station.')).toHaveCount(0);
  const robots = await visitor.request.get(publicUrl.pathname);
  expect(robots.headers()['x-robots-tag']).toBe('noindex, nofollow');

  await dialog(page).getByRole('button', { name: 'Révoquer le lien' }).click();
  await visitor.reload();
  await expect(visitor.getByText("Ce lien n'est plus valide")).toBeVisible();

  await dialog(page)
    .getByRole('checkbox', { name: 'Inclure les fichiers source (lecture seule)' })
    .check();
  await dialog(page).getByRole('button', { name: 'Créer le lien public' }).click();
  const withSources = new URL(await dialog(page).getByLabel('Adresse du lien').inputValue());
  await visitor.goto(withSources.pathname);
  await visitor.getByRole('link', { name: 'main.tex' }).click();
  await expect(visitor.getByLabel('main.tex')).toContainText(
    'Les débits mesurés à Wayen baissent.',
  );

  await eraseAllProjects(page);
});

test('on a phone, a long press on a line comments it', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'Touch screens only');
  test.setTimeout(120_000);
  await signInKept(page, testPhone('mobile', 36));
  await eraseAllProjects(page);
  const response = await page.request.post('/api/projects', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { name: 'Mémoire sur téléphone' },
  });
  const { id } = (await response.json()) as { id: string };
  await page.goto(`/fr/app/projects/${id}/edit`);
  const line = code(page).locator('.cm-line', { hasText: '\\maketitle' });
  await expect(line).toBeVisible();

  // A finger held still on the line (Chromium touch events).
  const box = (await line.boundingBox())!;
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect(page.getByText('« \\maketitle »')).toBeVisible();
  await page.getByLabel('Votre commentaire').fill('Ajoutez la date.');
  await page.getByRole('button', { name: 'Publier' }).click();
  await expect(page.getByText('Ajoutez la date.')).toBeVisible();
  await eraseAllProjects(page);
});
