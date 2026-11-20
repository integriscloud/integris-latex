import { expect, type Page, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { closeHelpers, deleteTestUsers, signUp, testPhone } from './auth-helpers';

// Plans, quotas and usage (step 10): `pnpm dev:plan` gives a plan without payment; at the end of
// the subscription, the projects beyond the FREE limit become read-only and nothing is deleted.

const created: string[] = [];
const devTools = fileURLToPath(new URL('../../api/scripts/dev-tools.mjs', import.meta.url));

test.afterAll(async () => {
  await deleteTestUsers(created);
  await closeHelpers();
});

const devPlan = async (phone: string, plan: string) =>
  (await promisify(execFile)('node', [devTools, 'plan', phone, plan])).stdout;

async function api(page: Page, method: 'post' | 'get', path: string, data: object = {}) {
  const headers = { origin: new URL(page.url()).origin, 'content-type': 'application/json' };
  const response =
    method === 'get'
      ? await page.request.get(`/api/${path}`)
      : await page.request.post(`/api/${path}`, { headers, data });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return response.status() === 204 ? null : response.json();
}

test('end of a subscription: read-only beyond the FREE limits, swap, trash, usage page', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const phone = testPhone(test.info().project.name, 85);
  created.push(phone.e164);
  await signUp(page, phone);

  // STANDARD: more projects than FREE allows.
  expect(await devPlan(phone.e164, 'STANDARD')).toContain('now holds STANDARD');
  const ids: Record<string, string> = {};
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    ids[name] = (await api(page, 'post', 'projects', { name })).id;
  }
  await page.goto('/fr/app/usage');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ma consommation');
  await expect(page.getByText("Abonnement Standard : jusqu'au", { exact: false })).toBeVisible();

  // Back to FREE: Alpha, the least recently active, becomes read-only; nothing is deleted.
  expect(await devPlan(phone.e164, 'FREE')).toContain(
    'Projects switched (read-only ⇄ writable): 1',
  );
  await page.reload();
  await expect(
    page.getByText('Vous avez atteint le nombre de projets de votre offre', { exact: false }),
  ).toBeVisible();
  const usage = await api(page, 'get', 'usage');
  expect(usage.readOnly.map((p: { name: string }) => p.name)).toEqual(['Alpha']);
  expect(usage.writable).toHaveLength(3);
  expect(usage.projects).toMatchObject({ used: 4, max: 3, level: 'full' });

  // A read-only project: no compilation, shared for reading only, still readable.
  await page.goto(`/fr/app/projects/${ids.Alpha}`);
  await expect(
    page.getByText('Ce projet est en lecture seule : il dépasse le nombre de projets', {
      exact: false,
    }),
  ).toBeVisible();
  const compile = await page.request.post(`/api/projects/${ids.Alpha}/compile`, {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: {},
  });
  expect(compile.status()).toBe(403);

  // Swap from the project page: Alpha becomes writable, Bravo read-only.
  await page.getByRole('button', { name: 'Rendre ce projet modifiable' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Bravo', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Rendre modifiable' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Rendre ce projet modifiable' })).toBeHidden();
  expect((await api(page, 'get', 'usage')).readOnly.map((p: { name: string }) => p.name)).toEqual([
    'Bravo',
  ]);

  // The trash frees a place: Bravo is writable again.
  await api(page, 'post', `projects/${ids.Delta}/trash`);
  await page.goto('/fr/app/usage');
  await expect(page.getByText('Lecture seule', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rendre modifiable' })).toHaveCount(0);
  await expect(page.getByText('Compilations cette heure-ci')).toBeVisible();
});
