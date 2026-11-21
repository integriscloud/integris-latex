import {
  NOTIFICATION_TYPE_NAMES,
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationPreferences,
  type NotificationsPage,
  readNotificationsSchema,
  updateNotificationPreferencesSchema,
} from '@integris/shared';
import { Controller, Get, HttpCode, HttpStatus, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { ApiError } from '../common/api-error.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { PrismaService } from '../prisma/prisma.service.js';

const beforeSchema = z.iso.datetime().optional();

/** Notification centre of the signed-in user, and their e-mail preferences. */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  /** In-app notifications, newest first; `before` (a `nextCursor`) reads older ones. */
  @Get()
  async list(
    @Auth() { user }: AuthContext,
    @Query('before') before?: string,
  ): Promise<NotificationsPage> {
    const parsed = beforeSchema.safeParse(before || undefined);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
    const cursor = parsed.data;
    const db = this.prisma.client;
    const where = {
      userId: user.id,
      channel: 'IN_APP' as const,
      // Types of an older API version (none today) are never shown untranslated.
      type: { in: NOTIFICATION_TYPE_NAMES },
    };
    const [rows, unread] = await Promise.all([
      db.notification.findMany({
        where: { ...where, ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: NOTIFICATIONS_PAGE_SIZE + 1,
      }),
      db.notification.count({ where: { ...where, readAt: null } }),
    ]);
    const items = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
    return {
      items: items.map((row) => ({
        id: row.id,
        type: row.type,
        payload: (row.payload ?? {}) as NotificationsPage['items'][number]['payload'],
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      })),
      unread,
      nextCursor:
        rows.length > NOTIFICATIONS_PAGE_SIZE ? items.at(-1)!.createdAt.toISOString() : null,
    };
  }

  /** Unread count, for the bell of the top bar. */
  @Get('unread')
  async unread(@Auth() { user }: AuthContext): Promise<{ unread: number }> {
    const unread = await this.prisma.client.notification.count({
      where: {
        userId: user.id,
        channel: 'IN_APP',
        readAt: null,
        type: { in: NOTIFICATION_TYPE_NAMES },
      },
    });
    return { unread };
  }

  @Post('read')
  @HttpCode(204)
  @ApiZodBody(readNotificationsSchema)
  async read(
    @Auth() { user }: AuthContext,
    @ZodBody(readNotificationsSchema) body: z.infer<typeof readNotificationsSchema>,
  ): Promise<void> {
    await this.prisma.client.notification.updateMany({
      where: { id: { in: body.ids }, userId: user.id, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@Auth() { user }: AuthContext): Promise<void> {
    await this.prisma.client.notification.updateMany({
      where: { userId: user.id, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
  }

  @Get('preferences')
  preferences(@Auth() { user }: AuthContext): NotificationPreferences {
    return {
      email: user.emailNotifications,
      emailAvailable: Boolean(user.email && user.emailVerifiedAt),
    };
  }

  @Put('preferences')
  @ApiZodBody(updateNotificationPreferencesSchema)
  async update(
    @Auth() { user }: AuthContext,
    @ZodBody(updateNotificationPreferencesSchema)
    body: z.infer<typeof updateNotificationPreferencesSchema>,
  ): Promise<NotificationPreferences> {
    const updated = await this.prisma.client.user.update({
      where: { id: user.id },
      data: { emailNotifications: [...new Set(body.email)] },
    });
    return {
      email: updated.emailNotifications,
      emailAvailable: Boolean(updated.email && updated.emailVerifiedAt),
    };
  }
}
