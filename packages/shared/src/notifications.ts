import { z } from 'zod';

// Notifications (docs/spec.md, "Notifications" and "Back-office et notifications (décisions
// étape 14)"): every notice is written in the application first; SMS and e-mail copies leave
// through the notification queue.

/** Categories a user can receive by e-mail (off by default). */
export const NOTIFICATION_CATEGORIES = [
  'SUPERVISION',
  'BILLING',
  'QUOTA',
  'ORGANIZATION',
  'PRINT',
] as const;
export type NotificationCategoryValue = (typeof NOTIFICATION_CATEGORIES)[number];

/** Every notification type and its e-mail category. */
export const NOTIFICATION_TYPES = {
  // Submissions and supervision
  SUBMISSION_RECEIVED: 'SUPERVISION',
  SUBMISSION_FEEDBACK: 'SUPERVISION',
  SUBMISSION_VALIDATED: 'SUPERVISION',
  SUBMISSION_DUE_SOON: 'SUPERVISION',
  SUPERVISION_ASSIGNED: 'SUPERVISION',
  SUPERVISION_ENDED: 'SUPERVISION',
  SUPERVISION_REASSIGNED: 'SUPERVISION',
  SUPERVISION_REQUESTED: 'SUPERVISION',
  SUPERVISION_ACCEPTED: 'SUPERVISION',
  SUPERVISION_DECLINED: 'SUPERVISION',
  // Billing
  PAYMENT_CREDITED: 'BILLING',
  RENEWAL_REMINDER: 'BILLING',
  GRACE_STARTED: 'BILLING',
  GRACE_ENDING: 'BILLING',
  TRIAL_REMINDER: 'BILLING',
  TRIAL_ENDED: 'BILLING',
  BUSINESS_TRIAL_STARTED: 'BILLING',
  BUSINESS_TRIAL_REMINDER: 'BILLING',
  BUSINESS_TRIAL_EXTENDED: 'BILLING',
  CREDIT_ADDED: 'BILLING',
  CREDIT_REFUNDED: 'BILLING',
  // Quotas
  QUOTA_ALERT: 'QUOTA',
  // Organizations
  ORG_JOIN_REQUESTED: 'ORGANIZATION',
  ORG_TEACHER_REQUESTED: 'ORGANIZATION',
  ORG_JOIN_APPROVED: 'ORGANIZATION',
  ORG_JOIN_REJECTED: 'ORGANIZATION',
  // Exam papers and secretariat
  PRINT_READY: 'PRINT',
  PRINT_PRINTED: 'PRINT',
  PRINT_HANDED_OVER: 'PRINT',
} as const satisfies Record<string, NotificationCategoryValue>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

/** Types also sent by SMS (not optional): the list of docs/spec.md. */
export const SMS_NOTIFICATION_TYPES = [
  'SUBMISSION_RECEIVED',
  'SUBMISSION_FEEDBACK',
  'SUBMISSION_VALIDATED',
  'SUBMISSION_DUE_SOON',
  'RENEWAL_REMINDER',
  'GRACE_STARTED',
  'GRACE_ENDING',
  'TRIAL_REMINDER',
  'BUSINESS_TRIAL_REMINDER',
  'PRINT_PRINTED',
  'PRINT_HANDED_OVER',
] as const satisfies readonly NotificationType[];

/** Days before a submission deadline when the author and the supervisors are reminded. */
export const DUE_REMINDER_DAYS = 2;
/** Reminders before the end of a BUSINESS pilot trial (owner and admins). */
export const BUSINESS_TRIAL_REMINDER_DAYS = [7, 3] as const;

export const NOTIFICATIONS_PAGE_SIZE = 30;

const id = z.string().min(1).max(64);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** One notification of the centre. The text is built by the web app from its type and payload. */
export const notificationItemSchema = z.object({
  id,
  type: z.string(),
  payload: z.record(z.string(), scalar),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationsPageSchema = z.object({
  items: z.array(notificationItemSchema),
  unread: z.number().int().nonnegative(),
  /** Pass as `before` to read older notifications; null at the end. */
  nextCursor: z.string().nullable(),
});
export type NotificationsPage = z.infer<typeof notificationsPageSchema>;

export const unreadCountSchema = z.object({ unread: z.number().int().nonnegative() });

export const readNotificationsSchema = z.object({ ids: z.array(id).min(1).max(100) });

/** E-mail copies chosen by the user; e-mail needs a verified address. */
export const notificationPreferencesSchema = z.object({
  email: z.array(z.enum(NOTIFICATION_CATEGORIES)),
  emailAvailable: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = z.object({
  email: z.array(z.enum(NOTIFICATION_CATEGORIES)).max(NOTIFICATION_CATEGORIES.length),
});
