import type { Locale, NotificationType } from '@integris/shared';
import { formatDate, formatXof } from '../billing/billing-messages.js';

// SMS and e-mail texts of the notifications, in both languages (sent by the API, outside
// next-intl). SMS are short and carry no confidential data (no project or subject title, no file
// name, no amount): a link to the notification centre is enough (docs/spec.md, step 14).

export type Payload = Record<string, string | number | boolean | null>;

const SMS: Partial<Record<NotificationType, Record<Locale, string>>> = {
  SUBMISSION_RECEIVED: {
    fr: 'Integris LaTeX : une soumission vous attend.',
    en: 'Integris LaTeX: a submission is waiting for you.',
  },
  SUBMISSION_FEEDBACK: {
    fr: 'Integris LaTeX : votre encadrant a envoyé ses retours.',
    en: 'Integris LaTeX: your supervisor sent feedback.',
  },
  SUBMISSION_VALIDATED: {
    fr: 'Integris LaTeX : votre chapitre a été validé.',
    en: 'Integris LaTeX: your chapter was validated.',
  },
  SUBMISSION_DUE_SOON: {
    fr: 'Integris LaTeX : une soumission arrive à échéance dans 2 jours.',
    en: 'Integris LaTeX: a submission is due in 2 days.',
  },
  BUSINESS_TRIAL_REMINDER: {
    fr: "Integris LaTeX : l'essai Business de votre établissement se termine bientôt.",
    en: "Integris LaTeX: your institution's Business trial ends soon.",
  },
  PRINT_PRINTED: {
    fr: 'Integris LaTeX : votre sujet a été imprimé par le secrétariat.',
    en: 'Integris LaTeX: your exam paper was printed by the secretariat.',
  },
  PRINT_HANDED_OVER: {
    fr: 'Integris LaTeX : votre sujet imprimé a été remis.',
    en: 'Integris LaTeX: your printed exam paper was handed over.',
  },
};

/** Default SMS of a type (billing reminders give their own text with a payment link). */
export function notificationSms(
  type: NotificationType,
  locale: Locale,
  link: string,
): string | null {
  const text = SMS[type]?.[locale];
  return text ? `${text} ${link}` : null;
}

const str = (value: Payload[string] | undefined) => (typeof value === 'string' ? value : '');
const titled = (payload: Payload, fallback: string) => str(payload.title) || fallback;

/** One sentence per type, for the e-mail copies. */
const SENTENCES: Record<Locale, (type: NotificationType, payload: Payload) => string> = {
  fr: (type, p) => {
    const date = typeof p.date === 'string' ? formatDate(new Date(p.date)) : '';
    switch (type) {
      case 'SUBMISSION_RECEIVED':
        return `Une soumission vous a été envoyée pour relecture : « ${titled(p, 'sans titre')} ».`;
      case 'SUBMISSION_FEEDBACK':
        return `Des retours ont été envoyés sur votre soumission « ${titled(p, 'sans titre')} ».`;
      case 'SUBMISSION_VALIDATED':
        return `Votre soumission « ${titled(p, 'sans titre')} » a été validée.`;
      case 'SUBMISSION_DUE_SOON':
        return `La soumission « ${titled(p, 'sans titre')} » arrive à échéance le ${typeof p.dueAt === 'string' ? formatDate(new Date(p.dueAt)) : ''}.`;
      case 'SUPERVISION_ASSIGNED':
        return 'Un lien d’encadrement a été créé par votre établissement.';
      case 'SUPERVISION_ENDED':
        return 'Un lien d’encadrement a pris fin.';
      case 'SUPERVISION_REASSIGNED':
        return 'Un lien d’encadrement a été réaffecté.';
      case 'SUPERVISION_REQUESTED':
        return 'Un étudiant vous demande d’être son encadrant.';
      case 'SUPERVISION_ACCEPTED':
        return 'Votre demande d’encadrement a été acceptée.';
      case 'SUPERVISION_DECLINED':
        return 'Votre demande d’encadrement a été refusée.';
      case 'PAYMENT_CREDITED':
        return `Un paiement en double a été porté à votre solde de crédit.`;
      case 'RENEWAL_REMINDER':
        return `Votre offre se termine le ${date}. Pensez à la renouveler.`;
      case 'GRACE_STARTED':
        return `Votre offre est échue. Elle reste active jusqu'au ${date}, puis repasse en Gratuit.`;
      case 'GRACE_ENDING':
        return `L'offre dont vous bénéficiez repasse en Gratuit le ${date} si elle n'est pas renouvelée. Rien n'est supprimé.`;
      case 'TRIAL_REMINDER':
        return `Votre essai Standard se termine le ${date}.`;
      case 'TRIAL_ENDED':
        return 'Votre essai Standard est terminé : vous êtes repassé en Gratuit.';
      case 'BUSINESS_TRIAL_STARTED':
        return `L'essai Business de « ${str(p.name)} » a commencé ; il se termine le ${date}.`;
      case 'BUSINESS_TRIAL_REMINDER':
        return `L'essai Business de « ${str(p.name)} » se termine le ${date}. Sans paiement, l'organisation repasse en Gratuit ; rien n'est supprimé.`;
      case 'BUSINESS_TRIAL_EXTENDED':
        return `L'essai Business de « ${str(p.name)} » est prolongé jusqu'au ${date}.`;
      case 'CREDIT_ADDED':
        return `${formatXof('fr', Number(p.amountXof ?? 0))} ont été ajoutés à votre solde de crédit.`;
      case 'CREDIT_REFUNDED':
        return `${formatXof('fr', Number(p.amountXof ?? 0))} de votre solde de crédit vous ont été remboursés.`;
      case 'QUOTA_ALERT':
        return p.level === 'full'
          ? 'Vous avez atteint une limite de votre offre.'
          : 'Vous avez utilisé 80 % d’une limite de votre offre.';
      case 'ORG_JOIN_REQUESTED':
        return `${str(p.name)} demande à rejoindre votre établissement.`;
      case 'ORG_TEACHER_REQUESTED':
        return `${str(p.name)} demande le profil d'enseignant.`;
      case 'ORG_JOIN_APPROVED':
        return `Votre demande auprès de « ${str(p.name)} » a été acceptée.`;
      case 'ORG_JOIN_REJECTED':
        return `Votre demande auprès de « ${str(p.name)} » a été refusée.`;
      case 'PRINT_READY':
        return 'Une demande d’impression est prête.';
      case 'PRINT_PRINTED':
        return `Votre sujet « ${titled(p, '')} » a été imprimé.`;
      case 'PRINT_HANDED_OVER':
        return `Votre sujet « ${titled(p, '')} » a été remis.`;
    }
  },
  en: (type, p) => {
    const date = typeof p.date === 'string' ? formatDate(new Date(p.date)) : '';
    switch (type) {
      case 'SUBMISSION_RECEIVED':
        return `A submission was sent to you for review: "${titled(p, 'untitled')}".`;
      case 'SUBMISSION_FEEDBACK':
        return `Feedback was sent on your submission "${titled(p, 'untitled')}".`;
      case 'SUBMISSION_VALIDATED':
        return `Your submission "${titled(p, 'untitled')}" was validated.`;
      case 'SUBMISSION_DUE_SOON':
        return `The submission "${titled(p, 'untitled')}" is due on ${typeof p.dueAt === 'string' ? formatDate(new Date(p.dueAt)) : ''}.`;
      case 'SUPERVISION_ASSIGNED':
        return 'Your institution created a supervision link.';
      case 'SUPERVISION_ENDED':
        return 'A supervision link ended.';
      case 'SUPERVISION_REASSIGNED':
        return 'A supervision link was reassigned.';
      case 'SUPERVISION_REQUESTED':
        return 'A student asks you to be their supervisor.';
      case 'SUPERVISION_ACCEPTED':
        return 'Your supervision request was accepted.';
      case 'SUPERVISION_DECLINED':
        return 'Your supervision request was declined.';
      case 'PAYMENT_CREDITED':
        return 'A duplicate payment was added to your credit balance.';
      case 'RENEWAL_REMINDER':
        return `Your plan ends on ${date}. Remember to renew it.`;
      case 'GRACE_STARTED':
        return `Your plan has expired. It stays active until ${date}, then goes back to Free.`;
      case 'GRACE_ENDING':
        return `The plan you use goes back to Free on ${date} unless it is renewed. Nothing is deleted.`;
      case 'TRIAL_REMINDER':
        return `Your Standard trial ends on ${date}.`;
      case 'TRIAL_ENDED':
        return 'Your Standard trial is over: you are back on Free.';
      case 'BUSINESS_TRIAL_STARTED':
        return `The Business trial of "${str(p.name)}" started; it ends on ${date}.`;
      case 'BUSINESS_TRIAL_REMINDER':
        return `The Business trial of "${str(p.name)}" ends on ${date}. Without a payment, the organization goes back to Free; nothing is deleted.`;
      case 'BUSINESS_TRIAL_EXTENDED':
        return `The Business trial of "${str(p.name)}" is extended until ${date}.`;
      case 'CREDIT_ADDED':
        return `${formatXof('en', Number(p.amountXof ?? 0))} were added to your credit balance.`;
      case 'CREDIT_REFUNDED':
        return `${formatXof('en', Number(p.amountXof ?? 0))} of your credit balance were refunded to you.`;
      case 'QUOTA_ALERT':
        return p.level === 'full'
          ? 'You reached a limit of your plan.'
          : 'You used 80% of a limit of your plan.';
      case 'ORG_JOIN_REQUESTED':
        return `${str(p.name)} asks to join your institution.`;
      case 'ORG_TEACHER_REQUESTED':
        return `${str(p.name)} asks for the teacher profile.`;
      case 'ORG_JOIN_APPROVED':
        return `Your request to "${str(p.name)}" was accepted.`;
      case 'ORG_JOIN_REJECTED':
        return `Your request to "${str(p.name)}" was declined.`;
      case 'PRINT_READY':
        return 'A print request is ready.';
      case 'PRINT_PRINTED':
        return `Your exam paper "${titled(p, '')}" was printed.`;
      case 'PRINT_HANDED_OVER':
        return `Your exam paper "${titled(p, '')}" was handed over.`;
    }
  },
};

/** E-mail copy of a notification: one sentence and the link to the notification centre. */
export function notificationMail(
  type: NotificationType,
  payload: Payload,
  locale: Locale,
  link: string,
): { subject: string; text: string } {
  const sentence = SENTENCES[locale](type, payload);
  return locale === 'fr'
    ? {
        subject: 'Integris LaTeX : nouvelle notification',
        text: `Bonjour,\n\n${sentence}\n\nVoir vos notifications : ${link}\n\nVous recevez cet e-mail parce que vous l'avez choisi dans « Mon compte ».\n\nIntegris Cloud`,
      }
    : {
        subject: 'Integris LaTeX: new notification',
        text: `Hello,\n\n${sentence}\n\nSee your notifications: ${link}\n\nYou receive this e-mail because you chose it in "My account".\n\nIntegris Cloud`,
      };
}
