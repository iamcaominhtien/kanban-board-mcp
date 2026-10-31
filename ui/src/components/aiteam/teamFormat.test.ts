import { describe, expect, it } from 'vitest';
import { deltaOf, fmtAgo, fmtDuration, fmtShort, fmtTokens, usageText } from './teamFormat';

const usage = { runs: 3, ok: 3, failed: 0 };

describe('fmtDuration / fmtAgo', () => {
  it('reads minutes, hours and days', () => {
    expect(fmtDuration(30)).toBe('under a minute');
    expect(fmtDuration(41 * 60)).toBe('41 min');
    expect(fmtDuration(2 * 3600 + 5 * 60)).toBe('2 h 05');
    expect(fmtDuration(3 * 86400)).toBe('3 d');
    expect(fmtAgo(12 * 60)).toBe('12 min ago');
    expect(fmtAgo(null)).toBe('');
  });
});

describe('usageText', () => {
  it('shows dollars for a priced member', () => {
    expect(usageText({ ...usage, metered: true, costUsd: 0.41 })).toBe('$0.41');
  });
  it('shows tokens, never $0, for a runner that reports no cost', () => {
    expect(usageText({ ...usage, metered: false, tokens: 41_000, tokensKind: 'input_per_call' })).toBe(
      '41k tokens (input per call)',
    );
    expect(usageText({ ...usage, metered: false, tokens: 14_000 }, { verbose: true })).toBe(
      '14k tokens (input per call), no cost reported',
    );
  });
  it('shows new and cached apart where the runner reports both', () => {
    expect(
      usageText({ ...usage, metered: false, tokens: 250_000, tokensCached: 225_000, tokensKind: 'new_and_cached' }),
    ).toBe('250k tokens: 25k new, 225k cached');
    expect(fmtTokens(1_250_000)).toBe('1.3M');
  });
});

describe('Health numbers', () => {
  it('writes a duration the short way', () => {
    expect(fmtShort(3 * 3600 + 40 * 60)).toBe('3 h 40');
    expect(fmtShort(52 * 60)).toBe('52 min');
    expect(fmtShort(null)).toBe('–');
  });
  it('says which way a change is good', () => {
    expect(deltaOf('pts', 3, 'up')).toEqual({ text: '+3 pts vs previous', better: true });
    expect(deltaOf('pts', 2, 'down')).toEqual({ text: '+2 pts vs previous', better: false });
    expect(deltaOf('seconds', -35 * 60, 'down')).toEqual({ text: '−35 min vs previous', better: true });
    expect(deltaOf('usd', -3.2, 'down')).toEqual({ text: '−$3.20 vs previous', better: true });
    expect(deltaOf('pts', null, 'up').better).toBeNull();
    expect(deltaOf('pts', 0.2, 'up').text).toBe('no change vs previous');
  });
});
