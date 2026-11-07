/** Calendar-date helpers. All dates are plain `YYYY-MM-DD` strings in the user's local calendar. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE = /^([+-]?\d+)d$/;
const DAY_MS = 86_400_000;

export class DateInputError extends Error {}

/** Today's date in the given IANA time zone. */
export function today(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function toEpochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Inclusive number of days between two dates. */
export function daysInclusive(start: string, end: string): number {
  return toEpochDay(end) - toEpochDay(start) + 1;
}

/**
 * Resolve a user-supplied date. Accepts `YYYY-MM-DD`, `today`, `yesterday`
 * or a relative offset such as `-7d`. Undefined resolves to today.
 */
export function resolveDate(input: string | undefined, timeZone: string, now: Date = new Date()): string {
  const base = today(timeZone, now);
  if (input === undefined || input.trim() === '') return base;
  const value = input.trim().toLowerCase();
  if (value === 'today') return base;
  if (value === 'yesterday') return addDays(base, -1);
  const rel = RELATIVE.exec(value);
  if (rel) return addDays(base, Number(rel[1]));
  if (ISO_DATE.test(value)) {
    const roundTrip = fromEpochDay(toEpochDay(value));
    if (roundTrip !== value) throw new DateInputError(`Invalid calendar date: ${input}`);
    return value;
  }
  throw new DateInputError(`Invalid date "${input}". Use YYYY-MM-DD, "today", "yesterday" or an offset like "-7d".`);
}

export interface DateRangeInput {
  start_date?: string;
  end_date?: string;
  days?: number;
}

/**
 * Resolve a range. `end_date` defaults to today. `start_date` defaults to
 * `end_date - (days - 1)`, and `days` defaults to `defaultDays`.
 */
export function resolveRange(
  input: DateRangeInput,
  timeZone: string,
  defaultDays = 7,
  now: Date = new Date(),
): { start: string; end: string } {
  const end = resolveDate(input.end_date, timeZone, now);
  const start =
    input.start_date !== undefined && input.start_date.trim() !== ''
      ? resolveDate(input.start_date, timeZone, now)
      : addDays(end, -((input.days ?? defaultDays) - 1));
  if (start > end) throw new DateInputError(`start_date ${start} is after end_date ${end}`);
  return { start, end };
}

/** Split an inclusive range into consecutive chunks of at most `maxDays` days. */
export function splitRange(start: string, end: string, maxDays: number): Array<{ start: string; end: string }> {
  if (maxDays < 1) throw new Error('maxDays must be >= 1');
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, maxDays - 1);
    const boundedEnd = chunkEnd < end ? chunkEnd : end;
    chunks.push({ start: cursor, end: boundedEnd });
    cursor = addDays(boundedEnd, 1);
  }
  return chunks;
}
