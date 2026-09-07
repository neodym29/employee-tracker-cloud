import {describe, expect, it} from 'vitest';
import {DEFAULT_TIMEZONE, formatInTimezone, hourInTimezone, normalizeTimezone, TIMEZONE_OPTIONS, timezoneFromOffsetInput, timezoneOffsetInput, todayInTimezone} from '../apps/web/timezone.js';

describe('web timezone preferences', () => {
  it('defaults to Pakistan Standard Time while allowing UTC offsets', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Karachi');
    expect(normalizeTimezone(null)).toBe('Asia/Karachi');
    expect(normalizeTimezone('UTC')).toBe('UTC');
    expect(normalizeTimezone('UTC+01:00')).toBe('UTC+01:00');
    expect(normalizeTimezone('UTC-03:00')).toBe('UTC-03:00');
    expect(TIMEZONE_OPTIONS).toEqual(expect.arrayContaining([
      expect.objectContaining({value: 'UTC+01:00'}),
      expect.objectContaining({value: 'UTC-03:00'}),
      expect.objectContaining({value: 'UTC+05:30'}),
      expect.objectContaining({value: 'UTC+05:45'}),
      expect.objectContaining({value: 'UTC+09:30'}),
    ]));
  });

  it('uses the selected timezone for dates and displayed timestamps', () => {
    const instant = new Date('2026-08-23T21:00:00.000Z');
    expect(todayInTimezone('Asia/Karachi', instant)).toBe('2026-08-24');
    expect(todayInTimezone('UTC', instant)).toBe('2026-08-23');
    expect(todayInTimezone('UTC+01:00', instant)).toBe('2026-08-23');
    expect(todayInTimezone('UTC-03:00', new Date('2026-08-24T02:00:00.000Z'))).toBe('2026-08-23');
    expect(formatInTimezone(instant, 'UTC')).toContain('2026');
  });

  it('parses compact UTC offsets used by dashboard controls', () => {
    expect(timezoneFromOffsetInput('+0')).toBe('UTC');
    expect(timezoneFromOffsetInput('-3')).toBe('UTC-03:00');
    expect(timezoneFromOffsetInput('+5:30')).toBe('UTC+05:30');
    expect(timezoneFromOffsetInput('+14:30')).toBeUndefined();
    expect(timezoneOffsetInput('UTC+05:30')).toBe('+5:30');
    expect(hourInTimezone('UTC+05:30', new Date('2026-08-27T04:15:00Z'))).toBe(9);
  });
});
