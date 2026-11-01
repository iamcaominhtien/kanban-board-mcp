import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatcher } from './invalidationBatcher';

describe('invalidation batcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refetches a burst once', () => {
    const flush = vi.fn();
    const b = createBatcher(flush);
    b.push(null);
    b.push(null);
    vi.advanceTimersByTime(149);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(null);
  });

  it('spaces refetches while announcements keep coming, and stays quick when it is quiet', () => {
    const times: number[] = [];
    const b = createBatcher(() => times.push(Date.now()));
    // one announcement a second for 30 seconds, like a run streaming its steps
    for (let s = 0; s < 30; s++) {
      b.push(null);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(3000);
    // quiet it would be 30 refetches; busy it is about one in 2.5 s
    expect(times.length).toBeLessThanOrEqual(14);
    expect(times.length).toBeGreaterThanOrEqual(8);
    // the first ones come quickly, then never closer than 2.5 s
    for (let i = 3; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(2500);
    // after a quiet spell an announcement is refetched at once again
    times.length = 0;
    vi.advanceTimersByTime(20000);
    b.push(null);
    vi.advanceTimersByTime(150);
    expect(times).toHaveLength(1);
  });

  it('unions the topics of a burst, and anything wins', () => {
    const flush = vi.fn();
    const b = createBatcher(flush);
    b.push(['ai']);
    b.push(['docs']);
    vi.advanceTimersByTime(150);
    expect([...(flush.mock.calls[0][0] as Set<string>)].sort()).toEqual(['ai', 'docs']);
    b.push(['ai']);
    b.push(null);
    vi.advanceTimersByTime(3000);
    expect(flush).toHaveBeenLastCalledWith(null);
  });

  it('drops what it gathered when cancelled', () => {
    const flush = vi.fn();
    const b = createBatcher(flush);
    b.push(['ai']);
    b.cancel();
    vi.advanceTimersByTime(5000);
    expect(flush).not.toHaveBeenCalled();
  });
});
