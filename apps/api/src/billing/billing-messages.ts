import type { Locale } from '@integris/shared';
import type { Mail } from '../mail/mail-sender.js';

// E-mails, SMS and receipt labels of the payments. They are sent by the API, outside next-intl,
// so both languages live here. Dates are shown in UTC (the time zone of Burkina Faso).

/** "20 000 FCFA" with a non-breaking space (the narrow one is missing from some fonts). */
export function formatXof(locale: Locale, amount: number): string {
  const number = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    maximumFractionDigits: 0,
  })
    .format(amount)
    .replace(/[\u202f\u00a0]/g, '\u00a0');
  return `${number}\u00a0FCFA`;
}

/** dd/mm/yyyy (fr) or dd/mm/yyyy too in English: the format used across West Africa. */
export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

export const receiptNumber = (number: number) => String(number).padStart(6, '0');

export const receiptMail: Record<
  Locale,
  (to: string, number: number, amount: string, credited: string | null) => Omit<Mail, 'attachments'>
> = {
  fr: (to, number, amount, credited) => ({
    to,
    subject: `Integris LaTeX : reçu n° ${receiptNumber(number)}`,
    text: `Bonjour,\n\nMerci pour votre paiement de ${amount} sur Integris LaTeX. Vous trouverez votre reçu n° ${receiptNumber(number)} en pièce jointe.${credited ? `\n\n${credited} ont été ajoutés à votre solde de crédit, déduit automatiquement de votre prochain paiement.` : ''}\n\nIntegris Cloud`,
  }),
  en: (to, number, amount, credited) => ({
    to,
    subject: `Integris LaTeX: receipt no. ${receiptNumber(number)}`,
    text: `Hello,\n\nThank you for your payment of ${amount} on Integris LaTeX. Your receipt no. ${receiptNumber(number)} is attached.${credited ? `\n\n${credited} were added to your credit balance, deducted automatically from your next payment.` : ''}\n\nIntegris Cloud`,
  }),
};

/** A duplicate payment was credited: amount, receipt, and how to get a refund. */
export const creditedMail: Record<
  Locale,
  (to: string, amount: string, number: number, supportEmail: string | null) => Mail
> = {
  fr: (to, amount, number, supportEmail) => ({
    to,
    subject: 'Integris LaTeX : paiement en double porté à votre crédit',
    text: `Bonjour,\n\nNous avons reçu un paiement en double (reçu n° ${receiptNumber(number)}). Il n'a rien changé à votre offre : ${amount} ont été ajoutés à votre solde de crédit, déduit automatiquement de votre prochain paiement. Votre solde est visible dans « Ma consommation » et sur la page de paiement.\n\n${supportEmail ? `Vous préférez un remboursement ? Écrivez à ${supportEmail} en citant le reçu n° ${receiptNumber(number)}.` : `Vous préférez un remboursement ? Répondez à cet e-mail en citant le reçu n° ${receiptNumber(number)}.`}\n\nIntegris Cloud`,
  }),
  en: (to, amount, number, supportEmail) => ({
    to,
    subject: 'Integris LaTeX: duplicate payment added to your credit',
    text: `Hello,\n\nWe received a duplicate payment (receipt no. ${receiptNumber(number)}). It did not change your plan: ${amount} were added to your credit balance, deducted automatically from your next payment. Your balance is shown in "My usage" and on the payment page.\n\n${supportEmail ? `Would you rather have a refund? Write to ${supportEmail} quoting receipt no. ${receiptNumber(number)}.` : `Would you rather have a refund? Reply to this e-mail quoting receipt no. ${receiptNumber(number)}.`}\n\nIntegris Cloud`,
  }),
};

/** SMS texts: short, no accents needed by the gateway but kept for readability. */
export const billingSms = {
  renewal: {
    fr: (plan: string, date: string, link: string) =>
      `Integris LaTeX : votre offre ${plan} se termine le ${date}. Renouvelez ici : ${link}`,
    en: (plan: string, date: string, link: string) =>
      `Integris LaTeX: your ${plan} plan ends on ${date}. Renew here: ${link}`,
  },
  graceStarted: {
    fr: (plan: string, date: string, link: string) =>
      `Integris LaTeX : votre offre ${plan} est échue. Elle reste active jusqu'au ${date}, puis repasse en Gratuit. Renouvelez : ${link}`,
    en: (plan: string, date: string, link: string) =>
      `Integris LaTeX: your ${plan} plan has expired. It stays active until ${date}, then goes back to Free. Renew: ${link}`,
  },
  graceEnding: {
    fr: (plan: string, date: string) =>
      `Integris LaTeX : l'offre ${plan} dont vous bénéficiez repasse en Gratuit le ${date} si elle n'est pas renouvelée. Rien n'est supprimé.`,
    en: (plan: string, date: string) =>
      `Integris LaTeX: the ${plan} plan you use goes back to Free on ${date} unless it is renewed. Nothing is deleted.`,
  },
  trialEnding: {
    fr: (date: string, link: string) =>
      `Integris LaTeX : votre essai Standard se termine le ${date}, puis vous repassez en Gratuit. Continuer en Standard : ${link}`,
    en: (date: string, link: string) =>
      `Integris LaTeX: your Standard trial ends on ${date}, then you go back to Free. Keep Standard: ${link}`,
  },
} as const;

/** Labels of the receipt PDF. */
export const receiptLabels = {
  fr: {
    title: 'Reçu',
    number: 'Reçu n°',
    date: 'Date',
    billedTo: 'Payé par',
    ifu: 'IFU',
    rccm: 'RCCM',
    toComplete: 'à compléter',
    description: 'Désignation',
    amount: 'Montant',
    seats: (count: number) => (count > 1 ? `${count} sièges` : '1 siège'),
    period: { MONTHLY: 'mensuel', YEARLY: 'annuel' },
    from: (start: string, end: string) => `du ${start} au ${end}`,
    purposes: {
      NEW_SUBSCRIPTION: 'Abonnement',
      RENEWAL: 'Renouvellement',
      UPGRADE: 'Passage au plan supérieur',
      EXTRA_SEATS: 'Sièges supplémentaires',
    },
    base: 'Prix',
    promo: (code: string, percent: number) => `Code promo ${code} (−${percent} %)`,
    proration: 'Crédit des jours restants de l’offre précédente',
    creditUsed: 'Solde de crédit utilisé',
    minimumTopUp: (minimum: string, credit: string) =>
      `Montant minimum d’une transaction LigdiCash (${minimum}) : ${credit} ajoutés à votre solde de crédit`,
    prorationSurplus: (credit: string) =>
      `Crédit des jours restants supérieur au prix : ${credit} ajoutés à votre solde de crédit`,
    paid: 'Montant payé (TTC)',
    method: 'Moyen de paiement',
    methodLigdiCash: 'LigdiCash',
    methodCredit: 'Solde de crédit et remises, sans transaction LigdiCash',
    transaction: 'Transaction',
    credited: (amount: string) =>
      `Paiement en double : il n’a pas modifié l’offre. ${amount} ont été ajoutés à votre solde de crédit.`,
    refund: (email: string | null, number: string) =>
      email
        ? `Remboursement sur demande à ${email}, en citant le reçu n° ${number}.`
        : `Remboursement sur demande en répondant à l’e-mail du reçu n° ${number}.`,
    ttc: 'Prix TTC, en francs CFA (XOF).',
  },
  en: {
    title: 'Receipt',
    number: 'Receipt no.',
    date: 'Date',
    billedTo: 'Paid by',
    ifu: 'IFU',
    rccm: 'RCCM',
    toComplete: 'to be completed',
    description: 'Item',
    amount: 'Amount',
    seats: (count: number) => (count > 1 ? `${count} seats` : '1 seat'),
    period: { MONTHLY: 'monthly', YEARLY: 'yearly' },
    from: (start: string, end: string) => `from ${start} to ${end}`,
    purposes: {
      NEW_SUBSCRIPTION: 'Subscription',
      RENEWAL: 'Renewal',
      UPGRADE: 'Upgrade to a higher plan',
      EXTRA_SEATS: 'Extra seats',
    },
    base: 'Price',
    promo: (code: string, percent: number) => `Promo code ${code} (−${percent}%)`,
    proration: 'Credit for the days left on the previous plan',
    creditUsed: 'Credit balance used',
    minimumTopUp: (minimum: string, credit: string) =>
      `Minimum amount of a LigdiCash transaction (${minimum}): ${credit} added to your credit balance`,
    prorationSurplus: (credit: string) =>
      `Credit for the days left above the price: ${credit} added to your credit balance`,
    paid: 'Amount paid (incl. tax)',
    method: 'Payment method',
    methodLigdiCash: 'LigdiCash',
    methodCredit: 'Credit balance and discounts, no LigdiCash transaction',
    transaction: 'Transaction',
    credited: (amount: string) =>
      `Duplicate payment: it did not change the plan. ${amount} were added to your credit balance.`,
    refund: (email: string | null, number: string) =>
      email
        ? `Refund on request at ${email}, quoting receipt no. ${number}.`
        : `Refund on request by replying to the e-mail of receipt no. ${number}.`,
    ttc: 'Prices include tax, in CFA francs (XOF).',
  },
} as const;
