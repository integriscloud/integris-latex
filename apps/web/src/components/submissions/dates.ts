/**
 * Deadlines typed as text in the order of the language (jj/mm/aaaa in French) and read in the
 * time zone the dates are shown in (next-intl), so that what is typed is what is shown.
 */

export type DatePart = 'day' | 'month' | 'year';

/** Day, month and year in the order of the language, and the separator between them. */
export function dateOrder(locale: string): { order: DatePart[]; separator: string } {
  const parts = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(Date.UTC(2000, 11, 31, 12)));
  const order = parts.flatMap((part) =>
    part.type === 'day' || part.type === 'month' || part.type === 'year' ? [part.type] : [],
  );
  const separator = parts.find((part) => part.type === 'literal')?.value.trim() || '/';
  return { order: order.length === 3 ? order : ['day', 'month', 'year'], separator };
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Date and time of an instant on the clock of a time zone. */
function wallTime(instant: number, timeZone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour') % 24,
    minute: value('minute'),
  };
}

const asUtc = (time: WallTime) =>
  Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);

/** The instant shown as `time` in the time zone (the first one, around a change of hour). */
function instantOf(time: WallTime, timeZone: string): number {
  const guess = asUtc(time);
  const offset = asUtc(wallTime(guess, timeZone)) - guess;
  let instant = guess - offset;
  const again = asUtc(wallTime(instant, timeZone)) - instant;
  if (again !== offset) instant = guess - again;
  return instant;
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

export interface DueInput {
  date: string;
  time: string;
}

/** Text of the date and time fields for a deadline (empty when there is none). */
export function dueInputOf(iso: string | null, locale: string, timeZone: string): DueInput {
  if (!iso) return { date: '', time: '' };
  const time = wallTime(Date.parse(iso), timeZone);
  const { order, separator } = dateOrder(locale);
  const text = { day: pad(time.day), month: pad(time.month), year: pad(time.year, 4) };
  return {
    date: order.map((part) => text[part]).join(separator),
    time: `${pad(time.hour)}:${pad(time.minute)}`,
  };
}

/** Time of a deadline typed with a date only: the end of that day. */
export const DEFAULT_DUE_TIME = '23:59';

/**
 * Deadline typed in the fields: null when both are empty, 'invalid' when the date or time does
 * not exist (31/02, 25:00…), the ISO instant otherwise.
 */
export function dueFromInput(
  input: DueInput,
  locale: string,
  timeZone: string,
): string | null | 'invalid' {
  const dateText = input.date.trim();
  const timeText = input.time.trim();
  if (!dateText && !timeText) return null;
  const numbers = dateText.split(/\D+/).filter(Boolean);
  if (numbers.length !== 3) return 'invalid';
  const { order } = dateOrder(locale);
  const parts = Object.fromEntries(order.map((part, index) => [part, Number(numbers[index])])) as {
    [part in DatePart]: number;
  };
  const year = order.indexOf('year');
  if (numbers[year]!.length !== 4) return 'invalid';
  const clock = /^(\d{1,2})[:h.](\d{2})$/i.exec(timeText || DEFAULT_DUE_TIME);
  if (!clock) return 'invalid';
  const time: WallTime = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Number(clock[1]),
    minute: Number(clock[2]),
  };
  if (time.month < 1 || time.month > 12 || time.day < 1 || time.hour > 23 || time.minute > 59) {
    return 'invalid';
  }
  // 31/02 does not exist (Date would move it to March).
  const check = new Date(Date.UTC(time.year, time.month - 1, time.day));
  if (check.getUTCMonth() !== time.month - 1 || check.getUTCDate() !== time.day) return 'invalid';
  return new Date(instantOf(time, timeZone)).toISOString();
}
