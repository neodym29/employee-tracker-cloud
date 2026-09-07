import {describe, expect, it} from 'vitest';
import {activityBucketMinutes, dateKeyInTimezone, dateRangeUtc, normalizeTimezone} from '../apps/server/src/timezone.js';

describe('workspace timezone boundaries', () => {
  it('defaults to Pakistan Standard Time and supports UTC explicitly', () => {
    expect(normalizeTimezone(undefined)).toBe('Asia/Karachi');
    expect(normalizeTimezone('Asia/Karachi')).toBe('Asia/Karachi');
    expect(normalizeTimezone('UTC')).toBe('UTC');
    expect(normalizeTimezone('UTC+01:00')).toBe('UTC+01:00');
    expect(normalizeTimezone('UTC-03:00')).toBe('UTC-03:00');
    expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
  });

  it('uses minute buckets only for accepted fixed offsets that need them', () => {
    expect(activityBucketMinutes('UTC+05:20')).toBe(1);
    expect(activityBucketMinutes('UTC-03:07')).toBe(1);
    expect(activityBucketMinutes('UTC+05:30')).toBe(15);
    expect(activityBucketMinutes('Asia/Karachi')).toBe(15);
  });

  it('converts Pakistan calendar days to exact UTC query bounds', () => {
    expect(dateRangeUtc('2026-08-24', '2026-08-24', 'Asia/Karachi')).toEqual({
      from: '2026-08-23T19:00:00.000Z',
      to: '2026-08-24T18:59:59.999Z',
    });
    expect(dateRangeUtc('2026-08-24', '2026-08-24', 'UTC')).toEqual({
      from: '2026-08-24T00:00:00.000Z',
      to: '2026-08-24T23:59:59.999Z',
    });
    expect(dateKeyInTimezone('2026-08-23T21:00:00.000Z', 'Asia/Karachi')).toBe('2026-08-24');
    expect(dateRangeUtc('2026-08-24', '2026-08-24', 'UTC-03:00')).toEqual({
      from: '2026-08-24T03:00:00.000Z',
      to: '2026-08-25T02:59:59.999Z',
    });
    expect(dateRangeUtc('2026-08-24', '2026-08-24', 'America/New_York')).toEqual({
      from: '2026-08-24T04:00:00.000Z',
      to: '2026-08-25T03:59:59.999Z',
    });
    expect(dateKeyInTimezone('2026-08-24T02:00:00.000Z', 'UTC-03:00')).toBe('2026-08-23');
    expect(dateRangeUtc('2020-03-08', '2020-03-08', 'America/Havana')).toEqual({
      from: '2020-03-08T05:00:00.000Z',
      to: '2020-03-09T03:59:59.999Z',
    });
  });
});
