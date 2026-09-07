import {describe, expect, it} from 'vitest';
import {activitySummary} from '../apps/web/activity-summary.js';

describe('recent activity summaries', () => {
  it('distinguishes pushes by remote destination and confirmation', () => {
    expect(activitySummary({type: 'push', data: {remote: 'origin', ref: 'refs/heads/main', confirmation: 'confirmed'}}))
      .toBe('origin → main · confirmed');
    expect(activitySummary({type: 'push', data: {remote: 'origin', ref: 'refs/heads/codex/timeline-context', confirmation: 'confirmed'}}))
      .toBe('origin → codex/timeline-context · confirmed');
  });

  it('adds useful bounded context to other Git activity', () => {
    expect(activitySummary({type: 'commit', data: {message: 'Clarify activity', branch: 'main'}})).toBe('Clarify activity · main');
    expect(activitySummary({type: 'stage', data: {filesChanged: 2, branch: 'main'}})).toBe('2 files · main');
    expect(activitySummary({type: 'merge', data: {branch: 'main', commitSha: '1234567890abcdef'}})).toBe('main · 12345678');
  });
});
