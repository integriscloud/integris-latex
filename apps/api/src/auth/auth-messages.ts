import type { Locale } from '@integris/shared';
import type { Mail } from '../mail/mail-sender.js';

// E-mail templates. They are sent by the API, outside next-intl, so both languages live here.
export const emailVerificationMail: Record<Locale, (to: string, link: string) => Mail> = {
  fr: (to, link) => ({
    to,
    subject: 'Integris LaTeX : confirmez votre adresse e-mail',
    text: `Bonjour,\n\nPour confirmer cette adresse e-mail sur Integris LaTeX, ouvrez ce lien (valable 24 heures) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
  }),
  en: (to, link) => ({
    to,
    subject: 'Integris LaTeX: confirm your e-mail address',
    text: `Hello,\n\nTo confirm this e-mail address on Integris LaTeX, open this link (valid for 24 hours):\n${link}\n\nIf you did not ask for this, ignore this message.`,
  }),
};

export const passwordResetMail: Record<Locale, (to: string, link: string) => Mail> = {
  fr: (to, link) => ({
    to,
    subject: 'Integris LaTeX : nouveau mot de passe',
    text: `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 30 minutes) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe ne change pas.`,
  }),
  en: (to, link) => ({
    to,
    subject: 'Integris LaTeX: new password',
    text: `Hello,\n\nTo choose a new password, open this link (valid for 30 minutes):\n${link}\n\nIf you did not ask for this, ignore this message: your password does not change.`,
  }),
};
