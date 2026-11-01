import { describe, expect, it } from 'vitest';
import { NODE_H, NODE_Y, arcReach, teamMapHeight } from './teamMapLayout';

describe('Team map height', () => {
  it('stays as it was for a small team', () => {
    expect(teamMapHeight(1, 2)).toEqual({ top: 40 + 22 + 20, height: 82 + NODE_Y + NODE_H + 30 + 44 + 20 });
    expect(teamMapHeight(0, 0).height).toBe(60 + NODE_Y + NODE_H + 50);
  });

  it('reaches past the outermost arc below and its label, however many there are', () => {
    for (const n of [1, 6, 7, 8, 12, 20]) {
      const { top, height } = teamMapHeight(3, n);
      const deepestLabel = top + NODE_Y + NODE_H + arcReach(n - 1) + 14 + 4;
      expect(height).toBeGreaterThanOrEqual(deepestLabel + 8);
    }
  });

  it('leaves room above the highest arc and its label', () => {
    for (const n of [1, 6, 12, 20]) {
      const { top } = teamMapHeight(n, 0);
      expect(top + NODE_Y - arcReach(n - 1) - 2 - 12).toBeGreaterThanOrEqual(8);
    }
  });
});
