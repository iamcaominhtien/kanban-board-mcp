import { describe, expect, it } from 'vitest';
import { buildTimelineLink, parseTimelineLink } from './timelineLink';

const base = { origin: 'http://127.0.0.1:5173', pathname: '/' } as Location;

describe('timeline link', () => {
  it('restores the range, the scope and the switches', () => {
    const url = buildTimelineLink(
      'p1',
      { range: '24h', scope: 'KAN-207', detailed: true, real: true, hidden: ['handoffs', 'touches'] },
      base,
    );
    const link = parseTimelineLink(new URL(url).search);
    expect(link).toEqual({
      range: '24h',
      scope: 'KAN-207',
      detailed: true,
      real: true,
      hidden: ['handoffs', 'touches'],
    });
    expect(new URL(url).searchParams.get('proj')).toBe('p1');
  });

  it('keeps a custom window and ignores what it does not understand', () => {
    const since = '2026-10-30T00:00:00.000Z';
    const url = buildTimelineLink('p1', { since, until: '2026-10-31T00:00:00.000Z' }, base);
    expect(parseTimelineLink(new URL(url).search)?.since).toBe(since);
    expect(parseTimelineLink('?aiteam=timeline&tl=r:century;x:1;since:soon')).toEqual({});
    expect(parseTimelineLink('?ticket=KAN-1')).toBeNull();
  });
});
