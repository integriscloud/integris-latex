import type { Locale } from '@integris/shared';
import type { Mail } from '../mail/mail-sender.js';

// Messages of an invitation into an organization, sent by the API outside next-intl.

/**
 * SMS of an invitation: the link only. No organization or person name (typed by users), so the
 * SMS sender cannot carry someone else's text.
 */
export const orgInvitationSms: Record<Locale, (link: string, days: number) => string> = {
  fr: (link, days) =>
    `Integris LaTeX : vous êtes invité(e) à rejoindre une organisation. Pour voir l'invitation (valable ${days} jours) : ${link}`,
  en: (link, days) =>
    `Integris LaTeX: you are invited to join an organization. To see the invitation (valid for ${days} days): ${link}`,
};

export interface OrgInvitationMailInput {
  to: string;
  inviterName: string;
  organizationName: string;
  link: string;
  days: number;
}

/** Names typed by users go in a header line: never a line break (header injection). */
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, ' ');

export const orgInvitationMail: Record<Locale, (input: OrgInvitationMailInput) => Mail> = {
  fr: ({ to, inviterName, organizationName, link, days }) => ({
    to,
    subject: `Integris LaTeX : invitation à rejoindre « ${oneLine(organizationName)} »`,
    text: [
      'Bonjour,',
      '',
      `${oneLine(inviterName)} vous invite à rejoindre « ${oneLine(organizationName)} » sur Integris LaTeX.`,
      `Vous y occuperez un siège : ses quotas s'ajoutent à votre compte, vos projets restent les vôtres.`,
      '',
      `Pour voir l'invitation et l'accepter (lien valable ${days} jours) :`,
      link,
      '',
      'Si vous ne connaissez pas cette organisation, ignorez ce message.',
      '',
      "— L'équipe Integris LaTeX",
    ].join('\n'),
  }),
  en: ({ to, inviterName, organizationName, link, days }) => ({
    to,
    subject: `Integris LaTeX: invitation to join "${oneLine(organizationName)}"`,
    text: [
      'Hello,',
      '',
      `${oneLine(inviterName)} invites you to join "${oneLine(organizationName)}" on Integris LaTeX.`,
      'You will hold a seat: its quotas add to your account, your projects stay yours.',
      '',
      `To see the invitation and accept it (link valid for ${days} days):`,
      link,
      '',
      'If you do not know this organization, ignore this message.',
      '',
      '— The Integris LaTeX team',
    ].join('\n'),
  }),
};
