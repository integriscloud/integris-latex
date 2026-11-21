/** Today in the browser's time zone, as the value of a date input (YYYY-MM-DD). */
export function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** End of the chosen day in the browser's time zone, as an ISO date-time for the API. */
export function endOfDayIso(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!, 23, 59, 59).toISOString();
}
