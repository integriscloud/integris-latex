const UNITS = {
  fr: ['octets', 'Ko', 'Mo', 'Go'],
  en: ['bytes', 'KB', 'MB', 'GB'],
} as const;

/**
 * Readable size in binary units (1 Mo = 1 048 576 octets, docs/spec.md), e.g. "12,5 Mo".
 */
export function formatBytes(bytes: number, locale: string): string {
  const units = locale === 'fr' ? UNITS.fr : UNITS.en;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  return `${number}\u00a0${units[unit]}`;
}

/**
 * Relative date ("il y a 2 h"). Under a minute, or in the future (clock of the device ahead of the
 * server's), it is `justNow` ("à l'instant"), never "dans 6 secondes".
 */
export function relativeOrNow(
  format: { relativeTime: (date: Date, now: Date) => string },
  date: Date,
  now: Date,
  justNow: string,
): string {
  return now.getTime() - date.getTime() < 60_000 ? justNow : format.relativeTime(date, now);
}

/** A duration split for display: "2 s", "1 min 30 s", "2 h 05 min" (keys in Usage.duration). */
export type DurationParts =
  | { unit: 'seconds'; seconds: number }
  | { unit: 'minutes'; minutes: number; seconds: number }
  | { unit: 'hours'; hours: number; minutes: string };

/** Whole seconds, never rounded up: what is shown is never more than what was used. */
export function durationParts(totalSeconds: number): DurationParts {
  const total = Math.max(0, Math.floor(totalSeconds));
  if (total < 60) return { unit: 'seconds', seconds: total };
  if (total < 3600)
    return { unit: 'minutes', minutes: Math.floor(total / 60), seconds: total % 60 };
  return {
    unit: 'hours',
    hours: Math.floor(total / 3600),
    minutes: String(Math.floor((total % 3600) / 60)).padStart(2, '0'),
  };
}
