import { describe, expect, it } from 'vitest';
import type { AiSettings } from '../../types/ai';
import { agoText, canResume, pausedSummary, spanText } from './pausedUi';

const settings = (extra: Partial<AiSettings>): AiSettings =>
  ({
    pausedAll: true,
    pausedAt: '2026-10-31T10:41:00',
    pausedReason: null,
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

  it('leaves the decision to resume to the server', () => {
    expect(canResume(settings({}))).toBe(true);
    expect(canResume(null)).toBe(true);
  });

  it('says when the pause began and the reason it was given', () => {
    expect(pausedSummary(settings({}))).toContain('Paused at');
    expect(pausedSummary(settings({}))).toContain('Nothing new starts until it is resumed.');
    expect(pausedSummary(settings({ pausedReason: 'Over budget' }))).toContain('“Over budget”');
  });
});
