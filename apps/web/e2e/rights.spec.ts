import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  closeHelpers,
  eraseAllProjects,
  forgetInvitations,
  shareProject,
  signInKept,
  testPhone,
} from './auth-helpers';

// End of step 8 (docs/spec.md, "Plan de développement"): the five roles follow the rights table,
// checked by the servers on every request. Kept accounts: sharing writes audit entries.

type Role = 'OWNER' | 'EDITOR' | 'SUPERVISOR' | 'REVIEWER' | 'VIEWER';

/** Read, comment and propose, apply a proposal, edit, share and delete (docs/spec.md). */
const TABLE: Record<Role, [boolean, boolean, boolean, boolean, boolean]> = {
  OWNER: [true, true, true, true, true],
  EDITOR: [true, true, true, true, false],
  SUPERVISOR: [true, true, false, false, false],
  REVIEWER: [true, true, false, false, false],
  VIEWER: [true, false, false, false, false],
};

const ROLES = Object.keys(TABLE) as Role[];

const ANCHOR = {
  start: { type: null, tname: 'content', item: { client: 1, clock: 4 }, assoc: 0 },
  end: { type: null, tname: 'content', item: { client: 1, clock: 9 }, assoc: -1 },
};

/** The API as the signed-in user of a page (session cookie, same origin). */
function api(page: Page) {
  const headers = () => ({
    origin: new URL(page.url()).origin,
    'content-type': 'application/json',
  });
  return {
    get: (path: string) => page.request.get(`/api/${path}`),
    post: (path: string, data: object = {}) =>
      page.request.post(`/api/${path}`, { headers: headers(), data }),
    patch: (path: string, data: object) =>
      page.request.patch(`/api/${path}`, { headers: headers(), data }),
    delete: (path: string) => page.request.delete(`/api/${path}`, { headers: headers(), data: {} }),
  };
}

async function newPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR' });
  return context.newPage();
}

test.afterAll(async () => {
  await closeHelpers();
});

test('the five roles follow the rights table, on the API and in the editor', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Five accounts side by side: desktop only');
  test.setTimeout(240_000);

  const pages = new Map<Role, Page>([['OWNER', page]]);
  const phones = new Map<Role, string>();
  for (const [index, role] of ROLES.entries()) {
    const phone = testPhone('desktop', 30 + index);
    const rolePage = role === 'OWNER' ? page : await newPage(browser, baseURL);
    await signInKept(rolePage, phone);
    pages.set(role, rolePage);
    phones.set(role, phone.e164);
  }
  await eraseAllProjects(page);
  await forgetInvitations([...phones.values()]);

  const owner = api(page);
  const created = await owner.post('projects', { name: 'Tableau des droits' });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const detail = await (await owner.get(`projects/${id}`)).json();
  const mainId = (detail.files as { id: string; path: string }[]).find(
    (file) => file.path === 'main.tex',
  )!.id;
  for (const role of ROLES.slice(1)) {
    await shareProject(id, phones.get(role)!, role as Exclude<Role, 'OWNER'>);
  }
  const viewerId = (await (await api(pages.get('VIEWER')!).get('auth/me')).json()).user.id;

  const proposal = async (text: string) =>
    (
      await (
        await owner.post(`projects/${id}/comments`, {
          fileId: mainId,
          anchor: ANCHOR,
          quotedText: 'article',
          body: `Proposition ${text}`,
          suggestedText: text,
        })
      ).json()
    ).id as string;

  for (const role of ROLES) {
    const [read, comment, apply, edit, share] = TABLE[role];
    const as = api(pages.get(role)!);
    const expectStatus = async (
      response: Promise<{ status(): number }>,
      allowed: boolean,
      ok: number,
    ) => expect((await response).status(), role).toBe(allowed ? ok : 403);

    // Read: the project, its text, its comments, its sharing panel.
    const project = await as.get(`projects/${id}`);
    expect(project.status(), role).toBe(read ? 200 : 404);
    expect((await project.json()).rights, role).toMatchObject({
      read,
      comment,
      applySuggestion: apply,
      edit,
      share,
    });
    expect((await as.get(`projects/${id}/files/${mainId}/content`)).status(), role).toBe(200);
    expect((await as.get(`projects/${id}/comments`)).status(), role).toBe(200);

    // Comment, answer, propose a replacement.
    await expectStatus(
      as.post(`projects/${id}/comments`, {
        fileId: mainId,
        anchor: ANCHOR,
        quotedText: 'article',
        body: `Commentaire de ${role}`,
        suggestedText: 'report',
      }),
      comment,
      201,
    );
    const target = await proposal(`pour ${role}`);
    await expectStatus(
      as.post(`projects/${id}/comments/${target}/replies`, { body: 'Réponse.' }),
      comment,
      201,
    );

    // Apply or refuse a proposal.
    await expectStatus(
      as.post(`projects/${id}/comments/${target}/suggestion`, { decision: 'REJECTED' }),
      apply,
      200,
    );
    await expectStatus(
      as.post(`projects/${id}/comments/${await proposal(`appliquée par ${role}`)}/suggestion`, {
        decision: 'APPLIED',
        anchor: ANCHOR,
      }),
      apply,
      200,
    );

    // Edit: create a file, change the engine.
    await expectStatus(
      as.post(`projects/${id}/files`, { path: `${role.toLowerCase()}.tex` }),
      edit,
      201,
    );
    await expectStatus(as.patch(`projects/${id}`, { engine: 'XELATEX' }), edit, 200);

    // Share: invite, change a role, create and revoke the public link.
    await expectStatus(
      as.post(`projects/${id}/invitations`, {
        channel: 'email',
        email: `droits-${role.toLowerCase()}@example.org`,
        role: 'SUPERVISOR',
      }),
      share,
      201,
    );
    await expectStatus(
      as.patch(`projects/${id}/members/${viewerId}`, { role: 'VIEWER' }),
      share,
      200,
    );
    const link = await as.post(`projects/${id}/links`, {});
    expect(link.status(), role).toBe(share ? 201 : 403);
    if (share) {
      const { id: linkId } = (await link.json()) as { id: string };
      expect((await as.delete(`projects/${id}/links/${linkId}`)).status()).toBe(204);
    }
  }

  // In the editor: the reader neither writes nor comments; the reviewer comments, read-only.
  const code = (rolePage: Page) => rolePage.getByRole('textbox', { name: 'Code de main.tex' });
  for (const role of ['VIEWER', 'REVIEWER', 'SUPERVISOR', 'EDITOR'] as const) {
    const rolePage = pages.get(role)!;
    await rolePage.goto(`/fr/app/projects/${id}/edit`);
    await expect(code(rolePage)).toContainText('\\begin{document}');
    const comment = rolePage.getByRole('button', { name: 'Commenter la sélection' });
    if (role === 'VIEWER') await expect(comment).toHaveCount(0);
    else await expect(comment.first()).toBeVisible();

    // A notice proper to the role.
    const notice = {
      VIEWER: 'Vous avez accès à ce projet en lecture',
      REVIEWER: 'Vous pouvez commenter et proposer des modifications, sans modifier les fichiers.',
      SUPERVISOR:
        'Vous pouvez commenter et proposer des modifications, sans modifier les fichiers.',
      EDITOR: null,
    }[role];
    if (notice) await expect(rolePage.getByText(notice).first()).toBeVisible();

    // Comment in one click: a "+" in the margin of the line under the pointer (a line away from
    // the cursors of the others, whose name labels sit at the start of the file). The margins of
    // CodeMirror are hidden from assistive technologies: the "+" is found by its class.
    await code(rolePage).locator('.cm-line', { hasText: '\\maketitle' }).hover();
    const plus = rolePage.locator('.cm-commentLine');
    if (role === 'VIEWER') await expect(plus).toHaveCount(0);
    else await expect(plus).toBeVisible();

    // The plan of the owner ("Votre offre") is shown to the owner and editors only.
    await rolePage.getByRole('button', { name: 'Réglages de compilation' }).click();
    const plan = rolePage.getByText(/Votre offre :/);
    if (role === 'EDITOR') await expect(plan).toBeVisible();
    else await expect(plan).toHaveCount(0);
    await rolePage.keyboard.press('Escape');
    // The reviewer selects the text to comment it, but nothing typed reaches the document.
    await expect(code(rolePage)).toHaveAttribute(
      'contenteditable',
      role === 'VIEWER' ? 'false' : 'true',
    );
    if (role === 'REVIEWER') {
      await code(rolePage).locator('.cm-line').first().click();
      await rolePage.keyboard.type('refusé');
      await expect(code(rolePage)).not.toContainText('refusé');
    }
  }

  // Delete: the owner only, last.
  for (const role of ROLES.slice(1)) {
    expect((await api(pages.get(role)!).post(`projects/${id}/trash`)).status(), role).toBe(403);
  }
  expect((await owner.post(`projects/${id}/trash`)).status()).toBe(204);
  await eraseAllProjects(page);
});
