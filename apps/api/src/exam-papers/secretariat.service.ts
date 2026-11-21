import type { PrintRequest, Prisma } from '@integris/db';
import {
  EXAM_PAPERS_BUCKET,
  type OrgPrintOverview,
  PRINT_LINK_TTL_SECONDS,
  PRINT_PREVIEW_TTL_SECONDS,
  type PrintEventView,
  type PrintLink,
  type PrintRequestPage,
  type SecretariatQueue,
} from '@integris/shared';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { downloadName, type ExamLink, examLinkKey, signExamLink } from '../files/file-links.js';
import { FilesServer } from '../files/files-server.js';
import { OrgContextService } from '../organizations/org-context.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ancestorsOf, type ExamActor, writePrintEvent } from './exam-access.js';
import { examMessages } from './exam-messages.js';
import { fail, PrintAccessService, type Reader } from './print-access.service.js';
import { watermark } from './watermark.js';

const DAY_MS = 86_400_000;
/** Preview and print links per user and hour. */
const LINKS_PER_HOUR = 60;
/** Lock of the journal of one opening: held while it is checked and written. */
const OPENING_LOCK_MS = 10_000;
const OPENING_LOCK_ATTEMPTS = 50;
const OPENING_LOCK_WAIT_MS = 100;
const ACTIVE = ['SCHEDULED', 'READY', 'OPENED', 'PRINTED'] as const;
const FINAL = ['HANDED_OVER', 'CANCELED'] as const;

type Actor = ExamActor & { userId: string };

/**
 * The secretariat side of exam papers (docs/spec.md, "Devoirs et secrétariat"): the print queue
 * of the groups served, opening (watermarked preview), the one-time print file, the printed count
 * and the handover, the history and the access journal. The owner and the admins of the
 * organization see the requests and the journal, never the subject (step 13 decisions).
 */
@Injectable()
export class SecretariatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SecretariatService.name);
  private readonly linkKey: Buffer;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PrintAccessService,
    private readonly orgs: OrgContextService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    private readonly notifications: NotificationsService,
    files: FilesServer,
  ) {
    this.linkKey = examLinkKey(config.env.AUTH_SECRET);
    files.registerExam({ serve: (link, ip) => this.serve(link, ip) });
  }

  private get db() {
    return this.prisma.client;
  }

  /** Every minute: requests whose date is reached become READY and their secretariat is told. */
  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    try {
      const lock = await this.redis.client.set('lock:print-ready', '1', 'PX', 55_000, 'NX');
      if (lock !== 'OK') return;
      const promoted = await this.access.promoteReady();
      if (promoted) this.logger.log({ promoted }, 'Print requests ready');
      // Unused one-time links are worth nothing once expired.
      await this.db.printDownloadLink.deleteMany({
        where: { usedAt: null, expiresAt: { lt: new Date(Date.now() - DAY_MS) } },
      });
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'Print sweep failed');
    }
  }

  // ───────────── Secretariat lists ─────────────

  private async scope(userId: string, organizationId: string) {
    const scope = await this.access.secretaryScope(userId, organizationId);
    if (!scope) return fail(HttpStatus.FORBIDDEN, 'org_forbidden');
    return scope;
  }

  private secretaryReader(userId: string): Reader {
    return { userId, teacher: false, coeditor: false, secretary: true, admin: false };
  }

  async queue(userId: string, organizationId: string): Promise<SecretariatQueue> {
    const scope = await this.scope(userId, organizationId);
    const groupIds = [...scope.visible];
    await this.access.promoteReady({ organizationId, groupId: { in: groupIds } });
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const [active, printedRecently] = await Promise.all([
      this.db.printRequest.findMany({
        where: { organizationId, groupId: { in: groupIds }, status: { in: [...ACTIVE] } },
        orderBy: [{ availableFrom: 'asc' }, { examAt: 'asc' }],
      }),
      this.db.printRequest.findMany({
        where: {
          organizationId,
          groupId: { in: groupIds },
          printedAt: { gte: monthStart < weekAgo ? monthStart : weekAgo },
        },
      }),
    ]);
    const tomorrowEnd = new Date(now.getTime() + 2 * DAY_MS);
    const toPrint = active.filter((row) => row.status === 'READY' || row.status === 'OPENED');
    const ofMonth = printedRecently.filter((row) => row.printedAt! >= monthStart);
    const byName = new Map(scope.groups.map((group) => [group.id, group.name]));
    return {
      organizationName: scope.organizationName,
      groups: scope.scopeIds.map((id) => byName.get(id) ?? '').filter(Boolean),
      stats: {
        toPrint: toPrint.length,
        examTomorrow: toPrint.filter((row) => row.examAt <= tomorrowEnd).length,
        scheduled: active.filter((row) => row.status === 'SCHEDULED').length,
        printedThisWeek: printedRecently.filter((row) => row.printedAt! >= weekAgo).length,
        toHandOver: active.filter((row) => row.status === 'PRINTED').length,
        copiesThisMonth: ofMonth.reduce((total, row) => total + (row.printedCount ?? 0), 0),
        requestsThisMonth: ofMonth.length,
      },
      requests: await this.access.views(active, () => this.secretaryReader(userId)),
    };
  }

  async history(userId: string, organizationId: string) {
    const scope = await this.scope(userId, organizationId);
    const rows = await this.db.printRequest.findMany({
      where: {
        organizationId,
        groupId: { in: [...scope.visible] },
        status: { in: [...FINAL] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return { requests: await this.access.views(rows, () => this.secretaryReader(userId)) };
  }

  /**
   * Access journal: of the requests of the groups served (secretariat), or of the whole
   * organization (owner and admins, exam papers' co-editor changes included).
   */
  async journal(userId: string, organizationId: string): Promise<{ events: PrintEventView[] }> {
    const context = await this.orgs.load(userId, organizationId);
    let where: Prisma.PrintEventWhereInput;
    if (context.manages) {
      where = { organizationId };
    } else {
      const scope = await this.scope(userId, organizationId);
      const requests = await this.db.printRequest.findMany({
        where: { organizationId, groupId: { in: [...scope.visible] } },
        select: { id: true },
      });
      where = { printRequestId: { in: requests.map((request) => request.id) } };
    }
    const events = await this.db.printEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { events: await this.access.eventViews(events, userId) };
  }

  /** Print requests of the organization for its owner and admins: metadata only. */
  async overview(userId: string, organizationId: string): Promise<OrgPrintOverview> {
    const context = await this.orgs.manager(userId, organizationId);
    this.orgs.requireBusiness(context);
    await this.access.promoteReady({ organizationId });
    const [requests, journal] = await Promise.all([
      this.db.printRequest.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.journal(userId, organizationId),
    ]);
    return {
      requests: await this.access.views(requests, (request) => ({
        userId,
        teacher: request.teacherId === userId,
        coeditor: false,
        secretary: false,
        admin: true,
      })),
      events: journal.events,
    };
  }

  /** One request with its journal, for anyone who may see it. */
  async page(userId: string, requestId: string): Promise<PrintRequestPage> {
    const { request, reader } = await this.access.load(userId, requestId);
    const [views, events] = await Promise.all([
      this.access.views([request], () => reader),
      this.db.printEvent.findMany({
        where: { printRequestId: request.id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { request: views[0]!, events: await this.access.eventViews(events, userId) };
  }

  // ───────────── Opening and printing ─────────────

  private link(link: ExamLink, title: string): PrintLink {
    const base = this.config.env.FILES_PUBLIC_URL.replace(/\/+$/, '');
    return {
      url: `${base}/exam/${signExamLink(this.linkKey, link)}/${downloadName(title)}`,
      expiresAt: new Date(link.expires * 1000).toISOString(),
    };
  }

  /**
   * Opens the subject: a watermarked preview for its secretariat, its teacher and co-editors,
   * never before the availability date, never for the admins as such. The first opening by the
   * secretariat moves the request to OPENED; every opening is journaled.
   */
  async preview(actor: Actor, requestId: string): Promise<PrintLink> {
    const { request, reader } = await this.access.load(actor.userId, requestId);
    this.access.requireUnlocked(request);
    if (!(reader.secretary || reader.teacher || reader.coeditor)) {
      return fail(HttpStatus.FORBIDDEN, 'forbidden');
    }
    if (request.status === 'CANCELED') fail(HttpStatus.CONFLICT, 'print_status');
    await consumeLimit(this.redis.client, `rl:print-link:${actor.userId}`, LINKS_PER_HOUR, 3600);
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      if (reader.secretary) {
        await tx.printRequest.updateMany({
          where: { id: request.id, status: 'READY' },
          data: { status: 'OPENED', openedAt: now },
        });
      }
    });
    const issued = Math.floor(now.getTime() / 1000);
    return this.link(
      {
        kind: 'preview',
        requestId: request.id,
        userId: actor.userId,
        linkId: randomBytes(12).toString('base64url'),
        issued,
        expires: issued + PRINT_PREVIEW_TTL_SECONDS,
      },
      request.title,
    );
  }

  /** The clean print file, for the secretariat only, by a one-time link valid 10 minutes. */
  async printLink(actor: Actor, requestId: string): Promise<PrintLink> {
    const { request, reader } = await this.access.load(actor.userId, requestId);
    this.access.requireUnlocked(request);
    if (!reader.secretary) return fail(HttpStatus.FORBIDDEN, 'forbidden');
    if (request.status !== 'OPENED' && request.status !== 'PRINTED') {
      fail(HttpStatus.CONFLICT, 'print_status');
    }
    await consumeLimit(this.redis.client, `rl:print-link:${actor.userId}`, LINKS_PER_HOUR, 3600);
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db.printDownloadLink.create({
      data: {
        id: randomBytes(24).toString('base64url'),
        printRequestId: request.id,
        userId: actor.userId,
        expiresAt: new Date((now + PRINT_LINK_TTL_SECONDS) * 1000),
      },
    });
    return this.link(
      {
        kind: 'print',
        requestId: request.id,
        userId: actor.userId,
        linkId: row.id,
        issued: now,
        expires: now + PRINT_LINK_TTL_SECONDS,
      },
      request.title,
    );
  }

  async confirmPrinted(actor: Actor, requestId: string, count: number) {
    const { request, reader } = await this.access.load(actor.userId, requestId);
    if (!reader.secretary) return fail(HttpStatus.FORBIDDEN, 'forbidden');
    await this.db.$transaction(async (tx) => {
      const { count: updated } = await tx.printRequest.updateMany({
        where: { id: request.id, status: 'OPENED' },
        data: { status: 'PRINTED', printedCount: count, printedAt: new Date() },
      });
      if (!updated) return fail(HttpStatus.CONFLICT, 'print_status');
      await writePrintEvent(tx, actor, {
        type: 'PRINT_CONFIRMED',
        projectId: request.projectId,
        organizationId: request.organizationId,
        printRequestId: request.id,
        metadata: { count },
      });
      await this.notifyTeacher(tx, request, 'PRINT_PRINTED', { count });
    });
    return this.page(actor.userId, requestId);
  }

  async handOver(actor: Actor, requestId: string, to: string) {
    const { request, reader } = await this.access.load(actor.userId, requestId);
    if (!reader.secretary) return fail(HttpStatus.FORBIDDEN, 'forbidden');
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.printRequest.updateMany({
        where: { id: request.id, status: 'PRINTED' },
        data: { status: 'HANDED_OVER', handedOverTo: to, handedOverAt: new Date() },
      });
      if (!count) return fail(HttpStatus.CONFLICT, 'print_status');
      await writePrintEvent(tx, actor, {
        type: 'HANDED_OVER',
        projectId: request.projectId,
        organizationId: request.organizationId,
        printRequestId: request.id,
        metadata: { to },
      });
      await this.notifyTeacher(tx, request, 'PRINT_HANDED_OVER', { to });
    });
    return this.page(actor.userId, requestId);
  }

  /**
   * The teacher is told in the application and by SMS when the subject is printed and handed
   * over (docs/spec.md, "Notifications"); the SMS never names the subject.
   */
  private async notifyTeacher(
    tx: Prisma.TransactionClient,
    request: PrintRequest,
    type: 'PRINT_PRINTED' | 'PRINT_HANDED_OVER',
    extra: Record<string, string | number>,
  ): Promise<void> {
    await this.notifications.notify(tx, [request.teacherId], {
      type,
      payload: { printRequestId: request.id, title: request.title, ...extra },
      key: `${type.toLowerCase()}:${request.id}`,
      perUser: false,
    });
  }

  // ───────────── Files domain ─────────────

  /**
   * A PDF of the files domain, after every check made again: the request still exists, is not
   * canceled and its date is reached; the reader may still see it; a print link is used once.
   */
  async serve(link: ExamLink, ip: string | null): Promise<Uint8Array | null> {
    const request = await this.db.printRequest.findUnique({ where: { id: link.requestId } });
    if (!request || request.status === 'CANCELED' || new Date() < request.availableFrom) {
      return null;
    }
    const reader = await this.access.reader(link.userId, request);
    if (link.kind === 'print') {
      if (!reader.secretary || (request.status !== 'OPENED' && request.status !== 'PRINTED')) {
        return null;
      }
      const used = await this.db.$transaction(async (tx) => {
        const { count } = await tx.printDownloadLink.updateMany({
          where: {
            id: link.linkId!,
            printRequestId: request.id,
            userId: link.userId,
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });
        if (!count) return false;
        await writePrintEvent(
          tx,
          { userId: link.userId, ip },
          {
            type: 'DOWNLOADED',
            projectId: request.projectId,
            organizationId: request.organizationId,
            printRequestId: request.id,
            metadata: { linkId: link.linkId },
          },
        );
        return true;
      });
      return used ? this.storage.get(EXAM_PAPERS_BUCKET, request.subjectPdfKey) : null;
    }
    if (!(reader.secretary || reader.teacher || reader.coeditor) || !link.linkId) return null;
    await this.journalOpening(link, link.linkId, request, reader, ip);
    const pdf = await this.storage.get(EXAM_PAPERS_BUCKET, request.subjectPdfKey);
    return watermark(pdf, await this.watermarkLine(link, request, reader));
  }

  /**
   * Journals an opening before the subject leaves the server, once per preview link and address:
   * the viewer fetching the same link again (React strict mode in development, the "retry"
   * button, a reload of the viewer) is the same opening; the link fetched from another address
   * is a new one. A Redis lock serializes the fetches of one link so that two concurrent ones
   * write a single event; the event itself, in the database, decides. Without the lock (Redis
   * slow), the check is made anyway: at worst a duplicate, never a delivery without its event.
   */
  private async journalOpening(
    link: ExamLink,
    opening: string,
    request: PrintRequest,
    reader: Reader,
    ip: string | null,
  ): Promise<void> {
    const lock = `lock:print-open:${opening}`;
    const token = randomBytes(8).toString('hex');
    let locked = false;
    for (let attempt = 0; attempt < OPENING_LOCK_ATTEMPTS && !locked; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, OPENING_LOCK_WAIT_MS));
      locked = (await this.redis.client.set(lock, token, 'PX', OPENING_LOCK_MS, 'NX')) === 'OK';
    }
    try {
      const journaled = await this.db.printEvent.findMany({
        where: { printRequestId: request.id, actorId: link.userId, type: 'OPENED', ip },
        select: { metadata: true },
      });
      const seen = journaled.some(
        (event) => (event.metadata as Record<string, unknown> | null)?.opening === opening,
      );
      if (seen) return;
      await writePrintEvent(
        this.db,
        { userId: link.userId, ip },
        {
          type: 'OPENED',
          projectId: request.projectId,
          organizationId: request.organizationId,
          printRequestId: request.id,
          metadata: { byAuthor: !reader.secretary, opening },
        },
      );
    } finally {
      if (locked && (await this.redis.client.get(lock)) === token)
        await this.redis.client.del(lock);
    }
  }

  /** "CONFIDENTIEL · Name · Service · 16/12/2026 09:42 GMT": who, which service, when. */
  private async watermarkLine(
    link: ExamLink,
    request: PrintRequest,
    reader: Reader,
  ): Promise<string> {
    const user = await this.db.user.findUnique({ where: { id: link.userId } });
    const locale = user?.locale === 'en' ? 'en' : 'fr';
    const t = examMessages[locale];
    let service: string;
    if (reader.secretary) {
      const scope = await this.access.secretaryScope(link.userId, request.organizationId);
      const served = new Set(ancestorsOf(scope?.groups ?? [], request.groupId));
      const names = (scope?.groups ?? [])
        .filter((group) => scope!.scopeIds.includes(group.id) && served.has(group.id))
        .map((group) => group.name);
      service = `${t.secretariat} ${names.join(', ')}`.trim();
    } else {
      const organization = await this.db.organization.findUnique({
        where: { id: request.organizationId },
      });
      service = `${t.author} · ${organization?.name ?? ''}`;
    }
    const when = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: this.config.env.PRINT_TIME_ZONE,
      timeZoneName: 'short',
    }).format(new Date(link.issued * 1000));
    return [t.confidential, user?.displayName ?? '', service, when]
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');
  }
}
