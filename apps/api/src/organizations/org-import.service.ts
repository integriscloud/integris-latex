import type { User } from '@integris/db';
import {
  CSV_IMPORT_MAX_ROWS,
  type CsvRowError,
  type ImportReport,
  kindOfCsv,
  parseMembersCsv,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { consumeLimit } from '../common/rate-limit.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { codeOf, fail, type OrgContext, OrgContextService } from './org-context.service.js';
import { type Contact, OrganizationsService } from './organizations.service.js';

/** Imports per organization and day. */
const IMPORTS_PER_DAY = 20;

type RowError = { line: number; reason: CsvRowError; contact: string };

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/**
 * Bulk invitation of a BUSINESS by CSV (docs/spec.md, "Import d'utilisateurs" and step 12
 * decisions): each valid line becomes an invitation that reserves a seat; the other lines are
 * reported with their cause. The file itself is not kept. The lines are processed after the
 * answer (sending hundreds of SMS takes time); the page follows the report.
 */
@Injectable()
export class OrgImportService {
  private readonly logger = new Logger(OrgImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgContextService,
    private readonly organizations: OrganizationsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Rights and daily limit, checked before the file is read (nothing is buffered for someone
   * who may not import).
   */
  async check(user: User, organizationId: string): Promise<OrgContext> {
    const context = await this.orgs.manager(user.id, organizationId);
    this.orgs.requireBusiness(context);
    this.orgs.requireLive(context);
    await consumeLimit(
      this.redis.client,
      `rl:org-import:${organizationId}:${new Date().toISOString().slice(0, 10)}`,
      IMPORTS_PER_DAY,
      2 * 86_400,
    );
    return context;
  }

  async start(
    user: User,
    context: OrgContext,
    fileName: string,
    bytes: Uint8Array,
    ip: string | null,
  ): Promise<ImportReport> {
    const organizationId = context.organization.id;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail(HttpStatus.UNPROCESSABLE_ENTITY, 'csv_invalid');
    }
    const rows = parseMembersCsv(text);
    if (!rows) return fail(HttpStatus.UNPROCESSABLE_ENTITY, 'csv_invalid');
    if (rows.length > CSV_IMPORT_MAX_ROWS) fail(HttpStatus.PAYLOAD_TOO_LARGE, 'csv_too_large');
    const name =
      fileName
        .replace(/[\r\n\\/]+/g, ' ')
        .trim()
        .slice(0, 200) || null;
    const report = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.userImport.create({
        data: {
          organizationId,
          createdById: user.id,
          fileName: name,
          status: 'PROCESSING',
          totalRows: rows.length,
        },
      });
      await this.orgs.audit(
        tx,
        { userId: user.id, ip },
        'ORG_IMPORT_STARTED',
        'Organization',
        organizationId,
        {
          importId: row.id,
          rows: rows.length,
        },
      );
      return row;
    });
    void this.process(user, context, report.id, rows, ip).catch(async (error: unknown) => {
      this.logger.error({ err: error, importId: report.id }, 'CSV import failed');
      await this.prisma.client.userImport
        .update({ where: { id: report.id }, data: { status: 'FAILED', finishedAt: new Date() } })
        .catch(() => undefined);
    });
    return this.report(user.id, organizationId, report.id);
  }

  /** One line after the other, each under the organization lock (so seats are counted right). */
  async process(
    user: User,
    context: OrgContext,
    importId: string,
    rows: NonNullable<ReturnType<typeof parseMembersCsv>>,
    ip: string | null,
  ): Promise<void> {
    const organizationId = context.organization.id;
    const actor = { userId: user.id, ip };
    const errors: RowError[] = [];
    const seen = new Set<string>();
    const groups = await this.prisma.client.orgGroup.findMany({ where: { organizationId } });
    const groupByName = new Map(groups.map((group) => [group.name.trim().toLowerCase(), group.id]));
    let invited = 0;
    for (const row of rows) {
      const shown = row.phone || row.email;
      const refuse = (reason: CsvRowError) =>
        errors.push({ line: row.line, reason, contact: shown });
      if (!row.phone && !row.email) {
        refuse('contact_missing');
        continue;
      }
      let contact: Contact;
      try {
        contact = row.phone
          ? this.organizations.contactOf({ channel: 'phone', phone: row.phone })
          : { email: email.parse(row.email) };
      } catch (error) {
        refuse(codeOf(error) === 'country_not_allowed' ? 'country_not_allowed' : 'contact_invalid');
        continue;
      }
      const key = contact.phone ?? contact.email!;
      if (seen.has(key)) {
        refuse('duplicate_row');
        continue;
      }
      seen.add(key);
      const kind = row.kind ? kindOfCsv(row.kind) : 'STUDENT';
      if (!kind) {
        refuse('kind_invalid');
        continue;
      }
      const groupId = row.group ? groupByName.get(row.group.trim().toLowerCase()) : null;
      if (groupId === undefined) {
        refuse('group_unknown');
        continue;
      }
      let created: Awaited<ReturnType<OrganizationsService['createInvitation']>> | CsvRowError;
      try {
        created = await this.orgs.locked(organizationId, async () => {
          // The author may have lost their rights meanwhile: the import stops (FAILED).
          context = await this.orgs.manager(user.id, organizationId);
          this.orgs.requireLive(context);
          return this.prisma.client.$transaction(async (tx) => {
            const refusal = await this.organizations.refusalFor(tx, organizationId, contact);
            if (refusal === 'already_member' || refusal === 'join_pending') return 'already_member';
            if (refusal === 'already_invited') return 'already_invited';
            return this.organizations.createInvitation(
              tx,
              actor,
              context,
              {
                contact,
                kind,
                groupId,
                displayName: row.name.slice(0, 120) || null,
                importId,
                locale: user.locale,
              },
              new Date(),
            );
          });
        });
      } catch (error) {
        if (codeOf(error) !== 'no_free_seat') throw error;
        created = 'no_free_seat';
      }
      if (typeof created === 'string') {
        refuse(created);
        continue;
      }
      try {
        await this.organizations.sendInvitation(user, context, contact, created.token);
        invited++;
      } catch (error) {
        this.logger.warn({ err: (error as Error).message, importId }, 'Import invitation not sent');
        await this.organizations.cancelUnsent(actor, organizationId, created.invitation.id);
        refuse('not_sent');
      }
    }
    await this.prisma.client.$transaction(async (tx) => {
      await tx.userImport.update({
        where: { id: importId },
        data: { status: 'DONE', invitedCount: invited, errorRows: errors, finishedAt: new Date() },
      });
      await this.orgs.audit(tx, actor, 'ORG_IMPORT_DONE', 'Organization', organizationId, {
        importId,
        invited,
        errors: errors.length,
      });
    });
  }

  async report(userId: string, organizationId: string, importId: string): Promise<ImportReport> {
    await this.orgs.manager(userId, organizationId);
    const row = await this.prisma.client.userImport.findFirst({
      where: { id: importId, organizationId },
    });
    if (!row) return fail(HttpStatus.NOT_FOUND, 'import_not_found');
    return {
      id: row.id,
      status: row.status,
      fileName: row.fileName,
      totalRows: row.totalRows,
      invitedCount: row.invitedCount,
      errors: (row.errorRows as RowError[] | null) ?? [],
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}
