import { describe, expect, it } from 'vitest';
import type { AiSettings } from '../../types/ai';
import { agoText, canResume, pausedSummary, spanText } from './pausedUi';

const settings = (extra: Partial<AiSettings>): AiSettings =>
  ({
    pausedAll: true,
    pausedBy: 'An Nguyen',
    pausedAt: '2026-10-31T10:41:00',
    pausedCancelled: 2,
    pausedHeld: 3,
    ...extra,
  }) as AiSettings;

describe('paused state helpers', () => {
  it('writes how long ago', () => {
    const now = new Date('2026-10-31T12:33:00').getTime();
    expect(agoText('2026-10-31T10:41:00', now)).toBe('1 h 52 min ago');
    expect(agoText('2026-10-31T12:10:00', now)).toBe('23 min ago');
    expect(agoText('2026-10-31T12:33:00', now)).toBe('just now');
    expect(spanText(66 * 60000)).toBe('1 h 06');
  });

  it('lets only owners and admins resume, and leaves an old server to decide', () => {
    expect(canResume(settings({ myRole: 'owner' }))).toBe(true);
    expect(canResume(settings({ myRole: 'admin' }))).toBe(true);
    expect(canResume(settings({ myRole: 'member' }))).toBe(false);
    expect(canResume(settings({ myRole: 'viewer' }))).toBe(false);
    expect(canResume(settings({}))).toBe(true);
  });

  it('says who paused, what it did and who resumes, with no zero counts', () => {
    const text = pausedSummary(settings({}));
    expect(text).toContain('Paused by An Nguyen');
    expect(text).toContain('2 runs cancelled, 3 queued runs held');
    expect(text).toContain('until an owner or admin resumes');
    expect(pausedSummary(settings({ pausedCancelled: 0, pausedHeld: 1 }))).toContain('1 queued run held.');
    expect(pausedSummary(settings({ pausedCancelled: 0, pausedHeld: 0 }))).not.toMatch(/0 (queued )?runs?/);
  });
});
