import type { ProjectRole, User } from '@integris/db';
import type { CommentAnchor, CommentInfo, ProjectSharing } from '@integris/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../auth/keys.js';
import { devMailKey } from '../mail/log-mail-sender.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { RedisService } from '../redis/redis.service.js';
import { devSmsKey } from '../sms/log-sms-sender.js';
import { ORIGIN } from '../test/auth-app.js';
import { type CompileTestApp, createCompileTestApp } from '../test/compile-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { SharingModule } from './sharing.module.js';

const ANCHOR: CommentAnchor = {
  start: { type: null, tname: 'content', item: { client: 1, clock: 4 }, assoc: 0 },
  end: { type: null, tname: 'content', item: { client: 1, clock: 9 }, assoc: -1 },
};

const ROLES = ['EDITOR', 'SUPERVISOR', 'REVIEWER', 'VIEWER'] as const;

describe('sharing, public links and comments API', () => {
  let ctx: CompileTestApp;
  let redis: RedisService;
  let published: unknown[];
  let owner: User;
  let invitee: User;
  let projectId: string;
  let mainId: string;

  const server = () => request(ctx.app.getHttpServer());
  const as = (user: User | null) => {
    const auth = (req: request.Test) => (user ? req.set(TEST_USER_HEADER, user.id) : req);
    const write = (req: request.Test) => auth(req.set('Origin', ORIGIN));
    return {
      get: (path: string) => auth(server().get(`/api/${path}`)),
      post: (path: string, body: object = {}) => write(server().post(`/api/${path}`)).send(body),
      patch: (path: string, body: object) => write(server().patch(`/api/${path}`)).send(body),
      delete: (path: string) => write(server().delete(`/api/${path}`)).send({}),
    };
  };

  const person = (name: string, phone: string, email?: string) => {
    const user = ctx.db.addUser(name);
    user.phone = phone;
    user.phoneVerifiedAt = new Date();
    if (email) {
      user.email = email;
      user.emailVerifiedAt = new Date();
    }
    return user;
  };

  const invite = (role: string, phone = '70 00 00 02', message?: string) =>
    as(owner).post(`projects/${projectId}/invitations`, {
      channel: 'phone',
      phone,
      dialCode: '226',
      role,
      message,
    });

  /** The token of the last invitation, read from the link of its SMS or e-mail. */
  const tokenOf = async (key: string) =>
    /#token=([\w-]{43})/.exec((await redis.client.get(key)) ?? '')![1]!;

  const audits = (action: string) => ctx.db.audits.filter((row) => row.action === action);

  beforeAll(async () => {
    ctx = await createCompileTestApp(
      {
        INVITATION_VIEWS_PER_HOUR_PER_TOKEN: '6',
        INVITATION_ACTIONS_PER_HOUR: '6',
        PUBLIC_LINK_READS_PER_HOUR_PER_TOKEN: '6',
      },
      [SharingModule],
    );
    redis = ctx.app.get(RedisService);
    vi.spyOn(ctx.app.get(ProjectEventsService), 'publish').mockImplementation(async (event) => {
      published.push(event);
    });
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.storage.objects.clear();
    await redis.client.flushdb();
    published = [];
    ctx.db.plans.find((plan) => plan.code === 'FREE')!.maxCollaboratorsPerProject = 1;
    ctx.db.plans.find((plan) => plan.code === 'STANDARD')!.maxCollaboratorsPerProject = 5;
    owner = person('Awa Kaboré', '+22670000001', 'awa@example.org');
    invitee = person('Issa Traoré', '+22670000002');
    ctx.db.personalPlans.set(owner.id, 'STANDARD');
    const created = await as(owner).post('projects', { name: 'Mémoire' }).expect(201);
    projectId = created.body.id;
    mainId = ctx.db.files.find((file) => file.projectId === projectId)!.id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx.app.close();
  });

  // ───────────── Rights table (docs/spec.md) ─────────────

  describe('rights table of the five roles, checked on every request', () => {
    const users = new Map<ProjectRole, User>();

    beforeEach(() => {
      users.clear();
      users.set('OWNER', owner);
      ROLES.forEach((role, index) => {
        const user = person(role, `+2267000001${index}`);
        ctx.db.share(projectId, user.id, role);
        users.set(role, user);
      });
    });

    /** What a role may do, per column: read, comment and propose, apply, edit, share and delete. */
    const TABLE: Record<ProjectRole, [boolean, boolean, boolean, boolean, boolean]> = {
      OWNER: [true, true, true, true, true],
      EDITOR: [true, true, true, true, false],
      SUPERVISOR: [true, true, false, false, false],
      REVIEWER: [true, true, false, false, false],
      VIEWER: [true, false, false, false, false],
    };

    for (const [role, [read, comment, apply, edit, share]] of Object.entries(TABLE)) {
      it(`${role}: read ${read}, comment ${comment}, apply ${apply}, edit ${edit}, share ${share}`, async () => {
        const user = users.get(role as ProjectRole)!;
        const api = as(user);
        const ok = (allowed: boolean, status = 200) => (allowed ? status : 403);

        // Read: the project, its files, its comments, its sharing panel.
        await api.get(`projects/${projectId}`).expect(200);
        await api.get(`projects/${projectId}/files/${mainId}/content`).expect(200);
        await api.get(`projects/${projectId}/comments`).expect(200);
        const panel = (await api.get(`projects/${projectId}/sharing`).expect(200)).body;
        expect(panel.canShare).toBe(share);
        const rights = (await api.get(`projects/${projectId}`)).body.rights;
        expect(rights).toMatchObject({ read, comment, applySuggestion: apply, edit, share });

        // Comment, answer, propose a replacement.
        const commented = await api
          .post(`projects/${projectId}/comments`, {
            fileId: mainId,
            anchor: ANCHOR,
            quotedText: 'article',
            body: 'Précisez.',
            suggestedText: 'report',
          })
          .expect(ok(comment, 201));
        const target = (
          await as(owner)
            .post(`projects/${projectId}/comments`, {
              fileId: mainId,
              anchor: ANCHOR,
              quotedText: 'article',
              body: 'Proposition du propriétaire.',
              suggestedText: 'book',
            })
            .expect(201)
        ).body as CommentInfo;
        await api
          .post(`projects/${projectId}/comments/${target.id}/replies`, { body: 'Réponse.' })
          .expect(ok(comment, 201));
        if (comment) expect(commented.body.suggestionStatus).toBe('PENDING');

        // Apply or refuse a proposal.
        await api
          .post(`projects/${projectId}/comments/${target.id}/suggestion`, { decision: 'REJECTED' })
          .expect(ok(apply));
        const second = (
          await as(owner)
            .post(`projects/${projectId}/comments`, {
              fileId: mainId,
              anchor: ANCHOR,
              quotedText: 'article',
              body: 'Autre proposition.',
              suggestedText: 'memoir',
            })
            .expect(201)
        ).body as CommentInfo;
        await api
          .post(`projects/${projectId}/comments/${second.id}/suggestion`, {
            decision: 'APPLIED',
            anchor: ANCHOR,
          })
          .expect(ok(apply));

        // Edit: create a file, change the main file (the collaboration server writes through
        // the same right: see collab-docs and the collab server tests).
        await api
          .post(`projects/${projectId}/files`, { path: `${role.toLowerCase()}.tex` })
          .expect(ok(edit, 201));
        await api.patch(`projects/${projectId}`, { engine: 'XELATEX' }).expect(ok(edit));

        // Share: invite, change a role, remove an access, public link.
        await api
          .post(`projects/${projectId}/invitations`, {
            channel: 'email',
            email: `${role.toLowerCase()}-guest@example.org`,
            role: 'VIEWER',
          })
          .expect(ok(share, 201));
        const viewer = users.get('VIEWER')!;
        await api
          .patch(`projects/${projectId}/members/${viewer.id}`, { role: 'VIEWER' })
          .expect(ok(share));
        await api.post(`projects/${projectId}/links`, {}).expect(ok(share, 201));

        // Delete (owner only), last.
        await api.post(`projects/${projectId}/trash`).expect(share ? 204 : 403);
      });
    }

    it('answers "not found" to someone without a role, for every request', async () => {
      const stranger = person('Inconnu', '+22670000099');
      const api = as(stranger);
      await api.get(`projects/${projectId}/sharing`).expect(404);
      await api.get(`projects/${projectId}/comments`).expect(404);
      await api
        .post(`projects/${projectId}/comments`, {
          fileId: mainId,
          anchor: ANCHOR,
          quotedText: 'x',
          body: 'x',
        })
        .expect(404);
      await api.post(`projects/${projectId}/links`, {}).expect(404);
    });
  });

  // ───────────── Invitations ─────────────

  describe('invitations', () => {
    it('sends an SMS with the link only, never the message nor any name', async () => {
      const response = await invite('REVIEWER', '70 00 00 02', 'Bonjour, voici mon chapitre 2.');
      expect(response.status).toBe(201);
      const sms = (await redis.client.get(devSmsKey('+22670000002')))!;
      expect(sms).toMatch(/^Integris LaTeX : .*\/fr\/invite#token=[\w-]{43}$/);
      expect(sms).not.toContain('chapitre');
      expect(sms).not.toContain('Mémoire');
      expect(sms).not.toContain('Awa');
      const panel = response.body as ProjectSharing;
      expect(panel.invitations).toMatchObject([
        { channel: 'phone', contact: '+22670000002', role: 'REVIEWER', counted: true },
      ]);
      expect(audits('PROJECT_INVITATION_SENT')).toHaveLength(1);
      // Only a hash of the token is stored.
      const token = await tokenOf(devSmsKey('+22670000002'));
      expect(ctx.db.invitations[0]!.tokenHash).toBe(sha256(token));
    });

    it('sends an e-mail with the role, the project and the message', async () => {
      await as(owner)
        .post(`projects/${projectId}/invitations`, {
          channel: 'email',
          email: 'Prof@Example.org',
          role: 'SUPERVISOR',
          message: 'Bonjour Professeur, voici le chapitre 2.',
        })
        .expect(201);
      const mail = (await redis.client.get(devMailKey('prof@example.org')))!;
      expect(mail).toContain('« Mémoire »');
      expect(mail).toContain('Encadrant');
      expect(mail).toContain('Bonjour Professeur, voici le chapitre 2.');
      expect(mail).toMatch(/\/fr\/invite#token=[\w-]{43}/);
    });

    it('refuses a message over 280 characters, a bad number, oneself, a member, a duplicate', async () => {
      await invite('REVIEWER', '70 00 00 02', 'x'.repeat(281)).expect(400);
      await invite('REVIEWER', '1234').expect(400, { code: 'invalid_contact' });
      await invite('REVIEWER', '+1 202 555 0143').expect(400, { code: 'country_not_allowed' });
      await invite('REVIEWER', '70 00 00 01').expect(409, { code: 'cannot_invite_self' });
      await invite('OWNER').expect(400);
      ctx.db.share(projectId, invitee.id, 'VIEWER');
      await invite('REVIEWER', '70 00 00 02').expect(409, { code: 'already_member' });
      await invite('REVIEWER', '70 00 00 03').expect(201);
      await invite('EDITOR', '70 00 00 03').expect(409, { code: 'already_invited' });
    });

    it('applies the collaborator limit of the owner plan: pending invitations count, supervisors never', async () => {
      ctx.db.personalPlans.delete(owner.id); // Gratuit: 1 collaborator
      await invite('REVIEWER', '70 00 00 02').expect(201);
      await invite('VIEWER', '70 00 00 03').expect(402, { code: 'collaborator_limit' });
      // Submitting to a supervisor is allowed on every plan.
      await invite('SUPERVISOR', '70 00 00 03').expect(201);
      await invite('SUPERVISOR', '70 00 00 04').expect(201);
      const panel = (await as(owner).get(`projects/${projectId}/sharing`)).body as ProjectSharing;
      expect(panel.collaborators).toEqual({ used: 1, max: 1 });
      // Cancelling the pending invitation frees its place.
      const pending = panel.invitations.find((item) => item.role === 'REVIEWER')!;
      await as(owner).delete(`projects/${projectId}/invitations/${pending.id}`).expect(204);
      expect(audits('PROJECT_INVITATION_REVOKED')).toHaveLength(1);
      await invite('EDITOR', '70 00 00 05').expect(201);
    });

    it('counts a supervisor turned editor, and blocks it above the limit', async () => {
      ctx.db.personalPlans.delete(owner.id);
      const supervisor = person('Pr Ouédraogo', '+22670000020');
      ctx.db.share(projectId, supervisor.id, 'SUPERVISOR');
      ctx.db.share(projectId, invitee.id, 'EDITOR');
      await as(owner)
        .patch(`projects/${projectId}/members/${supervisor.id}`, { role: 'EDITOR' })
        .expect(402, { code: 'collaborator_limit' });
      await as(owner)
        .patch(`projects/${projectId}/members/${invitee.id}`, { role: 'SUPERVISOR' })
        .expect(200);
      await as(owner)
        .patch(`projects/${projectId}/members/${supervisor.id}`, { role: 'REVIEWER' })
        .expect(200);
    });

    it('is accepted only by the account of the invited number, once', async () => {
      await invite('EDITOR', '70 00 00 02', 'Merci de relire.').expect(201);
      const token = await tokenOf(devSmsKey('+22670000002'));

      const view = (await as(null).post('invitations/view', { token }).expect(200)).body;
      expect(view).toEqual({
        projectName: 'Mémoire',
        inviterName: 'Awa Kaboré',
        role: 'EDITOR',
        message: 'Merci de relire.',
        channel: 'phone',
        contactHint: '+226 •• •• •• 02',
        status: 'PENDING',
        expiresAt: expect.any(String),
      });

      const someoneElse = person('Autre', '+22670000030');
      await as(someoneElse)
        .post('invitations/accept', { token })
        .expect(403, { code: 'invitation_other_account' });
      await as(null).post('invitations/accept', { token }).expect(403);

      await as(invitee).post('invitations/accept', { token }).expect(200, { projectId });
      expect(ctx.db.members).toContainEqual(
        expect.objectContaining({ projectId, userId: invitee.id, role: 'EDITOR' }),
      );
      expect(audits('PROJECT_SHARED')).toMatchObject([
        { actorId: invitee.id, targetId: projectId, metadata: { role: 'EDITOR' } },
      ]);
      await as(invitee).post('invitations/accept', { token }).expect(410);
      expect((await as(null).post('invitations/view', { token })).body.status).toBe('ACCEPTED');
      await as(null)
        .post('invitations/view', { token: 'x'.repeat(43) })
        .expect(404);
    });

    it('needs the verified invited e-mail address on the accepting account', async () => {
      await as(owner)
        .post(`projects/${projectId}/invitations`, {
          channel: 'email',
          email: 'issa@example.org',
          role: 'VIEWER',
        })
        .expect(201);
      const token = await tokenOf(devMailKey('issa@example.org'));
      invitee.email = 'issa@example.org';
      await as(invitee).post('invitations/accept', { token }).expect(403);
      invitee.emailVerifiedAt = new Date();
      await as(invitee).post('invitations/accept', { token }).expect(200);
    });

    it('expires after 14 days, and can be declined', async () => {
      await invite('VIEWER', '70 00 00 02').expect(201);
      const token = await tokenOf(devSmsKey('+22670000002'));
      ctx.db.invitations[0]!.expiresAt = new Date(Date.now() - 1000);
      expect((await as(null).post('invitations/view', { token })).body.status).toBe('EXPIRED');
      await as(invitee).post('invitations/accept', { token }).expect(410);

      await invite('VIEWER', '70 00 00 02').expect(201);
      const second = await tokenOf(devSmsKey('+22670000002'));
      await as(invitee).post('invitations/decline', { token: second }).expect(204);
      expect(audits('PROJECT_INVITATION_DECLINED')).toHaveLength(1);
      await as(invitee).post('invitations/accept', { token: second }).expect(410);
    });

    it('checks the limit again on acceptance (the plan may have changed)', async () => {
      await invite('REVIEWER', '70 00 00 02').expect(201);
      const token = await tokenOf(devSmsKey('+22670000002'));
      ctx.db.share(projectId, person('Déjà là', '+22670000040').id, 'EDITOR');
      ctx.db.personalPlans.delete(owner.id);
      await as(invitee)
        .post('invitations/accept', { token })
        .expect(402, { code: 'collaborator_limit' });
    });
  });

  // ───────────── Audit entries in the same transaction ─────────────

  describe('audit entries', () => {
    it('never leaves a change without its audit entry (written in the same transaction)', async () => {
      ctx.db.share(projectId, invitee.id, 'EDITOR');
      ctx.db.failNextAudit = true;
      await as(owner)
        .patch(`projects/${projectId}/members/${invitee.id}`, { role: 'VIEWER' })
        .expect(500);
      expect(ctx.db.members.find((m) => m.userId === invitee.id)?.role).toBe('EDITOR');

      ctx.db.failNextAudit = true;
      await as(owner).delete(`projects/${projectId}/members/${invitee.id}`).expect(500);
      expect(ctx.db.members.some((m) => m.userId === invitee.id)).toBe(true);

      ctx.db.failNextAudit = true;
      await invite('VIEWER', '70 00 00 03').expect(500);
      expect(ctx.db.invitations).toHaveLength(0);
      expect(await redis.client.get(devSmsKey('+22670000003'))).toBeNull();

      ctx.db.failNextAudit = true;
      await as(owner).post(`projects/${projectId}/links`, {}).expect(500);
      expect(ctx.db.links).toHaveLength(0);
      expect(ctx.db.audits).toHaveLength(0);
    });

    it('accepts an invitation and records it, or neither', async () => {
      await invite('EDITOR', '70 00 00 02').expect(201);
      const token = await tokenOf(devSmsKey('+22670000002'));
      ctx.db.failNextAudit = true;
      await as(invitee).post('invitations/accept', { token }).expect(500);
      expect(ctx.db.members).toHaveLength(0);
      expect(ctx.db.invitations[0]!.status).toBe('PENDING');
      await as(invitee).post('invitations/accept', { token }).expect(200);
      expect(audits('PROJECT_SHARED')).toHaveLength(1);
    });
  });

  // ───────────── Rate limits ─────────────

  describe('limits per account and per token', () => {
    it('limits the readings of one invitation, not of the others from the same address', async () => {
      await invite('VIEWER', '70 00 00 02').expect(201);
      const first = await tokenOf(devSmsKey('+22670000002'));
      for (let i = 0; i < 6; i++)
        await as(null).post('invitations/view', { token: first }).expect(200);
      await as(null).post('invitations/view', { token: first }).expect(429);
      await invite('VIEWER', '70 00 00 03').expect(201);
      const second = await tokenOf(devSmsKey('+22670000003'));
      await as(null).post('invitations/view', { token: second }).expect(200);
    });

    it('limits acceptances per account', async () => {
      for (let i = 0; i < 6; i++) {
        await as(invitee)
          .post('invitations/accept', { token: 'x'.repeat(43) })
          .expect(404);
      }
      await as(invitee)
        .post('invitations/accept', { token: 'x'.repeat(43) })
        .expect(429);
    });

    it('limits the readings of one public link, not of another', async () => {
      const link = (await as(owner).post(`projects/${projectId}/links`, {}).expect(201)).body;
      const token = /\/p\/([\w-]{43})$/.exec(link.url)![1]!;
      for (let i = 0; i < 6; i++) await as(null).get(`public/${token}`).expect(200);
      await as(null).get(`public/${token}`).expect(429);
      await as(null)
        .get(`public/${'y'.repeat(43)}`)
        .expect(404);
    });
  });

  // ───────────── Members ─────────────

  describe('members', () => {
    it('changes a role and removes an access, with an audit entry and a collab check', async () => {
      ctx.db.share(projectId, invitee.id, 'EDITOR');
      const changed = await as(owner)
        .patch(`projects/${projectId}/members/${invitee.id}`, { role: 'REVIEWER' })
        .expect(200);
      expect(changed.body.members).toMatchObject([{ userId: invitee.id, role: 'REVIEWER' }]);
      expect(audits('PROJECT_ROLE_CHANGED')).toMatchObject([
        { actorId: owner.id, metadata: { userId: invitee.id, from: 'EDITOR', to: 'REVIEWER' } },
      ]);
      expect(published).toContainEqual({ type: 'project-access', projectId });

      published = [];
      await as(owner).delete(`projects/${projectId}/members/${invitee.id}`).expect(200);
      expect(audits('PROJECT_ACCESS_REMOVED')).toHaveLength(1);
      expect(published).toContainEqual({ type: 'project-access', projectId });
      await as(invitee).get(`projects/${projectId}`).expect(404);
    });

    it('never gives the owner role, and shows invitations to the owner only', async () => {
      ctx.db.share(projectId, invitee.id, 'EDITOR');
      await as(owner)
        .patch(`projects/${projectId}/members/${invitee.id}`, { role: 'OWNER' })
        .expect(400);
      await invite('VIEWER', '70 00 00 03').expect(201);
      const seen = (await as(invitee).get(`projects/${projectId}/sharing`)).body as ProjectSharing;
      expect(seen.invitations).toEqual([]);
      expect(seen.link).toBeNull();
      expect(seen.members).toHaveLength(1);
    });
  });

  // ───────────── Public links ─────────────

  describe('public links', () => {
    const addPdf = (status: 'SUCCEEDED' | 'FAILED', key: string) =>
      ctx.db.compilations.push({
        id: key,
        projectId,
        triggeredById: owner.id,
        chargedUserId: owner.id,
        engine: 'PDFLATEX',
        status,
        priority: 'NORMAL',
        queuedAt: new Date(Date.now() + ctx.db.compilations.length),
        startedAt: null,
        finishedAt: new Date(),
        durationMs: 1,
        pdfKey: `${projectId}/${key}/output.pdf`,
        logKey: null,
        errors: null,
        workerHost: null,
        submissionVersionId: null,
        printSendId: null,
      });

    const tokenOfLink = (url: string) => /\/p\/([\w-]{43})$/.exec(url)![1]!;

    it('shows the last successful PDF only, by default, and writes every opening', async () => {
      addPdf('SUCCEEDED', 'ok');
      addPdf('FAILED', 'broken');
      const link = (await as(owner).post(`projects/${projectId}/links`, {}).expect(201)).body;
      expect(link).toMatchObject({ includeSources: false, expiresAt: null });
      expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/fr\/p\/[\w-]{43}$/);
      expect(audits('PUBLIC_LINK_CREATED')).toHaveLength(1);

      const token = tokenOfLink(link.url);
      const opened = await as(null).get(`public/${token}`).expect(200);
      expect(opened.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(opened.body.name).toBe('Mémoire');
      expect(opened.body.files).toBeNull();
      expect(opened.body.pdf.url).toContain('/pdf/');
      expect(audits('PUBLIC_LINK_OPENED')).toMatchObject([
        { actorId: null, targetId: projectId, ip: expect.any(String) },
      ]);
      await as(null).get(`public/${token}/files/${mainId}`).expect(404);

      // One audit entry per link, address and hour; the next openings increase a counter.
      await as(null).get(`public/${token}`).expect(200);
      await as(null).get(`public/${token}`).expect(200);
      expect(audits('PUBLIC_LINK_OPENED')).toHaveLength(1);
      expect(ctx.db.openings).toMatchObject([{ count: 3 }]);

      // The same link again for the owner (one active link); no second one.
      const panel = (await as(owner).get(`projects/${projectId}/sharing`)).body as ProjectSharing;
      expect(panel.link?.url).toBe(link.url);
      await as(owner).post(`projects/${projectId}/links`, {}).expect(409, { code: 'link_exists' });
    });

    it('adds the sources (read only) when asked, never comments or history', async () => {
      const link = (
        await as(owner).post(`projects/${projectId}/links`, { includeSources: true }).expect(201)
      ).body;
      const token = tokenOfLink(link.url);
      const opened = (await as(null).get(`public/${token}`).expect(200)).body;
      expect(opened).toEqual({
        name: 'Mémoire',
        pdf: null,
        files: [{ id: mainId, path: 'main.tex', kind: 'TEXT', sizeBytes: expect.any(Number) }],
      });
      const text = await as(null).get(`public/${token}/files/${mainId}`).expect(200);
      expect(text.text).toContain('\\documentclass');
      expect(text.headers['content-disposition']).toBe('attachment');
    });

    it('stops at once when revoked, and after its expiry', async () => {
      const link = (await as(owner).post(`projects/${projectId}/links`, {}).expect(201)).body;
      const token = tokenOfLink(link.url);
      await as(owner).delete(`projects/${projectId}/links/${link.id}`).expect(204);
      expect(audits('PUBLIC_LINK_REVOKED')).toHaveLength(1);
      await as(null).get(`public/${token}`).expect(404, { code: 'link_invalid' });

      const past = new Date(Date.now() - 1000).toISOString();
      await as(owner).post(`projects/${projectId}/links`, { expiresAt: past }).expect(400);
      const soon = new Date(Date.now() + 60_000).toISOString();
      const second = (
        await as(owner).post(`projects/${projectId}/links`, { expiresAt: soon }).expect(201)
      ).body;
      ctx.db.links.at(-1)!.expiresAt = new Date(Date.now() - 1);
      await as(null)
        .get(`public/${tokenOfLink(second.url)}`)
        .expect(404);
      await as(null).get('public/not-a-token').expect(404);
    });
  });

  // ───────────── Comments ─────────────

  describe('comments', () => {
    let reviewer: User;
    let editor: User;

    beforeEach(() => {
      reviewer = person('Relecteur', '+22670000050');
      editor = person('Éditeur', '+22670000051');
      ctx.db.share(projectId, reviewer.id, 'REVIEWER');
      ctx.db.share(projectId, editor.id, 'EDITOR');
    });

    const comment = async (user: User, extra: object = {}) =>
      (
        await as(user)
          .post(`projects/${projectId}/comments`, {
            fileId: mainId,
            anchor: ANCHOR,
            quotedText: 'les débits mesurés',
            body: "Précisez l'année.",
            ...extra,
          })
          .expect(201)
      ).body as CommentInfo;

    it('anchors a comment, answers it, and tells the open editors', async () => {
      const created = await comment(reviewer);
      expect(created).toMatchObject({
        fileId: mainId,
        anchor: ANCHOR,
        quotedText: 'les débits mesurés',
        author: { id: reviewer.id, name: 'Relecteur' },
        status: 'OPEN',
        suggestionStatus: null,
        canResolve: true,
      });
      expect(published).toContainEqual({ type: 'comments-changed', projectId });
      const replied = await as(owner)
        .post(`projects/${projectId}/comments/${created.id}/replies`, { body: 'Corrigé.' })
        .expect(201);
      expect(replied.body.replies).toMatchObject([
        { author: { name: 'Awa Kaboré' }, body: 'Corrigé.' },
      ]);
    });

    it('refuses an anchor that is not a pair of Yjs positions, or a missing file', async () => {
      await as(reviewer)
        .post(`projects/${projectId}/comments`, {
          fileId: mainId,
          anchor: { start: { item: { client: 'x' } }, end: {} },
          quotedText: 'x',
          body: 'x',
        })
        .expect(400);
      await as(reviewer)
        .post(`projects/${projectId}/comments`, {
          fileId: 'missing-file-id',
          anchor: ANCHOR,
          quotedText: 'x',
          body: 'x',
        })
        .expect(404, { code: 'file_missing' });
    });

    it('lets the author, the owner and editors resolve; not the other commenters', async () => {
      const mine = await comment(reviewer);
      const theirs = await comment(editor);
      const listed = (await as(reviewer).get(`projects/${projectId}/comments`)).body.comments;
      expect(listed.map((item: CommentInfo) => item.canResolve)).toEqual([true, false]);
      await as(reviewer)
        .post(`projects/${projectId}/comments/${theirs.id}/resolve`, { resolved: true })
        .expect(403);
      const resolved = await as(reviewer)
        .post(`projects/${projectId}/comments/${mine.id}/resolve`, { resolved: true })
        .expect(200);
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolvedBy: { id: reviewer.id } });
      await as(editor)
        .post(`projects/${projectId}/comments/${mine.id}/resolve`, { resolved: false })
        .expect(200);
    });

    it('decides a proposal once: applied with the new anchor, or refused', async () => {
      const proposal = await comment(reviewer, { suggestedText: 'les débits de 2025' });
      expect(proposal.suggestionStatus).toBe('PENDING');
      const moved = { ...ANCHOR, start: { ...ANCHOR.start, item: { client: 7, clock: 1 } } };
      const applied = await as(editor)
        .post(`projects/${projectId}/comments/${proposal.id}/suggestion`, {
          decision: 'APPLIED',
          anchor: moved,
        })
        .expect(200);
      expect(applied.body).toMatchObject({
        suggestionStatus: 'APPLIED',
        suggestionDecidedBy: { id: editor.id },
        anchor: moved,
      });
      await as(owner)
        .post(`projects/${projectId}/comments/${proposal.id}/suggestion`, { decision: 'REJECTED' })
        .expect(409, { code: 'suggestion_decided' });
      // A comment without proposal has nothing to decide.
      const plain = await comment(reviewer);
      await as(owner)
        .post(`projects/${projectId}/comments/${plain.id}/suggestion`, { decision: 'REJECTED' })
        .expect(404);
    });

    it('never applies to a locked file or a read-only project, but can refuse', async () => {
      const proposal = await comment(reviewer, { suggestedText: '' });
      ctx.db.files.find((file) => file.id === mainId)!.lockedBySubmissionId = 'submission-1';
      await as(owner)
        .post(`projects/${projectId}/comments/${proposal.id}/suggestion`, {
          decision: 'APPLIED',
          anchor: ANCHOR,
        })
        .expect(403, { code: 'file_locked' });
      ctx.db.projects.find((item) => item.id === projectId)!.readOnlyReason = 'OVER_FREE_LIMIT';
      await as(owner)
        .post(`projects/${projectId}/comments/${proposal.id}/suggestion`, {
          decision: 'APPLIED',
          anchor: ANCHOR,
        })
        .expect(403, { code: 'read_only' });
      await as(owner)
        .post(`projects/${projectId}/comments/${proposal.id}/suggestion`, { decision: 'REJECTED' })
        .expect(200);
    });

    it('keeps the comments of a deleted file, without their file', async () => {
      const created = await comment(reviewer);
      await as(owner).delete(`projects/${projectId}/files/${mainId}`).expect(200);
      const listed = (await as(owner).get(`projects/${projectId}/comments`)).body.comments;
      expect(listed).toMatchObject([{ id: created.id, fileId: null }]);
    });
  });
});
