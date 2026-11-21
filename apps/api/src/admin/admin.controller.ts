import {
  addCreditSchema,
  type AdminOrgDetail,
  type AdminPlan,
  type AdminPromo,
  type AdminSession,
  type AdminStats,
  type AdminTemplate,
  type AdminUserDetail,
  adminPaymentsQuerySchema,
  adminSearchSchema,
  adminTemplateQuerySchema,
  createPromoSchema,
  extendBusinessTrialSchema,
  type PlanRevisionView,
  reauthRequestSchema,
  reauthVerifySchema,
  refundSchema,
  startBusinessTrialSchema,
  updateAdminTemplateSchema,
  updatePlanSchema,
  updatePromoSchema,
} from '@integris/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { ApiError } from '../common/api-error.js';
import { readRawBody } from '../common/raw-body.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/zod-body.js';
import { ApiConfig } from '../config/api-config.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { AdminActor } from './admin-actor.js';
import { AdminAccountsService } from './admin-accounts.service.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { AdminAuditInterceptor, Sensitive, SuperAdminGuard } from './admin.guard.js';
import { AdminPlansService } from './admin-plans.service.js';
import { AdminStatsService } from './admin-stats.service.js';

const idSchema = z.string().min(1).max(64);

/** An id of the path, refused with 400 (never a 500) when malformed. */
function idOf(value: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
  return parsed.data;
}

/** Client address (behind Nginx): every back-office action is journaled with it. */
function actorOf(auth: AuthContext, request: Request): AdminActor {
  if (!request.ip) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
  return { userId: auth.user.id, ip: request.ip };
}

/**
 * Back-office of Integris (super-administrators only, docs/spec.md "décisions étape 14"). The
 * role is never granted here (command-line script only). Changes need the back-office SMS
 * reauthentication; every request is journaled.
 */
@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard, SuperAdminGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly plans: AdminPlansService,
    private readonly accounts: AdminAccountsService,
    private readonly catalog: AdminCatalogService,
    private readonly statistics: AdminStatsService,
    private readonly projects: ProjectsService,
    private readonly config: ApiConfig,
  ) {}

  @Get('session')
  session(@Auth() { user, session }: AuthContext): AdminSession {
    const until = session.adminReauthUntil ?? 0;
    return {
      reauthUntil:
        until > Math.floor(Date.now() / 1000) ? new Date(until * 1000).toISOString() : null,
      hasPhone: user.phone !== null,
    };
  }

  /** Sends the SMS code that unlocks the sensitive actions for a few minutes. */
  @Post('reauth/otp')
  @HttpCode(200)
  @ApiZodBody(reauthRequestSchema)
  requestReauth(
    @Auth() auth: AuthContext,
    @ZodBody(reauthRequestSchema) body: z.infer<typeof reauthRequestSchema>,
    @Req() request: Request,
  ) {
    return this.auth.requestAdminReauth(
      auth,
      body.locale,
      body.captcha,
      actorOf(auth, request).ip!,
    );
  }

  @Post('reauth')
  @HttpCode(200)
  @ApiZodBody(reauthVerifySchema)
  verifyReauth(
    @Auth() auth: AuthContext,
    @ZodBody(reauthVerifySchema) body: z.infer<typeof reauthVerifySchema>,
    @Req() request: Request,
  ) {
    return this.auth.verifyAdminReauth(auth, body.code, body.captcha, actorOf(auth, request).ip!);
  }

  // ───────────── Plans ─────────────

  @Get('plans')
  listPlans(): Promise<AdminPlan[]> {
    return this.plans.list();
  }

  @Get('plans/:code/revisions')
  revisions(@Param('code') code: string): Promise<PlanRevisionView[]> {
    return this.plans.revisions(code);
  }

  @Put('plans/:code')
  @Sensitive()
  @ApiZodBody(updatePlanSchema)
  updatePlan(
    @Auth() auth: AuthContext,
    @Param('code') code: string,
    @ZodBody(updatePlanSchema) body: z.infer<typeof updatePlanSchema>,
    @Req() request: Request,
  ): Promise<PlanRevisionView[]> {
    return this.plans.update(actorOf(auth, request), code, body.terms, body.reason);
  }

  // ───────────── Users, organizations, payments ─────────────

  @Get('users')
  users(@ZodQuery(adminSearchSchema) query: z.infer<typeof adminSearchSchema>) {
    return this.accounts.users(query.q, query.before);
  }

  @Get('users/:id')
  user(@Param('id') id: string): Promise<AdminUserDetail> {
    return this.accounts.user(idOf(id));
  }

  @Post('users/:id/credits')
  @Sensitive()
  @ApiZodBody(addCreditSchema)
  addCredit(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(addCreditSchema) body: z.infer<typeof addCreditSchema>,
    @Req() request: Request,
  ): Promise<AdminUserDetail> {
    return this.accounts.addCredit(actorOf(auth, request), idOf(id), body.amountXof, body.note);
  }

  @Post('users/:id/refunds')
  @Sensitive()
  @ApiZodBody(refundSchema)
  refund(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(refundSchema) body: z.infer<typeof refundSchema>,
    @Req() request: Request,
  ): Promise<AdminUserDetail> {
    return this.accounts.refund(actorOf(auth, request), idOf(id), body);
  }

  @Get('organizations')
  organizations(@ZodQuery(adminSearchSchema) query: z.infer<typeof adminSearchSchema>) {
    return this.accounts.organizations(query.q, query.before);
  }

  @Get('organizations/:id')
  organization(@Param('id') id: string): Promise<AdminOrgDetail> {
    return this.accounts.organization(idOf(id));
  }

  @Get('payments')
  payments(@ZodQuery(adminPaymentsQuerySchema) query: z.infer<typeof adminPaymentsQuerySchema>) {
    return this.accounts.payments(query);
  }

  // ───────────── BUSINESS pilot trials ─────────────

  @Post('business-trials')
  @Sensitive()
  @ApiZodBody(startBusinessTrialSchema)
  startTrial(
    @Auth() auth: AuthContext,
    @ZodBody(startBusinessTrialSchema) body: z.infer<typeof startBusinessTrialSchema>,
    @Req() request: Request,
  ): Promise<AdminOrgDetail> {
    return this.accounts.startBusinessTrial(actorOf(auth, request), body);
  }

  @Post('organizations/:id/trial-extension')
  @Sensitive()
  @ApiZodBody(extendBusinessTrialSchema)
  extendTrial(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(extendBusinessTrialSchema) body: z.infer<typeof extendBusinessTrialSchema>,
    @Req() request: Request,
  ): Promise<AdminOrgDetail> {
    return this.accounts.extendBusinessTrial(
      actorOf(auth, request),
      idOf(id),
      body.days,
      body.reason,
    );
  }

  // ───────────── Promo codes ─────────────

  @Get('promo-codes')
  promos(): Promise<AdminPromo[]> {
    return this.catalog.promos();
  }

  @Post('promo-codes')
  @Sensitive()
  @ApiZodBody(createPromoSchema)
  createPromo(
    @Auth() auth: AuthContext,
    @ZodBody(createPromoSchema) body: z.infer<typeof createPromoSchema>,
    @Req() request: Request,
  ): Promise<AdminPromo[]> {
    return this.catalog.createPromo(actorOf(auth, request), body);
  }

  @Patch('promo-codes/:id')
  @Sensitive()
  @ApiZodBody(updatePromoSchema)
  updatePromo(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(updatePromoSchema) body: z.infer<typeof updatePromoSchema>,
    @Req() request: Request,
  ): Promise<AdminPromo[]> {
    return this.catalog.updatePromo(actorOf(auth, request), idOf(id), body);
  }

  // ───────────── Public templates ─────────────

  @Get('templates')
  templates(): Promise<AdminTemplate[]> {
    return this.catalog.templates();
  }

  /** Adds a public template from a ZIP sent as the raw body (`application/zip`). */
  @Post('templates')
  @Sensitive()
  @ApiConsumes('application/zip')
  async addTemplate(
    @Auth() auth: AuthContext,
    @ZodQuery(adminTemplateQuerySchema) query: z.infer<typeof adminTemplateQuerySchema>,
    @Req() request: Request,
  ): Promise<AdminTemplate[]> {
    await this.projects.limitImports(auth.user.id);
    return this.projects.withImportSlot(async () => {
      const archive = await readRawBody(
        request,
        'application/zip',
        this.config.env.ZIP_MAX_ARCHIVE_BYTES,
        'archive_too_large',
      );
      return this.catalog.addTemplate(actorOf(auth, request), query, archive);
    });
  }

  @Patch('templates/:id')
  @Sensitive()
  @ApiZodBody(updateAdminTemplateSchema)
  updateTemplate(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(updateAdminTemplateSchema) body: z.infer<typeof updateAdminTemplateSchema>,
    @Req() request: Request,
  ): Promise<AdminTemplate[]> {
    return this.catalog.updateTemplate(actorOf(auth, request), idOf(id), body);
  }

  @Delete('templates/:id')
  @Sensitive()
  removeTemplate(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<AdminTemplate[]> {
    return this.catalog.removeTemplate(actorOf(auth, request), idOf(id));
  }

  // ───────────── Statistics ─────────────

  @Get('stats')
  stats(): Promise<AdminStats> {
    return this.statistics.stats();
  }
}
