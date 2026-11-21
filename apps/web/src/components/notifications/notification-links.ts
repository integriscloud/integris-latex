import type { NotificationItem } from '@integris/shared';

/** Page a notification leads to (in the current space), or null when there is none. */
export function notificationHref(item: NotificationItem): string | null {
  const text = (key: string) => {
    const value = item.payload[key];
    return typeof value === 'string' && value ? encodeURIComponent(value) : null;
  };
  switch (item.type) {
    case 'SUBMISSION_RECEIVED':
    case 'SUBMISSION_FEEDBACK':
    case 'SUBMISSION_VALIDATED':
    case 'SUBMISSION_DUE_SOON': {
      const project = text('projectId');
      return project ? `/app/projects/${project}` : null;
    }
    case 'SUPERVISION_REQUESTED':
      return '/app/students';
    case 'SUPERVISION_ACCEPTED':
    case 'SUPERVISION_DECLINED':
      return '/app/supervisors';
    case 'QUOTA_ALERT':
      return '/app/usage';
    case 'ORG_JOIN_REQUESTED':
    case 'ORG_TEACHER_REQUESTED':
      return '/app/org/members';
    case 'ORG_JOIN_APPROVED':
    case 'ORG_JOIN_REJECTED':
      return '/spaces';
    case 'PRINT_READY': {
      const request = text('printRequestId');
      return request ? `/app/print/${request}` : '/app/print';
    }
    case 'PRINT_PRINTED':
    case 'PRINT_HANDED_OVER':
      return '/app/exams';
    case 'PAYMENT_CREDITED':
    case 'RENEWAL_REMINDER':
    case 'GRACE_STARTED':
    case 'GRACE_ENDING':
    case 'TRIAL_REMINDER':
    case 'TRIAL_ENDED':
    case 'BUSINESS_TRIAL_STARTED':
    case 'BUSINESS_TRIAL_REMINDER':
    case 'BUSINESS_TRIAL_EXTENDED':
    case 'CREDIT_ADDED':
    case 'CREDIT_REFUNDED':
      return '/app/billing';
    default:
      return null;
  }
}
