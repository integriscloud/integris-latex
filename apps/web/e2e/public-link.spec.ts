import { expect, test } from '@playwright/test';
import { closeHelpers, eraseAllProjects, signInKept, testPhone } from './auth-helpers';

// The public link as a visitor gets it: created and copied from the editor, opened without a
// session, behind HTTP Basic authentication like latex-dev (Nginx). Kept account (audit entries).

test.afterAll(async () => {
  await closeHelpers();
});

test('a public link copied from the editor opens without a session, behind the HTTP authentication of latex-dev', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Two browsers side by side: desktop only');
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInKept(page, testPhone('desktop', 39));
  await eraseAllProjects(page);
  const created = await page.request.post('/api/projects', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { name: 'MémoireTest' },
  });
  const { id } = (await created.json()) as { id: string };

  // Created from the editor, PDF only, no expiry; copied with the button.
  await page.goto(`/fr/app/projects/${id}/edit`);
  await page.getByRole('button', { name: 'Partager' }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('checkbox', { name: 'Inclure les fichiers source (lecture seule)' }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Créer le lien public' }).click();
  const field = dialog.getByLabel('Adresse du lien');
  await expect(field).toHaveValue(new RegExp(`^${process.env.PUBLIC_WEB_URL}/fr/p/[\\w-]{43}$`));
  await expect(dialog.getByText('PDF seul · sans expiration')).toBeVisible();
  await dialog.getByRole('button', { name: 'Copier le lien' }).click();
  await expect(dialog.getByRole('button', { name: 'Lien copié' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await field.inputValue());

  // A private window: no session cookie. latex-dev sits behind Nginx Basic authentication: the
  // browser sends its credentials on every request it makes with credentials, and a fetch with
  // `credentials: 'omit'` gets a 401 from Nginx. Basic credentials and cookies are both
  // "credentials" for fetch: the front is simulated with a cookie the browser keeps for the site.
  const visitorContext = await browser.newContext({ baseURL, locale: 'fr-FR' });
  const host = new URL(baseURL!).hostname;
  await visitorContext.addCookies([{ name: 'front-auth', value: 'ok', domain: host, path: '/' }]);
  await visitorContext.route('**/*', (route) =>
    (route.request().headers().cookie ?? '').includes('front-auth=ok')
      ? route.continue()
      : route.fulfill({
          status: 401,
          headers: { 'Content-Type': 'text/html' },
          body: '<html><body>401 Authorization Required</body></html>',
        }),
  );
  const visitor = await visitorContext.newPage();
  await visitor.goto(new URL(copied).pathname);
  await expect(visitor.getByRole('heading', { name: 'MémoireTest' })).toBeVisible();
  await expect(visitor.getByText('Pas encore de PDF')).toBeVisible();
  await expect(visitor.getByText("Ce lien n'est plus valide")).toHaveCount(0);

  await eraseAllProjects(page);
  await visitorContext.close();
});
