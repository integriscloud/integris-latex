import {
  approveJoinSchema,
  assignSupervisorSchema,
  chooseGroupSchema,
  CSV_IMPORT_MAX_BYTES,
  groupSchemaIn,
  type ImportReport,
  joinOrganizationSchema,
  type JoinResult,
  type MembersPage,
  type MyJoinRequest,
  type MySupervisors,
  type OrganizationView,
  type OrgGroup,
  orgInviteSchema,
  type OrgInvitationView,
  orgSettingsSchema,
  reassignSupervisionSchema,
  requestSupervisorSchema,
  SHARE_TOKEN,
  type SupervisionAdmin,
  type SupervisionDashboard,
  supervisionProjectSchema,
  updateMemberSchema,
  updateSupervisionSchema,
} from '@integris/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { readRawBody } from '../common/raw-body.js';
import { ipOf } from '../common/request-ip.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { OrgImportService } from './org-import.service.js';
import { OrgInvitationsService } from './org-invitations.service.js';
import { OrganizationsService } from './organizations.service.js';
import { SupervisionService } from './supervision.service.js';

const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
const tokenSchema = z.object({ token: z.string().regex(SHARE_TOKEN) });

const actorOf = (auth: AuthContext, request: Request) => ({
  userId: auth.user.id,
  ip: ipOf(request),
});

/**
 * Organizations (TEAM, BUSINESS): overview for every member; members, invitations, CSV import,
 * join requests, admins and groups for the owner and the admins (checked in the services).
 */
@ApiTags('organizations')
@Controller('organizations')
@UseGuards(AuthGuard)
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly imports: OrgImportService,
    private readonly supervision: SupervisionService,
  ) {}

  /** A teacher asks to join a BUSINESS with its code (waits for an admin). */
  @Post('join')
  @HttpCode(200)
  @ApiZodBody(joinOrganizationSchema)
  join(
    @Auth() auth: AuthContext,
    @ZodBody(joinOrganizationSchema) body: z.output<typeof joinOrganizationSchema>,
    @Req() request: Request,
  ): Promise<JoinResult> {
    return this.organizations.join(auth.user, body.code, ipOf(request));
  }

  @Get('join-requests')
  joinRequests(@Auth() auth: AuthContext): Promise<MyJoinRequest[]> {
    return this.organizations.myJoinRequests(auth.user.id);
  }

  @Get(':id')
  view(@Auth() auth: AuthContext, @Param('id') id: string): Promise<OrganizationView> {
    return this.organizations.view(auth.user.id, id);
  }

  @Post(':id/join-code')
  @HttpCode(200)
  regenerateJoinCode(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<OrganizationView> {
    return this.organizations.regenerateJoinCode(actorOf(auth, request), id);
  }

  /** BUSINESS settings (owner, admins): members choosing their own group. */
  @Patch(':id/settings')
  @ApiZodBody(orgSettingsSchema)
  updateSettings(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(orgSettingsSchema) body: z.output<typeof orgSettingsSchema>,
    @Req() request: Request,
  ): Promise<OrganizationView> {
    return this.organizations.updateSettings(actorOf(auth, request), id, body);
  }

  /** A member chooses their own group, when the organization allows it. */
  @Patch(':id/my-group')
  @ApiZodBody(chooseGroupSchema)
  chooseGroup(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(chooseGroupSchema) body: z.output<typeof chooseGroupSchema>,
    @Req() request: Request,
  ): Promise<OrganizationView> {
    return this.organizations.chooseGroup(actorOf(auth, request), id, body.groupId);
  }

  @Post(':id/leave')
  @HttpCode(204)
  async leave(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.organizations.leave(actorOf(auth, request), id);
  }

  // ───────────── Members ─────────────

  @Get(':id/members')
  members(@Auth() auth: AuthContext, @Param('id') id: string): Promise<MembersPage> {
    return this.organizations.members(auth.user.id, id);
  }

  /** Invites by phone or e-mail: reserves a seat (402 `no_free_seat` when none is free). */
  @Post(':id/invitations')
  @ApiZodBody(orgInviteSchema)
  invite(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(orgInviteSchema) body: z.output<typeof orgInviteSchema>,
    @Req() request: Request,
  ): Promise<MembersPage> {
    return this.organizations.invite(auth.user, id, body, ipOf(request));
  }

  @Delete(':id/invitations/:invitationId')
  revokeInvitation(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Req() request: Request,
  ): Promise<MembersPage> {
    return this.organizations.revokeInvitation(actorOf(auth, request), id, invitationId);
  }

  @Patch(':id/members/:userId')
  @ApiZodBody(updateMemberSchema)
  updateMember(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @ZodBody(updateMemberSchema) body: z.output<typeof updateMemberSchema>,
    @Req() request: Request,
  ): Promise<MembersPage> {
    return this.organizations.updateMember(actorOf(auth, request), id, userId, body);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() request: Request,
  ): Promise<MembersPage> {
    return this.organizations.removeMember(actorOf(auth, request), id, userId);
  }

  @Post(':id/join-requests/:userId/approve')
  @HttpCode(200)
  @ApiZodBody(approveJoinSchema)
  approve(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @ZodBody(approveJoinSchema) body: z.output<typeof approveJoinSchema>,
    @Req() request: Request,
  ): Promise<MembersPage> {
    return this.organizations.approve(actorOf(auth, request), id, userId, body.groupId);
  }

  @Post(':id/join-requests/:userId/reject')
  @HttpCode(200)
  reject(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() request: Request,
  ): Promise<MembersPage> {
    return this.organizations.reject(actorOf(auth, request), id, userId);
  }

  /**
   * CSV import: the raw file as `application/octet-stream` (like every upload: a type no
   * cross-site form can send), 1 MB at most, its name in `?name=`.
   */
  @Post(':id/imports')
  async startImport(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Query('name') name: string | undefined,
    @Req() request: Request,
  ): Promise<ImportReport> {
    const context = await this.imports.check(auth.user, id);
    const bytes = await readRawBody(
      request,
      'application/octet-stream',
      CSV_IMPORT_MAX_BYTES,
      'csv_too_large',
    );
    return this.imports.start(auth.user, context, name ?? '', bytes, ipOf(request));
  }

  @Get(':id/imports/:importId')
  importReport(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('importId') importId: string,
  ): Promise<ImportReport> {
    return this.imports.report(auth.user.id, id, importId);
  }

  // ───────────── Groups ─────────────

  @Post(':id/groups')
  @ApiZodBody(groupSchemaIn)
  createGroup(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(groupSchemaIn) body: z.output<typeof groupSchemaIn>,
    @Req() request: Request,
  ): Promise<OrgGroup[]> {
    return this.organizations.createGroup(actorOf(auth, request), id, body);
  }

  @Patch(':id/groups/:groupId')
  @ApiZodBody(groupSchemaIn)
  updateGroup(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @ZodBody(groupSchemaIn) body: z.output<typeof groupSchemaIn>,
    @Req() request: Request,
  ): Promise<OrgGroup[]> {
    return this.organizations.updateGroup(actorOf(auth, request), id, groupId, body);
  }

  @Delete(':id/groups/:groupId')
  deleteGroup(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Req() request: Request,
  ): Promise<OrgGroup[]> {
    return this.organizations.deleteGroup(actorOf(auth, request), id, groupId);
  }

  // ───────────── Supervision ─────────────

  @Get(':id/supervisions')
  supervisions(@Auth() auth: AuthContext, @Param('id') id: string): Promise<SupervisionAdmin> {
    return this.supervision.adminView(auth.user.id, id);
  }

  @Post(':id/supervisions')
  @ApiZodBody(assignSupervisorSchema)
  assign(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(assignSupervisorSchema) body: z.output<typeof assignSupervisorSchema>,
    @Req() request: Request,
  ): Promise<SupervisionAdmin> {
    return this.supervision.assign(actorOf(auth, request), id, body);
  }

  @Patch(':id/supervisions/:supervisionId')
  @ApiZodBody(updateSupervisionSchema)
  setEndDate(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('supervisionId') supervisionId: string,
    @ZodBody(updateSupervisionSchema) body: z.output<typeof updateSupervisionSchema>,
    @Req() request: Request,
  ): Promise<SupervisionAdmin> {
    return this.supervision.setEndDate(actorOf(auth, request), id, supervisionId, body.endsAt);
  }

  @Post(':id/supervisions/:supervisionId/reassign')
  @HttpCode(200)
  @ApiZodBody(reassignSupervisionSchema)
  reassign(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('supervisionId') supervisionId: string,
    @ZodBody(reassignSupervisionSchema) body: z.output<typeof reassignSupervisionSchema>,
    @Req() request: Request,
  ): Promise<SupervisionAdmin> {
    return this.supervision.reassign(actorOf(auth, request), id, supervisionId, body.supervisorId);
  }

  @Post(':id/supervisions/:supervisionId/end')
  @HttpCode(200)
  end(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('supervisionId') supervisionId: string,
    @Req() request: Request,
  ): Promise<SupervisionAdmin> {
    return this.supervision.end(actorOf(auth, request), id, supervisionId);
  }

  /** A student's supervisors and the teachers they can ask. */
  @Get(':id/my-supervisors')
  mySupervisors(@Auth() auth: AuthContext, @Param('id') id: string): Promise<MySupervisors> {
    return this.supervision.mine(auth.user.id, id);
  }

  @Post(':id/supervision-requests')
  @ApiZodBody(requestSupervisorSchema)
  requestSupervisor(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(requestSupervisorSchema) body: z.output<typeof requestSupervisorSchema>,
    @Req() request: Request,
  ): Promise<MySupervisors> {
    return this.supervision.request(actorOf(auth, request), id, body.supervisorId);
  }

  /** A teacher's supervision dashboard (BUSINESS). */
  @Get(':id/supervision-dashboard')
  dashboard(@Auth() auth: AuthContext, @Param('id') id: string): Promise<SupervisionDashboard> {
    return this.supervision.dashboard(auth.user.id, id);
  }
}

/** Actions on one supervision link by its student or its supervisor. */
@ApiTags('organizations')
@Controller('supervisions')
@UseGuards(AuthGuard)
export class SupervisionsController {
  constructor(private readonly supervision: SupervisionService) {}

  @Post(':id/accept')
  @HttpCode(204)
  async accept(@Auth() auth: AuthContext, @Param('id') id: string, @Req() request: Request) {
    await this.supervision.answer(actorOf(auth, request), id, true);
  }

  @Post(':id/decline')
  @HttpCode(204)
  async decline(@Auth() auth: AuthContext, @Param('id') id: string, @Req() request: Request) {
    await this.supervision.answer(actorOf(auth, request), id, false);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  async cancel(@Auth() auth: AuthContext, @Param('id') id: string, @Req() request: Request) {
    await this.supervision.cancel(actorOf(auth, request), id);
  }

  @Post(':id/projects')
  @HttpCode(204)
  @ApiZodBody(supervisionProjectSchema)
  async openProject(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(supervisionProjectSchema) body: z.output<typeof supervisionProjectSchema>,
    @Req() request: Request,
  ): Promise<void> {
    await this.supervision.openProject(actorOf(auth, request), id, body.projectId);
  }

  @Delete(':id/projects/:projectId')
  @HttpCode(204)
  async closeProject(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.supervision.closeProject(actorOf(auth, request), id, projectId);
  }
}

/** Invitation page of an organization; the token travels in request bodies only. */
@ApiTags('organizations')
@Controller('org-invitations')
export class OrgInvitationsController {
  constructor(private readonly invitations: OrgInvitationsService) {}

  @Post('view')
  @HttpCode(200)
  @ApiZodBody(tokenSchema)
  view(
    @ZodBody(tokenSchema) body: z.output<typeof tokenSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrgInvitationView> {
    response.set(NO_INDEX);
    return this.invitations.view(body.token, ipOf(request));
  }

  @Post('accept')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiZodBody(tokenSchema)
  accept(
    @Auth() auth: AuthContext,
    @ZodBody(tokenSchema) body: z.output<typeof tokenSchema>,
    @Req() request: Request,
  ): Promise<{ organizationId: string }> {
    return this.invitations.accept(auth.user, body.token, ipOf(request));
  }

  @Post('decline')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiZodBody(tokenSchema)
  async decline(
    @Auth() auth: AuthContext,
    @ZodBody(tokenSchema) body: z.output<typeof tokenSchema>,
    @Req() request: Request,
  ): Promise<void> {
    await this.invitations.decline(auth.user, body.token, ipOf(request));
  }
}
