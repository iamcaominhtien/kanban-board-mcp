import { describe, expect, it } from 'vitest';
import { ascending, toggleNumber } from './numberSets';

describe('ascending', () => {
  it('sorts as numbers, not as text', () => {
    expect(ascending([100, 50, 80])).toEqual([50, 80, 100]);
    expect(ascending(new Set([10, 2, 1]))).toEqual([1, 2, 10]);
  });
});

describe('toggleNumber', () => {
  it('adds a missing number in order', () => {
    expect(toggleNumber([50, 100], 80)).toEqual([50, 80, 100]);
  });
  it('removes a number that is there', () => {
    expect(toggleNumber([50, 80, 100], 80)).toEqual([50, 100]);
  });
  it('leaves the given list as it is', () => {
    const days = [1, 3];
    toggleNumber(days, 2);
    expect(days).toEqual([1, 3]);
  });
});
