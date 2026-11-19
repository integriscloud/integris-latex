import type { Locale, ShareableRole } from '@integris/shared';
import type { Mail } from '../mail/mail-sender.js';

// Messages of an invitation, sent by the API outside next-intl: both languages live here.

const ROLE_NAMES: Record<Locale, Record<ShareableRole, string>> = {
  fr: { EDITOR: 'Éditeur', SUPERVISOR: 'Encadrant', REVIEWER: 'Relecteur', VIEWER: 'Lecteur' },
  en: { EDITOR: 'Editor', SUPERVISOR: 'Supervisor', REVIEWER: 'Reviewer', VIEWER: 'Reader' },
};

/**
 * SMS of an invitation: the link only. Nothing typed by a user goes in it (no project name, no
 * name, never the message), so the SMS sender cannot be used to send someone else's text.
 */
export const invitationSms: Record<Locale, (link: string, days: number) => string> = {
  fr: (link, days) =>
    `Integris LaTeX : vous êtes invité(e) à collaborer sur un projet. Pour voir l'invitation (valable ${days} jours) : ${link}`,
  en: (link, days) =>
    `Integris LaTeX: you are invited to collaborate on a project. To see the invitation (valid for ${days} days): ${link}`,
};

export interface InvitationMailInput {
  to: string;
  inviterName: string;
  projectName: string;
  role: ShareableRole;
  /** The optional message of the owner (280 characters at most). */
  message: string | undefined;
  link: string;
  days: number;
}

/** Names typed by users go in a header line: never a line break (header injection). */
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, ' ');

export const invitationMail: Record<Locale, (input: InvitationMailInput) => Mail> = {
  fr: ({ to, inviterName, projectName, role, message, link, days }) => ({
    to,
    subject: `Integris LaTeX : ${oneLine(inviterName)} vous invite sur « ${oneLine(projectName)} »`,
    text: [
      'Bonjour,',
      '',
      `${inviterName} vous invite à collaborer sur le projet « ${projectName} » dans Integris LaTeX, avec le rôle ${ROLE_NAMES.fr[role]}.`,
      ...(message ? ['', `Son message : « ${message} »`] : []),
      '',
      `Pour accepter ou refuser, ouvrez ce lien (valable ${days} jours) :`,
      link,
      '',
      "Si vous ne connaissez pas cette personne, ignorez ce message : rien ne change tant que vous n'acceptez pas.",
    ].join('\n'),
  }),
  en: ({ to, inviterName, projectName, role, message, link, days }) => ({
    to,
    subject: `Integris LaTeX: ${oneLine(inviterName)} invites you to "${oneLine(projectName)}"`,
    text: [
      'Hello,',
      '',
      `${inviterName} invites you to collaborate on the project "${projectName}" in Integris LaTeX, as ${ROLE_NAMES.en[role]}.`,
      ...(message ? ['', `Their message: "${message}"`] : []),
      '',
      `To accept or decline, open this link (valid for ${days} days):`,
      link,
      '',
      'If you do not know this person, ignore this message: nothing changes unless you accept.',
    ].join('\n'),
  }),
};
