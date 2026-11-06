import { describe, expect, it } from 'vitest';

import { addDays, resolveDate, resolveRange, splitRange, today } from '../src/garmin/dates.js';

const NOW = new Date('2026-11-06T23:30:00Z'); // 00:30 on 2026-11-07 in Stockholm

describe('dates', () => {
  it('resolves today in the configured time zone', () => {
    expect(today('Europe/Stockholm', NOW)).toBe('2026-11-07');
    expect(today('UTC', NOW)).toBe('2026-11-06');
  });

  it('resolves keywords and offsets', () => {
    expect(resolveDate(undefined, 'Europe/Stockholm', NOW)).toBe('2026-11-07');
    expect(resolveDate('yesterday', 'Europe/Stockholm', NOW)).toBe('2026-11-06');
    expect(resolveDate('-7d', 'Europe/Stockholm', NOW)).toBe('2026-10-31');
    expect(resolveDate('2024-02-29', 'UTC', NOW)).toBe('2024-02-29');
    expect(() => resolveDate('2023-02-29', 'UTC', NOW)).toThrow();
    expect(() => resolveDate('next week', 'UTC', NOW)).toThrow();
  });

  it('resolves ranges from days', () => {
    expect(resolveRange({ days: 7 }, 'UTC', 7, NOW)).toEqual({ start: '2026-10-31', end: '2026-11-06' });
    expect(resolveRange({ start_date: '2026-11-01', end_date: '2026-11-03' }, 'UTC', 7, NOW)).toEqual({
      start: '2026-11-01',
      end: '2026-11-03',
    });
    expect(() => resolveRange({ start_date: '2026-11-05', end_date: '2026-11-01' }, 'UTC')).toThrow();
  });

  it('splits ranges into bounded chunks', () => {
    expect(splitRange('2026-01-01', '2026-01-01', 28)).toEqual([{ start: '2026-01-01', end: '2026-01-01' }]);
    const chunks = splitRange('2026-01-01', '2026-03-01', 28);
    expect(chunks).toEqual([
      { start: '2026-01-01', end: '2026-01-28' },
      { start: '2026-01-29', end: '2026-02-25' },
      { start: '2026-02-26', end: '2026-03-01' },
    ]);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
